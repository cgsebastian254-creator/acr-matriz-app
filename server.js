const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const storage = require('./storage');

const PORT = process.env.PORT || 3000;
const IS_CLOUD = !!process.env.RENDER;              // Render define esta variable automáticamente
const SYNC_TOKEN = process.env.SYNC_TOKEN || '';    // Clave secreta compartida con el agente de sincronización
const UPLOAD_KEY = process.env.UPLOAD_KEY || '';    // Clave de ingenieros para subir Excel desde la web
const SHAREPOINT_ACR_URL = process.env.SHAREPOINT_ACR_URL || 'https://kimberlyclark.sharepoint.com/sites/B636'; // Carpeta de ACRs en SharePoint
const BOOT_ID = Date.now().toString(36);            // Cambia en cada reinicio: el agente lo usa para restaurar datos

// Dominios a los que se permite enviar la copia (CC) del correo de alertas
const ALERT_DOMAINS = (process.env.ALERT_ALLOWED_DOMAINS || 'kcc.com,kimberly-clark.com')
    .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
const ALERT_TIMEOUT_MS = 10 * 60 * 1000;            // Tiempo máximo esperando que el PC corporativo envíe el correo
const AGENT_ONLINE_MS = 2 * 60 * 1000;              // Si el agente no se reporta en este tiempo, se considera desconectado

const ROOT_DIR = __dirname;
const DATA_DIR = path.join(ROOT_DIR, 'data');
const DATA_FILE = path.join(DATA_DIR, 'acrs.json');
const DAILY_DATA_FILE = path.join(DATA_DIR, 'daily_tasks.json');
const PUBLIC_DIR = path.join(ROOT_DIR, 'public');
const ALERT_SCRIPT = path.join(ROOT_DIR, 'scripts', 'Send-ACRAlerts.ps1');

// ---------------------------------------------------------------
// Preparar carpeta data/
// ---------------------------------------------------------------
function ensureDataFile(target, rootFallbackName) {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    if (fs.existsSync(target)) return;
    const fallback = path.join(ROOT_DIR, rootFallbackName);
    if (fs.existsSync(fallback)) {
        fs.copyFileSync(fallback, target);
    } else {
        fs.writeFileSync(target, '[]', 'utf8');
    }
}
ensureDataFile(DATA_FILE, 'acrs.json');
ensureDataFile(DAILY_DATA_FILE, 'daily_tasks.json');

function readJson(file) {
    try {
        const data = JSON.parse(fs.readFileSync(file, 'utf8') || '[]');
        return Array.isArray(data) ? data : [];
    } catch (e) {
        return [];
    }
}
function docName(file) {
    return file === DAILY_DATA_FILE ? 'daily_tasks' : 'acrs';
}
function writeJson(file, data) {
    fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
    storage.save(docName(file), data);      // copia permanente en la base de datos (si está configurada)
}

function ahoraTexto() {
    return new Date().toLocaleString('es-ES', { timeZone: 'America/Bogota' });
}

// ---------------------------------------------------------------
// Tiempo real (SSE)
// ---------------------------------------------------------------
const sseClients = new Set();
function broadcastEvent(payload) {
    const dataStr = `data: ${JSON.stringify(payload)}\n\n`;
    for (const client of sseClients) {
        try { client.write(dataStr); } catch (e) { sseClients.delete(client); }
    }
}
// Mantiene viva la conexión en celulares y proxies (algunos cortan conexiones inactivas)
setInterval(() => {
    for (const client of sseClients) {
        try { client.write(': ping\n\n'); } catch (e) { sseClients.delete(client); }
    }
}, 25000);

// ---------------------------------------------------------------
// Unión de datos
// ---------------------------------------------------------------
function sameAcr(a, b) {
    return (a.archivoOrigen && a.archivoOrigen === b.archivoOrigen) || (a.falla && a.falla === b.falla);
}
function trailingNumber(id) {
    const m = String(id || '').match(/(\d+)$/);
    return m ? parseInt(m[1], 10) : 0;
}
function withNumber(id, n, width) {
    const base = String(id || '').replace(/\d+$/, '');
    return `${base}${String(n).padStart(width, '0')}`;
}

