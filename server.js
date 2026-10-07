const http = require('http');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const { syncAllExcelFiles, TARGET_DIR } = require('./excelScanner');
 
const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data', 'acrs.json');
const DAILY_DATA_FILE = path.join(__dirname, 'data', 'daily_tasks.json');
const PUBLIC_DIR = path.join(__dirname, 'public');
 
// Active Real-Time SSE Clients
const sseClients = new Set();
 
function broadcastEvent(payload) {
    const dataStr = `data: ${JSON.stringify(payload)}\n\n`;
    for (const client of sseClients) {
        try {
            client.write(dataStr);
        } catch (e) {
            sseClients.delete(client);
        }
    }
}
 
// Initial Auto-Sync of Excel files on startup (Safe for Cloud & SharePoint)
console.log('🚀 Ejecutando escaneo inicial de formatos Excel...');
try {
    if (TARGET_DIR && fs.existsSync(TARGET_DIR)) {
        syncAllExcelFiles();
    } else {
        console.log('ℹ️ Operando en modo Web Cloud / SharePoint. Usando base de datos acrs.json.');
    }
} catch (e) {
    console.log('ℹ️ Operando en modo Web Cloud. Usando base de datos acrs.json.');
}
 
// Periodic Background Auto-Sync every 15 seconds (Only if local/network folder exists)
setInterval(() => {
    try {
        if (TARGET_DIR && fs.existsSync(TARGET_DIR)) {
            const acrs = syncAllExcelFiles();
            if (acrs && acrs.length > 0) {
                broadcastEvent({
                    type: 'data_updated',
                    acrs: acrs,
                    user: 'Auto-Sync Excel',
                    message: 'Escaneo automático de red finalizado. Formatos Excel actualizados.'
                });
            }
        }
    } catch (e) {
        // Silent catch for cloud environments
    }
}, 15000);
 
function getMimeType(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    const mimeTypes = {
        '.html': 'text/html; charset=utf-8',
        '.css': 'text/css; charset=utf-8',
        '.js': 'application/javascript; charset=utf-8',
        '.json': 'application/json; charset=utf-8',
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.svg': 'image/svg+xml'
    };
    return mimeTypes[ext] || 'application/octet-stream';
}
 
