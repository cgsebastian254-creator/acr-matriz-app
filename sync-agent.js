// =====================================================================
// AGENTE DE SINCRONIZACIÓN  SharePoint  <->  App pública en Render
// Se ejecuta SOLO en el computador corporativo (que sí ve SharePoint y Outlook).
//
// Cada 30 segundos:
//   1. Guarda en este PC una copia de todo lo que se cambió en la web
//      (estados, observaciones, compromisos diarios). Si Render se reinicia
//      y pierde datos, esta copia los restaura automáticamente.
//   2. Revisa si alguien pidió enviar el correo de alertas y lo envía con Outlook.
// Cada 5 minutos (o al instante si Render se reinició):
//   3. Lee los Excel de ACR de la carpeta de SharePoint y los envía a la web.
// =====================================================================
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { syncAllExcelFiles, TARGET_DIR } = require('./excelScanner');

const APP_URL = (process.env.APP_URL || 'https://acr-matriz-app.onrender.com').replace(/\/+$/, '');
const SYNC_TOKEN = process.env.SYNC_TOKEN;
const EXCEL_INTERVAL_MS = Number(process.env.SYNC_INTERVAL_MIN || 5) * 60 * 1000;
const STATE_INTERVAL_MS = 30 * 1000;

const DATA_DIR = path.join(__dirname, 'data');
const ACRS_FILE = path.join(DATA_DIR, 'acrs.json');
const DAILY_FILE = path.join(DATA_DIR, 'daily_tasks.json');
const ALERT_SCRIPT = path.join(__dirname, 'scripts', 'Send-ACRAlerts.ps1');

if (!SYNC_TOKEN || SYNC_TOKEN === 'PEGA_AQUI_TU_CLAVE_SECRETA') {
    console.error('❌ Falta la clave SYNC_TOKEN. Ábrelo desde iniciar-sincronizacion.bat y pega la misma clave que está en Render.');
    process.exit(1);
}

let lastBootId = null;
let lastExcelPush = 0;
let conectado = null;
let enCiclo = false;

function hora() {
    return new Date().toLocaleTimeString('es-CO', { timeZone: 'America/Bogota' });
}
function log(msg) { console.log(`[${hora()}] ${msg}`); }

function readJson(file) {
    try {
        const data = JSON.parse(fs.readFileSync(file, 'utf8') || '[]');
        return Array.isArray(data) ? data : [];
    } catch (e) {
        return [];
    }
}
function writeJson(file, data) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}

async function post(ruta, body) {
    // Render (plan gratis) puede tardar ~50 s en despertar: se da margen de 90 s
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 90000);
    try {
        const res = await fetch(`${APP_URL}${ruta}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-sync-token': SYNC_TOKEN },
            body: JSON.stringify(body),
            signal: controller.signal
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(`El servidor respondió ${res.status}${data.error ? ': ' + data.error : ''}`);
        return data;
    } finally {
        clearTimeout(timer);
    }
}

// 1. Respaldo y restauración del estado de la web
async function syncState() {
    const respaldo = { acrs: readJson(ACRS_FILE), dailyTasks: readJson(DAILY_FILE) };
    const data = await post('/api/state/sync', respaldo);
    // Lo que devuelve la web (ya unido con el respaldo) pasa a ser el nuevo respaldo local
    writeJson(ACRS_FILE, data.acrs || []);
    writeJson(DAILY_FILE, data.dailyTasks || []);
    return data;
}

// 3. Excel de SharePoint -> web
async function pushExcel() {
    lastExcelPush = Date.now();
    let acrs;
    try {
        acrs = syncAllExcelFiles();
    } catch (e) {
        log(`❌ Error leyendo los Excel: ${e.message}`);
        return;
    }
    if (!acrs || acrs.length === 0) {
        log(`⚠️ No se encontraron ACRs en: ${TARGET_DIR}`);
        log('   Revisa que la carpeta de SharePoint esté sincronizada con OneDrive en este PC.');
        return;
    }
    const r = await post('/api/acrs/push', acrs);
    if (r.changed) log(`✅ ${r.count} ACRs de SharePoint actualizados en la web`);
}

// 2. Correos de alerta pedidos desde la web
function ejecutarAlerta(alerta) {
    return new Promise(resolve => {
        if (!fs.existsSync(ALERT_SCRIPT)) {
            return resolve({ success: false, error: `No se encontró el script en este PC: ${ALERT_SCRIPT}` });
        }
        const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ALERT_SCRIPT, '-ModoSimulacion', alerta.modoReal ? 'false' : 'true'];
        if (alerta.liderEmail && /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(alerta.liderEmail)) {
            args.push('-LiderAreaCc', alerta.liderEmail);
        }
        execFile('powershell', args, { encoding: 'utf8', timeout: 180000, windowsHide: true }, (error, stdout, stderr) => {
            resolve({
                success: !error,
                output: (stdout || '').trim(),
                error: (stderr || '').trim() || (error ? error.message : '')
            });
        });
    });
}

async function procesarAlertas(alertas) {
    for (const alerta of alertas || []) {
        log(`📧 Enviando correo de alertas (${alerta.modoReal ? 'real' : 'simulación'}) pedido desde la web...`);
        const r = await ejecutarAlerta(alerta);
        log(r.success ? '✅ Correo de alertas procesado' : `❌ Error en correo de alertas: ${r.error}`);
        try {
            await post('/api/alerts/result', { id: alerta.id, ...r });
        } catch (e) {
            log(`⚠️ No se pudo informar el resultado a la web: ${e.message}`);
        }
    }
}

async function ciclo() {
    if (enCiclo) return;
    enCiclo = true;
    try {
        let estado = await syncState();
        if (conectado !== true) { log(`🟢 Conectado con ${APP_URL}`); conectado = true; }

        if (estado.bootId !== lastBootId) {
            if (lastBootId) log('🔁 La web se reinició: restaurando datos desde este PC...');
            lastBootId = estado.bootId;
            await pushExcel();
            estado = await syncState();     // recupera estados de los ACRs recién enviados
        } else if (Date.now() - lastExcelPush >= EXCEL_INTERVAL_MS) {
            await pushExcel();
        }

        await procesarAlertas(estado.alertas);
    } catch (e) {
        if (conectado !== false) {
            log(`❌ No se pudo conectar con ${APP_URL}: ${e.message}`);
            log('   Se reintentará cada 30 segundos. Si la red corporativa bloquea la salida, pide a TI permitir el dominio.');
            conectado = false;
        }
    } finally {
        enCiclo = false;
    }
}

console.log('=======================================================');
console.log('🔄 Agente de sincronización SharePoint <-> Render');
console.log(`📁 Carpeta de Excel: ${TARGET_DIR}`);
console.log(`🌐 App: ${APP_URL}`);
console.log(`📧 Script de correo: ${fs.existsSync(ALERT_SCRIPT) ? 'encontrado' : 'NO encontrado (' + ALERT_SCRIPT + ')'}`);
console.log('⏱️  Respaldo cada 30 s · Excel cada 5 min. Deja esta ventana abierta.');
console.log('=======================================================');

ciclo();
setInterval(ciclo, STATE_INTERVAL_MS);