// Une los ACRs nuevos (de Excel) con lo que ya existe en la web:
// conserva estados, observaciones e historial, y mantiene fijos los IDs
// para que agregar un Excel nuevo no cambie el ID de los demás.
function mergeAcrs(incoming, existing) {
    let maxAcrNum = existing.reduce((m, a) => Math.max(m, trailingNumber(a.id)), 0);
    const nuevos = [];

    for (const newAcr of incoming) {
        const oldAcr = existing.find(a => sameAcr(a, newAcr));
        if (!oldAcr) { nuevos.push(newAcr); continue; }

        newAcr.id = oldAcr.id;
        const oldTasks = oldAcr.tareas || [];
        let maxTaskNum = oldTasks.reduce((m, t) => Math.max(m, trailingNumber(t.idTarea)), 0);
        const sinPareja = [];

        for (const newT of newAcr.tareas || []) {
            const oldT = oldTasks.find(t => t.descripcion === newT.descripcion);
            if (oldT) {
                newT.idTarea = oldT.idTarea;
                newT.estado = oldT.estado;
                newT.observaciones = oldT.observaciones;
                if (oldT.fechaCierre) newT.fechaCierre = oldT.fechaCierre;
                if (oldT.historial) newT.historial = oldT.historial;
            } else {
                sinPareja.push(newT);
            }
        }
        for (const t of sinPareja) {
            t.idTarea = withNumber(t.idTarea || 'T-', ++maxTaskNum, 2);
        }
    }

    for (const a of incoming) maxAcrNum = Math.max(maxAcrNum, nuevos.includes(a) ? 0 : trailingNumber(a.id));
    for (const a of nuevos) a.id = withNumber(a.id || 'ACR-2026-', ++maxAcrNum, 3);

    return incoming;
}