const server = http.createServer((req, res) => {
    // Enable CORS for all clients
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
 
    if (req.method === 'OPTIONS') {
        res.writeHead(200);
        res.end();
        return;
    }
 
    const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
    const pathname = parsedUrl.pathname;
 
    // REAL-TIME SERVER-SENT EVENTS (SSE) STREAM
    if (pathname === '/api/events' && req.method === 'GET') {
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive'
        });
 
        sseClients.add(res);
 
        // Notify client of successful connection & send current active user count
        res.write(`data: ${JSON.stringify({ type: 'init', activeUsers: sseClients.size })}\n\n`);
        broadcastEvent({ type: 'users_count', count: sseClients.size });
 
        req.on('close', () => {
            sseClients.delete(res);
            broadcastEvent({ type: 'users_count', count: sseClients.size });
        });
        return;
    }
 
    // REST API ENDPOINTS
    if (pathname === '/api/info' && req.method === 'GET') {
        const lanIp = getLocalIp();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            ip: lanIp,
            url: activePublicUrl || `http://${lanIp}:${PORT}`,
            localUrl: `http://${lanIp}:${PORT}`
        }));
        return;
    }
 
    if (pathname === '/api/acrs' && req.method === 'GET') {
        fs.readFile(DATA_FILE, 'utf8', (err, data) => {
            if (err) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Error leyendo base de datos' }));
                return;
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(data);
        });
        return;
    }
 
    if (pathname === '/api/acrs/sync' && req.method === 'POST') {
        try {
            const acrs = syncAllExcelFiles();
            broadcastEvent({
                type: 'data_updated',
                acrs: acrs,
                user: 'Usuario Web',
                message: 'Formatos Excel rescaneados desde el servidor de red.'
            });
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, count: acrs.length }));
        } catch (e) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: e.message }));
        }
        return;
    }
 
    if (pathname === '/api/tasks/status' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => { body += chunk.toString(); });
        req.on('end', () => {
            try {
                const payload = JSON.parse(body); // { acrId, taskId, nuevoEstado, observaciones, usuario }
                fs.readFile(DATA_FILE, 'utf8', (err, data) => {
                    if (err) throw err;
                    let acrs = JSON.parse(data);
                    let acr = acrs.find(a => a.id === payload.acrId);
                    let targetTareaDesc = '';
 
                    if (acr) {
                        let tarea = acr.tareas.find(t => t.idTarea === payload.taskId);
                        if (tarea) {
                            targetTareaDesc = tarea.descripcion;
                            const antiguoEstado = tarea.estado;
                            tarea.estado = payload.nuevoEstado;
                            if (payload.observaciones) {
                                tarea.observaciones = payload.observaciones;
                            }
                            if (payload.nuevoEstado === 'Realizado') {
                                tarea.fechaCierre = new Date().toISOString().split('T')[0];
                            } else {
                                tarea.fechaCierre = null;
                            }
                            // Audit log
                            if (!tarea.historial) tarea.historial = [];
                            const ahora = new Date().toLocaleString('es-ES');
                            tarea.historial.unshift({
                                fecha: ahora,
                                usuario: payload.usuario || 'Operador',
                                accion: `Estado cambiado de '${antiguoEstado}' a '${payload.nuevoEstado}'. Obs: ${payload.observaciones || 'Sin cambios'}`
                            });
                        }
                    }
                    fs.writeFile(DATA_FILE, JSON.stringify(acrs, null, 2), 'utf8', (wErr) => {
                        if (wErr) throw wErr;
 
                        // REAL-TIME BROADCAST TO ALL CONNECTED NETWORK USERS
                        broadcastEvent({
                            type: 'data_updated',
                            acrs: acrs,
                            user: payload.usuario || 'Un usuario',
                            message: `Tarea '${targetTareaDesc}' actualizada a '${payload.nuevoEstado}'`
                        });
 
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ success: true, message: 'Estado actualizado correctamente' }));
                    });
                });
            } catch (e) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Payload inválido: ' + e.message }));
            }
        });
        return;
    }
 
    // DAILY MEETINGS (DDS - TECNICOS E INGENIEROS) ENDPOINTS
    if (pathname === '/api/daily-tasks' && req.method === 'GET') {
        fs.readFile(DAILY_DATA_FILE, 'utf8', (err, data) => {
            if (err) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify([]));
                return;
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(data);
        });
        return;
    }
 
    if (pathname === '/api/daily-tasks/create' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => { body += chunk.toString(); });
        req.on('end', () => {
            try {
                const payload = JSON.parse(body); // { linea, equipo, compromiso, responsable, prioridad, usuario }
                fs.readFile(DAILY_DATA_FILE, 'utf8', (err, data) => {
                    let tasks = [];
                    if (!err && data) tasks = JSON.parse(data);
 
                    const ahoraStr = new Date().toLocaleDateString('es-ES');
                    const ahoraHora = new Date().toLocaleString('es-ES');
                    const newId = `DAILY-${new Date().getFullYear()}-${String(tasks.length + 1).padStart(3, '0')}`;
 
                    let respVal = payload.responsable;
                    if (!respVal || respVal.trim() === '') respVal = 'No Hay Responsable';
 
                    const newTask = {
                        id: newId,
                        fecha: ahoraStr,
                        linea: payload.linea,
                        equipo: payload.equipo,
                        compromiso: payload.compromiso,
                        responsable: respVal,
                        prioridad: payload.prioridad || 'Alta',
                        estado: 'Pendiente',
                        observaciones: payload.observaciones || 'Acordado en reunión diaria',
                        historial: [
                            {
                                fecha: ahoraHora,
                                usuario: payload.usuario || 'Técnico/Ingeniero',
                                accion: 'Compromiso registrado en reunión diaria'
                            }
                        ]
                    };
 
                    tasks.unshift(newTask);
 
                    fs.writeFile(DAILY_DATA_FILE, JSON.stringify(tasks, null, 2), 'utf8', (wErr) => {
                        if (wErr) throw wErr;
 
                        broadcastEvent({
                            type: 'daily_updated',
                            dailyTasks: tasks,
                            user: payload.usuario || 'Técnico/Ingeniero',
                            message: `Nuevo compromiso registrado: '${payload.compromiso}'`
                        });
 
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ success: true, task: newTask }));
                    });
                });
            } catch (e) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: e.message }));
            }
        });
        return;
    }
 
    if (pathname === '/api/daily-tasks/status' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => { body += chunk.toString(); });
        req.on('end', () => {
            try {
                const payload = JSON.parse(body); // { id, nuevoEstado, observaciones, usuario }
                fs.readFile(DAILY_DATA_FILE, 'utf8', (err, data) => {
                    let tasks = JSON.parse(data || '[]');
                    let task = tasks.find(t => t.id === payload.id);
                    if (task) {
                        const antiguoEstado = task.estado;
                        task.estado = payload.nuevoEstado;
                        if (payload.observaciones) task.observaciones = payload.observaciones;
                        if (!task.historial) task.historial = [];
                        task.historial.unshift({
                            fecha: new Date().toLocaleString('es-ES'),
                            usuario: payload.usuario || 'Técnico/Ingeniero',
                            accion: `Estado cambiado de '${antiguoEstado}' a '${payload.nuevoEstado}'. Obs: ${payload.observaciones || 'Sin cambios'}`
                        });
                    }
 
                    fs.writeFile(DAILY_DATA_FILE, JSON.stringify(tasks, null, 2), 'utf8', (wErr) => {
                        if (wErr) throw wErr;
 
                        broadcastEvent({
                            type: 'daily_updated',
                            dailyTasks: tasks,
                            user: payload.usuario || 'Técnico/Ingeniero',
                            message: `Compromiso diario actualizado a '${payload.nuevoEstado}'`
                        });
 
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ success: true }));
                    });
                });
            } catch (e) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: e.message }));
            }
        });
        return;
    }
 
    if (pathname === '/api/send-alerts' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => { body += chunk.toString(); });
        req.on('end', () => {
            let extraArgs = '';
            try {
                if (body) {
                    const params = JSON.parse(body);
                    if (params.liderEmail) extraArgs += ` -LiderAreaCc "${params.liderEmail}"`;
                    if (params.modoReal) extraArgs += ` -ModoSimulacion "false"`;
                }
            } catch (e) {}
 
            const psScript = path.join(__dirname, 'scripts', 'Send-ACRAlerts.ps1');
            exec(`powershell -ExecutionPolicy Bypass -File "${psScript}" ${extraArgs}`, (error, stdout, stderr) => {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    success: !error,
                    output: stdout,
                    error: stderr
                }));
            });
        });
        return;
    }
 
    // STATIC FILE SERVING (Auto-detect root or public folder)
    let reqFile = (pathname === '/' || !pathname) ? 'index.html' : pathname.replace(/^\//, '');
    let safePath = path.join(__dirname, reqFile);
 
    if (!fs.existsSync(safePath)) {
        safePath = path.join(PUBLIC_DIR, reqFile);
    }
 
    if (!fs.existsSync(safePath)) {
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
 
const os = require('os');
function getLocalIp() {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name]) {
            if (iface.family === 'IPv4' && !iface.internal) {
                return iface.address;
            }
        }
    }
    return '172.25.114.42';
}
 
let activePublicUrl = '';
 
// LISTEN ON DYNAMIC CLOUD PORT OR PORT 3000
server.listen(PORT, '0.0.0.0', () => {
    const currentIp = getLocalIp();
    console.log(`=======================================================`);
    console.log(`🚀 SERVIDOR WEB REAL-TIME DISPONIBLE EN PUERTO: ${PORT}`);
    console.log(`👉 En este equipo: http://localhost:${PORT}`);
    console.log(`👉 Para otros usuarios de la red: http://${currentIp}:${PORT}`);
    console.log(`=======================================================`);
});
