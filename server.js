const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PORT = process.env.PORT || 3000;
const IS_CLOUD = !!process.env.RENDER;              // Render define esta variable automáticamente
const SYNC_TOKEN = process.env.SYNC_TOKEN || '';    // Clave secreta compartida con el agente de sincronización

const ROOT_DIR = __dirname;
const DATA_DIR = path.join(ROOT_DIR, 'data');
const DATA_FILE = path.join(DATA_DIR, 'acrs.json');
const DAILY_DATA_FILE = path.join(DATA_DIR, 'daily_tasks.json');
const PUBLIC_DIR = path.join(ROOT_DIR, 'public');

// ---------------------------------------------------------------
// Preparar carpeta data/ (si no existe, la crea; si los JSON están
// en la raíz del repo, los copia; si no, arranca vacío)
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
        return JSON.parse(fs.readFileSync(file, 'utf8') || '[]');
    } catch (e) {
        return [];
    }
}
function writeJson(file, data) {
    fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
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

// ---------------------------------------------------------------
// Escaneo local de Excel: SOLO cuando corre en el PC corporativo.
// En Render no hay acceso a SharePoint; los datos llegan por /api/acrs/push
// ---------------------------------------------------------------
if (!IS_CLOUD) {
    try {
        const { syncAllExcelFiles } = require('./excelScanner');
        const runLocalSync = () => {
            try {
                const acrs = syncAllExcelFiles();
                if (acrs && acrs.length > 0) {
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
    console.log('☁️ Modo nube: los ACRs llegan desde el agente de sincronización (POST /api/acrs/push).');
}

// Une los ACRs nuevos (de Excel) con los estados que los usuarios ya cambiaron en la web
function mergeAcrs(incoming, existing) {
    for (const newAcr of incoming) {
        const oldAcr = existing.find(a => a.archivoOrigen === newAcr.archivoOrigen || a.falla === newAcr.falla);
        if (!oldAcr || !Array.isArray(newAcr.tareas)) continue;
        for (const newT of newAcr.tareas) {
            const oldT = (oldAcr.tareas || []).find(t => t.descripcion === newT.descripcion);
            if (oldT) {
                newT.estado = oldT.estado;
                newT.observaciones = oldT.observaciones;
                if (oldT.fechaCierre) newT.fechaCierre = oldT.fechaCierre;
                if (oldT.historial) newT.historial = oldT.historial;
            }
        }
    }
    return incoming;
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
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(obj));
}

// Archivos que nunca se deben servir como estáticos
const BLOCKED_FILES = new Set(['server.js', 'excelScanner.js', 'sync-agent.js', 'package.json', 'package-lock.json', '.env']);

const server = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-sync-token');

    if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

    const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
    const pathname = decodeURIComponent(parsedUrl.pathname);

    // ---------- SSE ----------
    if (pathname === '/api/events' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
        sseClients.add(res);
        res.write(`data: ${JSON.stringify({ type: 'init', activeUsers: sseClients.size })}\n\n`);
        broadcastEvent({ type: 'users_count', count: sseClients.size });
        req.on('close', () => {
            sseClients.delete(res);
            broadcastEvent({ type: 'users_count', count: sseClients.size });
        });
        return;
    }

    // ---------- Info ----------
    if (pathname === '/api/info' && req.method === 'GET') {
        const host = req.headers.host;
        const proto = req.headers['x-forwarded-proto'] || 'http';
        return sendJson(res, 200, { ip: getLocalIp(), url: `${proto}://${host}`, localUrl: `http://${getLocalIp()}:${PORT}` });
    }

    // ---------- ACRs ----------
    if (pathname === '/api/acrs' && req.method === 'GET') {
        return sendJson(res, 200, readJson(DATA_FILE));
    }

    // Recibe los ACRs desde el agente que corre en el PC corporativo
    if (pathname === '/api/acrs/push' && req.method === 'POST') {
        if (!SYNC_TOKEN || req.headers['x-sync-token'] !== SYNC_TOKEN) {
            return sendJson(res, 401, { error: 'No autorizado' });
        }
        readBody(req, 20 * 1024 * 1024, body => {
            try {
                const incoming = JSON.parse(body);
                if (!Array.isArray(incoming)) return sendJson(res, 400, { error: 'Se esperaba una lista de ACRs' });
                const merged = mergeAcrs(incoming, readJson(DATA_FILE));
                writeJson(DATA_FILE, merged);
                broadcastEvent({ type: 'data_updated', acrs: merged, user: 'Sincronización SharePoint', message: `ACRs actualizados desde SharePoint (${merged.length}).` });
                sendJson(res, 200, { success: true, count: merged.length });
            } catch (e) {
                sendJson(res, 400, { error: 'JSON inválido: ' + e.message });
            }
        });
        return;
    }

    if (pathname === '/api/acrs/sync' && req.method === 'POST') {
        // En la nube no hay acceso a SharePoint: se devuelve lo último recibido
        return sendJson(res, 200, { success: true, count: readJson(DATA_FILE).length, cloud: IS_CLOUD });
    }

    if (pathname === '/api/tasks/status' && req.method === 'POST') {
        readBody(req, 1024 * 1024, body => {
            try {
                const payload = JSON.parse(body); // { acrId, taskId, nuevoEstado, observaciones, usuario }
                const acrs = readJson(DATA_FILE);
                const acr = acrs.find(a => a.id === payload.acrId);
                let targetTareaDesc = '';
                if (acr) {
                    const tarea = (acr.tareas || []).find(t => t.idTarea === payload.taskId);
                    if (tarea) {
                        targetTareaDesc = tarea.descripcion;
                        const antiguoEstado = tarea.estado;
                        tarea.estado = payload.nuevoEstado;
                        if (payload.observaciones) tarea.observaciones = payload.observaciones;
                        tarea.fechaCierre = payload.nuevoEstado === 'Realizado' ? new Date().toISOString().split('T')[0] : null;
                        if (!tarea.historial) tarea.historial = [];
                        tarea.historial.unshift({
                            fecha: new Date().toLocaleString('es-ES', { timeZone: 'America/Bogota' }),
                            usuario: payload.usuario || 'Operador',
                            accion: `Estado cambiado de '${antiguoEstado}' a '${payload.nuevoEstado}'. Obs: ${payload.observaciones || 'Sin cambios'}`
                        });
                    }
                }
                writeJson(DATA_FILE, acrs);
                broadcastEvent({ type: 'data_updated', acrs, user: payload.usuario || 'Un usuario', message: `Tarea '${targetTareaDesc}' actualizada a '${payload.nuevoEstado}'` });
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
                    id: `DAILY-${ahora.getFullYear()}-${String(tasks.length + 1).padStart(3, '0')}-${ahora.getTime().toString().slice(-4)}`,
                    fecha: ahora.toLocaleDateString('es-ES', { timeZone: 'America/Bogota' }),
                    linea: payload.linea,
                    equipo: payload.equipo,
                    compromiso: payload.compromiso,
                    responsable: (payload.responsable && payload.responsable.trim()) || 'No Hay Responsable',
                    prioridad: payload.prioridad || 'Alta',
                    estado: 'Pendiente',
                    observaciones: payload.observaciones || 'Acordado en reunión diaria',
                    historial: [{
                        fecha: ahora.toLocaleString('es-ES', { timeZone: 'America/Bogota' }),
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
                if (task) {
                    const antiguoEstado = task.estado;
                    task.estado = payload.nuevoEstado;
                    if (payload.observaciones) task.observaciones = payload.observaciones;
                    if (!task.historial) task.historial = [];
                    task.historial.unshift({
                        fecha: new Date().toLocaleString('es-ES', { timeZone: 'America/Bogota' }),
                        usuario: payload.usuario || 'Técnico/Ingeniero',
                        accion: `Estado cambiado de '${antiguoEstado}' a '${payload.nuevoEstado}'. Obs: ${payload.observaciones || 'Sin cambios'}`
                    });
                }
                writeJson(DAILY_DATA_FILE, tasks);
                broadcastEvent({ type: 'daily_updated', dailyTasks: tasks, user: payload.usuario || 'Técnico/Ingeniero', message: `Compromiso diario actualizado a '${payload.nuevoEstado}'` });
                sendJson(res, 200, { success: true });
            } catch (e) {
                sendJson(res, 400, { error: e.message });
            }
        });
        return;
    }

    // ---------- Alertas por correo: solo en el PC corporativo ----------
    if (pathname === '/api/send-alerts' && req.method === 'POST') {
        if (IS_CLOUD) return sendJson(res, 200, { success: false, error: 'Las alertas por correo solo funcionan desde el PC corporativo.' });
        readBody(req, 64 * 1024, body => {
            const args = ['-ExecutionPolicy', 'Bypass', '-File', path.join(ROOT_DIR, 'scripts', 'Send-ACRAlerts.ps1')];
            try {
                const params = body ? JSON.parse(body) : {};
                // Solo se acepta un correo con formato válido (evita inyección de comandos)
                if (params.liderEmail && /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(params.liderEmail)) {
                    args.push('-LiderAreaCc', params.liderEmail);
                }
                if (params.modoReal === true) args.push('-ModoSimulacion', 'false');
            } catch (e) { /* cuerpo vacío o inválido: se usan valores por defecto */ }
            const { execFile } = require('child_process');
            execFile('powershell', args, (error, stdout, stderr) => {
                sendJson(res, 200, { success: !error, output: stdout, error: stderr });
            });
        });
        return;
    }

    // ---------- Archivos estáticos ----------
    const reqFile = (pathname === '/' || !pathname) ? 'index.html' : pathname.replace(/^\/+/, '');
    if (BLOCKED_FILES.has(path.basename(reqFile))) {
        res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<h1>404 Recurso No Encontrado</h1>');
        return;
    }

    let safePath = path.resolve(ROOT_DIR, reqFile);
    if (!safePath.startsWith(ROOT_DIR) || !fs.existsSync(safePath) || fs.statSync(safePath).isDirectory()) {
        safePath = path.resolve(PUBLIC_DIR, reqFile);
    }
    if (!safePath.startsWith(ROOT_DIR) || !fs.existsSync(safePath) || fs.statSync(safePath).isDirectory()) {
        console.warn(`404: ${pathname}`);
        res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<h1>404 Recurso No Encontrado</h1>');
        return;
    }

    fs.readFile(safePath, (err, content) => {
        if (err) {
            res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end('<h1>404 Recurso No Encontrado</h1>');
        } else {
            res.writeHead(200, { 'Content-Type': getMimeType(safePath) });
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

server.listen(PORT, '0.0.0.0', () => {
    console.log('=======================================================');
    console.log(`🚀 SERVIDOR ACR DISPONIBLE EN PUERTO: ${PORT} (${IS_CLOUD ? 'nube' : 'local'})`);
    console.log(`📂 Archivos en la carpeta del proyecto: ${fs.readdirSync(ROOT_DIR).join(', ')}`);
    if (!IS_CLOUD) console.log(`👉 En este equipo: http://localhost:${PORT}`);
    if (IS_CLOUD && !SYNC_TOKEN) console.warn('⚠️ Falta la variable SYNC_TOKEN: el agente no podrá enviar datos.');
    console.log('=======================================================');
});