// ---- Restauración desde el respaldo del agente (tras un reinicio de Render) ----
function lastTs(item) {
    let m = 0;
    for (const h of item.historial || []) {
        if (typeof h.ts === 'number' && h.ts > m) m = h.ts;
    }
    return m;
}
function unionHistorial(a = [], b = []) {
    const seen = new Set();
    const out = [];
    for (const h of [...a, ...b]) {
        const key = `${h.fecha}|${h.usuario}|${h.accion}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(h);
    }
    // Más recientes primero; las entradas antiguas sin marca de tiempo quedan al final
    return out.sort((x, y) => (y.ts || 0) - (x.ts || 0));
}
// Gana la versión con el cambio más reciente; el historial se une sin duplicados
function mergeItem(actual, respaldo, campos) {
    const tA = lastTs(actual);
    const tR = lastTs(respaldo);
    const ganaRespaldo = tR > tA ||
        (tR === tA && (respaldo.historial || []).length > (actual.historial || []).length);
    if (ganaRespaldo) {
        for (const c of campos) {
            if (respaldo[c] !== undefined) actual[c] = respaldo[c];
        }
    }
    actual.historial = unionHistorial(actual.historial, respaldo.historial);
}

function restoreFromBackup(backup) {
    const acrs = readJson(DATA_FILE);
    const tasks = readJson(DAILY_DATA_FILE);
    const antesAcrs = JSON.stringify(acrs);
    const antesTasks = JSON.stringify(tasks);

    // ACRs: solo se recuperan estados de ACRs que siguen existiendo (los Excel mandan sobre qué ACRs existen)
    for (const bAcr of Array.isArray(backup.acrs) ? backup.acrs : []) {
        const acr = acrs.find(a => sameAcr(a, bAcr));
        if (!acr) continue;
        for (const bT of bAcr.tareas || []) {
            const t = (acr.tareas || []).find(x => x.descripcion === bT.descripcion);
            if (t) mergeItem(t, bT, ['estado', 'observaciones', 'fechaCierre']);
        }
    }

    // Compromisos diarios: solo existen en la web, así que se recuperan completos
    for (const bT of Array.isArray(backup.dailyTasks) ? backup.dailyTasks : []) {
        if (!bT || !bT.id) continue;
        const t = tasks.find(x => x.id === bT.id);
        if (!t) {
            tasks.push(bT);
        } else {
            mergeItem(t, bT, ['estado', 'observaciones', 'responsable', 'prioridad', 'compromiso', 'equipo', 'linea']);
        }
    }

    // Más recientes primero (por fecha de creación), como se muestran en la web
    const creado = t => {
        const tsList = (t.historial || []).map(h => h.ts).filter(n => typeof n === 'number');
        return tsList.length ? Math.min(...tsList) : 0;
    };
    tasks.sort((a, b) => creado(b) - creado(a));

    const cambioAcrs = JSON.stringify(acrs) !== antesAcrs;
    const cambioTasks = JSON.stringify(tasks) !== antesTasks;
    if (cambioAcrs) {
        writeJson(DATA_FILE, acrs);
        broadcastEvent({ type: 'data_updated', acrs, user: 'Respaldo PC corporativo', message: 'Se recuperaron cambios guardados.' });
    }
    if (cambioTasks) {
        writeJson(DAILY_DATA_FILE, tasks);
        broadcastEvent({ type: 'daily_updated', dailyTasks: tasks, user: 'Respaldo PC corporativo', message: 'Se recuperaron compromisos guardados.' });
    }
    return { acrs, dailyTasks: tasks };
}

// ---------------------------------------------------------------
// Cola de correos de alerta (se ejecutan en el PC corporativo)
// ---------------------------------------------------------------
let alertQueue = [];            // { id, liderEmail, modoReal, solicitadoEn, entregada }
let agentLastSeen = 0;

function agentOnline() {
    return Date.now() - agentLastSeen < AGENT_ONLINE_MS;
}
function finishAlert(id, result) {
    const idx = alertQueue.findIndex(a => a.id === id);
    if (idx === -1) return false;
    alertQueue.splice(idx, 1);
    broadcastEvent({ type: 'alert_result', id, success: !!result.success, output: result.output || '', error: result.error || '' });
    return true;
}
function validEmail(email) {
    if (!email) return true;
    if (!/^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(email)) return false;
    const domain = email.split('@')[1].toLowerCase();
    return ALERT_DOMAINS.some(d => domain === d || domain.endsWith('.' + d));
}

// ---------------------------------------------------------------
// Escaneo local de Excel: SOLO cuando corre en el PC corporativo.
// ---------------------------------------------------------------
if (!IS_CLOUD) {
    try {
        const { syncAllExcelFiles } = require('./excelScanner');
        const runLocalSync = () => {
            try {
                const antes = fs.readFileSync(DATA_FILE, 'utf8');
                const acrs = syncAllExcelFiles();
                if (acrs && acrs.length > 0 && fs.readFileSync(DATA_FILE, 'utf8') !== antes) {
                    broadcastEvent({ type: 'data_updated', acrs, user: 'Auto-Sync Excel', message: 'Formatos Excel actualizados.' });
                }
            } catch (e) {
                console.error('Error en sincronización local de Excel:', e.message);
            }
        };
        runLocalSync();
        setInterval(runLocalSync, 15000);
    } catch (e) {
        console.error('No se pudo cargar excelScanner:', e.message);
    }
} else {
    console.log('☁️ Modo nube: los ACRs llegan desde el agente de sincronización del PC corporativo.');
}

function getMimeType(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    const mimeTypes = {
        '.html': 'text/html; charset=utf-8',
        '.css': 'text/css; charset=utf-8',
        '.js': 'application/javascript; charset=utf-8',
        '.json': 'application/json; charset=utf-8',
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.svg': 'image/svg+xml',
        '.ico': 'image/x-icon',
        '.webmanifest': 'application/manifest+json'
    };
    return mimeTypes[ext] || 'application/octet-stream';
}

function readBody(req, maxBytes, cb) {
    let body = '';
    let size = 0;
    req.on('data', chunk => {
        size += chunk.length;
        if (size > maxBytes) { req.destroy(); return; }
        body += chunk.toString();
    });
    req.on('end', () => cb(body));
}

function sendJson(res, status, obj) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(obj));
}

function isAgent(req) {
    return !!SYNC_TOKEN && req.headers['x-sync-token'] === SYNC_TOKEN;
}

// Archivos que nunca se deben servir como estáticos
const BLOCKED_FILES = new Set(['server.js', 'excelScanner.js', 'sync-agent.js', 'storage.js', 'package.json', 'package-lock.json', '.env', '.gitignore']);
const BLOCKED_DIRS = ['scripts', 'node_modules', '.git'];

const server = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-sync-token');

    if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

    const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
    let pathname;
    try {
        pathname = decodeURIComponent(parsedUrl.pathname);
    } catch (e) {
        res.writeHead(400); res.end(); return;
    }

    // ---------- SSE ----------
    if (pathname === '/api/events' && req.method === 'GET') {
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache, no-transform',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no'
        });
        sseClients.add(res);
        res.write(`data: ${JSON.stringify({ type: 'init', activeUsers: sseClients.size })}\n\n`);
        broadcastEvent({ type: 'users_count', count: sseClients.size });
        req.on('close', () => {
            sseClients.delete(res);
            broadcastEvent({ type: 'users_count', count: sseClients.size });
        });
        return;
    }

    // ---------- Info / estado ----------
    if (pathname === '/api/info' && req.method === 'GET') {
        const host = req.headers.host;
        const proto = req.headers['x-forwarded-proto'] || 'http';
        return sendJson(res, 200, { ip: getLocalIp(), url: `${proto}://${host}`, localUrl: `http://${getLocalIp()}:${PORT}` });
    }

    if (pathname === '/api/status' && req.method === 'GET') {
        return sendJson(res, 200, {
            cloud: IS_CLOUD,
            agenteConectado: IS_CLOUD ? agentOnline() : true,
            ultimaConexionAgente: agentLastSeen ? new Date(agentLastSeen).toISOString() : null,
            alertasEnCola: alertQueue.length,
            subidaExcel: !!UPLOAD_KEY,
            sharepointUrl: SHAREPOINT_ACR_URL,
            ...storage.status()
        });
    }

    // ---------- ACRs ----------
    if (pathname === '/api/acrs' && req.method === 'GET') {
        return sendJson(res, 200, readJson(DATA_FILE));
    }

    // El agente del PC corporativo envía los ACRs leídos de SharePoint
    if (pathname === '/api/acrs/push' && req.method === 'POST') {
        if (!isAgent(req)) return sendJson(res, 401, { error: 'No autorizado' });
        agentLastSeen = Date.now();
        readBody(req, 20 * 1024 * 1024, body => {
            try {
                const incoming = JSON.parse(body);
                if (!Array.isArray(incoming)) return sendJson(res, 400, { error: 'Se esperaba una lista de ACRs' });
                const existing = readJson(DATA_FILE);
                incoming.forEach(a => { a.origen = 'sharepoint'; });
                const merged = mergeAcrs(incoming, existing);
                // Los ACRs subidos desde la web se conservan aunque el PC no los tenga
                for (const a of existing) {
                    if (a.origen === 'web' && !merged.some(m => sameAcr(m, a))) merged.push(a);
                }
                const cambio = JSON.stringify(merged) !== JSON.stringify(existing);
                if (cambio) {
                    writeJson(DATA_FILE, merged);
                    broadcastEvent({ type: 'data_updated', acrs: merged, user: 'SharePoint', message: `ACRs actualizados desde SharePoint (${merged.length}).` });
                }
                sendJson(res, 200, { success: true, count: merged.length, changed: cambio });
            } catch (e) {
                sendJson(res, 400, { error: 'JSON inválido: ' + e.message });
            }
        });
        return;
    }

    // El agente envía su respaldo y recibe el estado actual + correos pendientes
    if (pathname === '/api/state/sync' && req.method === 'POST') {
        if (!isAgent(req)) return sendJson(res, 401, { error: 'No autorizado' });
        agentLastSeen = Date.now();
        readBody(req, 20 * 1024 * 1024, body => {
            try {
                const backup = body ? JSON.parse(body) : {};
                const state = restoreFromBackup(backup || {});
                const pendientes = alertQueue.filter(a => !a.entregada);
                pendientes.forEach(a => { a.entregada = true; });
                sendJson(res, 200, { bootId: BOOT_ID, acrs: state.acrs, dailyTasks: state.dailyTasks, alertas: pendientes });
            } catch (e) {
                sendJson(res, 400, { error: 'JSON inválido: ' + e.message });
            }
        });
        return;
    }

    if (pathname === '/api/acrs/sync' && req.method === 'POST') {
        // En la nube no hay acceso a SharePoint: se devuelve lo último recibido
        return sendJson(res, 200, {
            success: true,
            count: readJson(DATA_FILE).length,
            cloud: IS_CLOUD,
            agenteConectado: IS_CLOUD ? agentOnline() : true
        });
    }

    if (pathname === '/api/tasks/status' && req.method === 'POST') {
        readBody(req, 1024 * 1024, body => {
            try {
                const payload = JSON.parse(body); // { acrId, taskId, nuevoEstado, observaciones, usuario }
                const acrs = readJson(DATA_FILE);
                const acr = acrs.find(a => a.id === payload.acrId);
                const tarea = acr ? (acr.tareas || []).find(t => t.idTarea === payload.taskId) : null;
                if (!tarea) return sendJson(res, 404, { error: 'La tarea ya no existe o cambió. Recarga la página e intenta de nuevo.' });

                const antiguoEstado = tarea.estado;
                tarea.estado = payload.nuevoEstado;
                if (payload.observaciones) tarea.observaciones = payload.observaciones;
                tarea.fechaCierre = payload.nuevoEstado === 'Realizado' ? new Date().toISOString().split('T')[0] : null;
                if (!tarea.historial) tarea.historial = [];
                tarea.historial.unshift({
                    fecha: ahoraTexto(),
                    ts: Date.now(),
                    usuario: payload.usuario || 'Operador',
                    accion: `Estado cambiado de '${antiguoEstado}' a '${payload.nuevoEstado}'. Obs: ${payload.observaciones || 'Sin cambios'}`
                });
                writeJson(DATA_FILE, acrs);
                broadcastEvent({ type: 'data_updated', acrs, user: payload.usuario || 'Un usuario', message: `Tarea '${tarea.descripcion}' actualizada a '${payload.nuevoEstado}'` });
                sendJson(res, 200, { success: true, message: 'Estado actualizado correctamente' });
            } catch (e) {
                sendJson(res, 400, { error: 'Payload inválido: ' + e.message });
            }
        });
        return;
    }

    // ---------- Compromisos diarios (DDS) ----------
    if (pathname === '/api/daily-tasks' && req.method === 'GET') {
        return sendJson(res, 200, readJson(DAILY_DATA_FILE));
    }

    if (pathname === '/api/daily-tasks/create' && req.method === 'POST') {
        readBody(req, 1024 * 1024, body => {
            try {
                const payload = JSON.parse(body);
                const tasks = readJson(DAILY_DATA_FILE);
                const ahora = new Date();
                const newTask = {
                    id: `DAILY-${ahora.getFullYear()}-${String(tasks.length + 1).padStart(3, '0')}-${ahora.getTime().toString(36).slice(-5)}`,
                    fecha: ahora.toLocaleDateString('es-ES', { timeZone: 'America/Bogota' }),
                    linea: payload.linea,
                    equipo: payload.equipo,
                    compromiso: payload.compromiso,
                    responsable: (payload.responsable && payload.responsable.trim()) || 'No Hay Responsable',
                    prioridad: payload.prioridad || 'Alta',
                    estado: 'Pendiente',
                    observaciones: payload.observaciones || 'Acordado en reunión diaria',
                    historial: [{
                        fecha: ahoraTexto(),
                        ts: ahora.getTime(),
                        usuario: payload.usuario || 'Técnico/Ingeniero',
                        accion: 'Compromiso registrado en reunión diaria'
                    }]
                };
                tasks.unshift(newTask);
                writeJson(DAILY_DATA_FILE, tasks);
                broadcastEvent({ type: 'daily_updated', dailyTasks: tasks, user: payload.usuario || 'Técnico/Ingeniero', message: `Nuevo compromiso registrado: '${payload.compromiso}'` });
                sendJson(res, 200, { success: true, task: newTask });
            } catch (e) {
                sendJson(res, 400, { error: e.message });
            }
        });
        return;
    }

    if (pathname === '/api/daily-tasks/status' && req.method === 'POST') {
        readBody(req, 1024 * 1024, body => {
            try {
                const payload = JSON.parse(body);
                const tasks = readJson(DAILY_DATA_FILE);
                const task = tasks.find(t => t.id === payload.id);
                if (!task) return sendJson(res, 404, { error: 'El compromiso ya no existe. Recarga la página.' });
                const antiguoEstado = task.estado;
                task.estado = payload.nuevoEstado;
                if (payload.observaciones) task.observaciones = payload.observaciones;
                if (!task.historial) task.historial = [];
                task.historial.unshift({
                    fecha: ahoraTexto(),
                    ts: Date.now(),
                    usuario: payload.usuario || 'Técnico/Ingeniero',
                    accion: `Estado cambiado de '${antiguoEstado}' a '${payload.nuevoEstado}'. Obs: ${payload.observaciones || 'Sin cambios'}`
                });
                writeJson(DAILY_DATA_FILE, tasks);
                broadcastEvent({ type: 'daily_updated', dailyTasks: tasks, user: payload.usuario || 'Técnico/Ingeniero', message: `Compromiso diario actualizado a '${payload.nuevoEstado}'` });
                sendJson(res, 200, { success: true });
            } catch (e) {
                sendJson(res, 400, { error: e.message });
            }
        });
        return;
    }

    // ---------- Alertas por correo ----------
    if (pathname === '/api/send-alerts' && req.method === 'POST') {
        readBody(req, 64 * 1024, body => {
            let params = {};
            try { params = body ? JSON.parse(body) : {}; } catch (e) { params = {}; }
            const liderEmail = String(params.liderEmail || '').trim();
            const modoReal = params.modoReal === true;

            if (!validEmail(liderEmail)) {
                return sendJson(res, 400, {
                    success: false,
                    error: `El correo en copia debe ser corporativo (${ALERT_DOMAINS.map(d => '@' + d).join(', ')}).`
                });
            }

            // En el PC corporativo se ejecuta directamente
            if (!IS_CLOUD) {
                const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ALERT_SCRIPT, '-ModoSimulacion', modoReal ? 'false' : 'true'];
                if (liderEmail) args.push('-LiderAreaCc', liderEmail);
                const { execFile } = require('child_process');
                execFile('powershell', args, { encoding: 'utf8', timeout: 180000 }, (error, stdout, stderr) => {
                    sendJson(res, 200, { success: !error, output: stdout || '', error: stderr || (error ? error.message : '') });
                });
                return;
            }

            // En la nube: si el PC corporativo no está conectado, no tiene sentido esperar
            if (!agentOnline()) {
                return sendJson(res, 200, {
                    success: false, agenteDesconectado: true,
                    error: 'El PC corporativo no está conectado, así que no puede enviar el correo con formato. Usa "Abrir correo en mi Outlook" para enviarlo desde tu propia cuenta.'
                });
            }
            // Se deja en cola y el agente del PC corporativo lo envía con Outlook
            const enCurso = alertQueue[0];
            if (enCurso) {
                return sendJson(res, 200, {
                    success: true, queued: true, id: enCurso.id,
                    output: '⏳ Ya hay un envío en curso. Te avisaré aquí cuando el PC corporativo lo procese.'
                });
            }
            const alerta = { id: 'ALERTA-' + Date.now().toString(36), liderEmail, modoReal, solicitadoEn: ahoraTexto(), entregada: false };
            alertQueue.push(alerta);
            setTimeout(() => finishAlert(alerta.id, {
                success: false,
                error: 'El PC corporativo no respondió en 10 minutos. Verifica que el agente de sincronización (iniciar-sincronizacion.bat) esté abierto.'
            }), ALERT_TIMEOUT_MS);

            const aviso = 'El PC corporativo está conectado; el correo saldrá en menos de 1 minuto.';
            sendJson(res, 200, {
                success: true, queued: true, id: alerta.id,
                output: `📨 Solicitud enviada (${modoReal ? 'envío real' : 'simulación'}${liderEmail ? ', CC: ' + liderEmail : ''}).\n${aviso}\nEsperando respuesta...`
            });
        });
        return;
    }

    // Ingenieros: subir un Excel de ACR desde la web (PC o celular)
    if (pathname === '/api/acrs/upload' && req.method === 'POST') {
        if (!UPLOAD_KEY) return sendJson(res, 503, { error: 'La subida de Excel no está habilitada (falta UPLOAD_KEY en Render).' });
        if (req.headers['x-clave-ingenieros'] !== UPLOAD_KEY) return sendJson(res, 401, { error: 'Clave de ingenieros incorrecta.' });

        const nombre = path.basename(String(parsedUrl.searchParams.get('nombre') || '')).replace(/[^\w.\- áéíóúÁÉÍÓÚñÑ()]/g, '_');
        const linea = String(parsedUrl.searchParams.get('linea') || '').replace(/[^\w áéíóúÁÉÍÓÚñÑ-]/g, '').trim();
        const usuario = String(parsedUrl.searchParams.get('usuario') || 'Ingeniero').slice(0, 80);
        if (!/\.(xlsx|xlsm|xls)$/i.test(nombre)) return sendJson(res, 400, { error: 'El archivo debe ser un Excel (.xlsx, .xlsm o .xls).' });
        if (!linea) return sendJson(res, 400, { error: 'Selecciona la línea del ACR.' });

        const partes = [];
        let tam = 0;
        let demasiadoGrande = false;
        req.on('data', c => {
            tam += c.length;
            if (tam > 15 * 1024 * 1024) { demasiadoGrande = true; return; }
            partes.push(c);
        });
        req.on('end', () => {
            if (demasiadoGrande) return sendJson(res, 413, { error: 'El archivo supera 15 MB.' });
            const carpeta = fs.mkdtempSync(path.join(os.tmpdir(), 'acr-'));
            try {
                fs.mkdirSync(path.join(carpeta, linea));
                const ruta = path.join(carpeta, linea, nombre);
                fs.writeFileSync(ruta, Buffer.concat(partes));
                const { parseSingleACRExcel } = require('./excelScanner');
                const nuevo = parseSingleACRExcel(ruta, 1);
                if (!nuevo) return sendJson(res, 400, { error: 'No se pudo leer el Excel. Verifica que sea un formato de ACR.' });
                if (!nuevo.tareas || nuevo.tareas.length === 0) {
                    return sendJson(res, 400, { error: 'El Excel no tiene acciones inmediatas ni preventivas reconocibles. Verifica que sea el formato de ACR.' });
                }
                nuevo.origen = 'web';
                nuevo.subidoPor = usuario;
                nuevo.fechaSubida = ahoraTexto();
                delete nuevo.rutaCompleta;

                const existing = readJson(DATA_FILE);
                const reemplaza = existing.some(a => sameAcr(a, nuevo));
                const incoming = reemplaza
                    ? existing.map(a => (sameAcr(a, nuevo) ? nuevo : a))
                    : [...existing, nuevo];
                const merged = mergeAcrs(incoming.map(a => ({ ...a })), existing);
                writeJson(DATA_FILE, merged);
                const final = merged.find(a => sameAcr(a, nuevo));
                broadcastEvent({ type: 'data_updated', acrs: merged, user: usuario, message: `${reemplaza ? 'Actualizó' : 'Subió'} el ACR '${final.codigoACR}' (${final.tareas.length} tareas).` });
                sendJson(res, 200, { success: true, reemplazado: reemplaza, acr: { id: final.id, codigoACR: final.codigoACR, linea: final.linea, equipo: final.equipo, tareas: final.tareas.length } });
            } catch (e) {
                sendJson(res, 400, { error: 'No se pudo procesar el Excel: ' + e.message });
            } finally {
                fs.rmSync(carpeta, { recursive: true, force: true });
            }
        });
        return;
    }

    // Ingenieros: eliminar un ACR (por ejemplo, si se subió un archivo equivocado)
    if (pathname === '/api/acrs/delete' && req.method === 'POST') {
        if (!UPLOAD_KEY || req.headers['x-clave-ingenieros'] !== UPLOAD_KEY) return sendJson(res, 401, { error: 'Clave de ingenieros incorrecta.' });
        readBody(req, 64 * 1024, body => {
            try {
                const { id, usuario } = JSON.parse(body);
                const acrs = readJson(DATA_FILE);
                const acr = acrs.find(a => a.id === id);
                if (!acr) return sendJson(res, 404, { error: 'Ese ACR ya no existe.' });
                const restantes = acrs.filter(a => a.id !== id);
                writeJson(DATA_FILE, restantes);
                broadcastEvent({ type: 'data_updated', acrs: restantes, user: usuario || 'Ingeniero', message: `Eliminó el ACR '${acr.codigoACR}'.` });
                sendJson(res, 200, { success: true });
            } catch (e) {
                sendJson(res, 400, { error: e.message });
            }
        });
        return;
    }

    // El agente informa el resultado del envío
    if (pathname === '/api/alerts/result' && req.method === 'POST') {
        if (!isAgent(req)) return sendJson(res, 401, { error: 'No autorizado' });
        agentLastSeen = Date.now();
        readBody(req, 1024 * 1024, body => {
            try {
                const r = JSON.parse(body);
                const ok = finishAlert(r.id, r);
                sendJson(res, 200, { success: ok });
            } catch (e) {
                sendJson(res, 400, { error: e.message });
            }
        });
        return;
    }

    // ---------- Archivos estáticos ----------
    const reqFile = (pathname === '/' || !pathname) ? 'index.html' : pathname.replace(/^\/+/, '');
    const firstSegment = reqFile.split(/[\\/]/)[0];
    if (BLOCKED_FILES.has(path.basename(reqFile)) || BLOCKED_DIRS.includes(firstSegment)) {
        res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<h1>404 Recurso No Encontrado</h1>');
        return;
    }

    let safePath = path.resolve(ROOT_DIR, reqFile);
    if (!safePath.startsWith(ROOT_DIR) || !fs.existsSync(safePath) || fs.statSync(safePath).isDirectory()) {
        safePath = path.resolve(PUBLIC_DIR, reqFile);
    }
    if (!safePath.startsWith(ROOT_DIR) || !fs.existsSync(safePath) || fs.statSync(safePath).isDirectory()) {
        res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<h1>404 Recurso No Encontrado</h1>');
        return;
    }

    fs.readFile(safePath, (err, content) => {
        if (err) {
            res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end('<h1>404 Recurso No Encontrado</h1>');
        } else {
            const ext = path.extname(safePath).toLowerCase();
            const headers = { 'Content-Type': getMimeType(safePath) };
            // HTML/JS/CSS siempre frescos para que los celulares no se queden con una versión vieja
            if (['.html', '.js', '.css', '.json'].includes(ext)) headers['Cache-Control'] = 'no-cache';
            res.writeHead(200, headers);
            res.end(content);
        }
    });
});

function getLocalIp() {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name]) {
            if (iface.family === 'IPv4' && !iface.internal) return iface.address;
        }
    }
    return '127.0.0.1';
}

// Arranque: primero se recuperan los datos de la base de datos (si está configurada)
async function arrancar() {
    const conectada = await storage.init(global.__ACR_TEST_DB_CLIENT__);
    if (conectada) {
        for (const [nombre, archivo] of [['acrs', DATA_FILE], ['daily_tasks', DAILY_DATA_FILE]]) {
            const guardado = await storage.load(nombre);
            if (Array.isArray(guardado)) {
                fs.writeFileSync(archivo, JSON.stringify(guardado, null, 2), 'utf8');
            } else {
                await storage.save(nombre, readJson(archivo));   // primera vez: se sube lo que hay
            }
        }
        console.log('🗄️  Base de datos conectada: los datos son permanentes.');
    } else if (IS_CLOUD) {
        console.warn('⚠️ Sin base de datos (MONGODB_URI): los cambios se pierden si Render se reinicia.');
    }
    server.listen(PORT, '0.0.0.0', alEscuchar);
}

function alEscuchar() {
    console.log('=======================================================');
    console.log(`🚀 SERVIDOR ACR DISPONIBLE EN PUERTO: ${PORT} (${IS_CLOUD ? 'nube' : 'local'})`);
    if (!IS_CLOUD) console.log(`👉 En este equipo: http://localhost:${PORT}`);
    if (IS_CLOUD && !SYNC_TOKEN) console.warn('⚠️ Falta la variable SYNC_TOKEN: el agente no podrá enviar datos.');
    console.log('=======================================================');
}

arrancar();
