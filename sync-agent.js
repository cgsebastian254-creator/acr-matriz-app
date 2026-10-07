// =====================================================================
// AGENTE DE SINCRONIZACIÓN SHAREPOINT -> APP PÚBLICA EN RENDER
// Se ejecuta SOLO en el computador corporativo (que sí ve SharePoint).
// Lee los Excel de ACR de la carpeta sincronizada con OneDrive,
// los convierte con excelScanner.js y los envía a la app en Render.
// =====================================================================
const { syncAllExcelFiles, TARGET_DIR } = require('./excelScanner');

const APP_URL = (process.env.APP_URL || 'https://acr-matriz-app.onrender.com').replace(/\/+$/, '');
const SYNC_TOKEN = process.env.SYNC_TOKEN;
const INTERVAL_MIN = Number(process.env.SYNC_INTERVAL_MIN || 5);

if (!SYNC_TOKEN) {
    console.error('❌ Falta SYNC_TOKEN. Ábrelo desde iniciar-sincronizacion.bat.');
    process.exit(1);
}

function hora() {
    return new Date().toLocaleTimeString('es-CO', { timeZone: 'America/Bogota' });
}

async function pushOnce() {
    let acrs;
    try {
        acrs = syncAllExcelFiles();
    } catch (e) {
        console.error(`[${hora()}] ❌ Error leyendo Excel: ${e.message}`);
        return;
    }
    if (!acrs || acrs.length === 0) {
        console.warn(`[${hora()}] ⚠️ No se encontraron ACRs en: ${TARGET_DIR}`);
        console.warn('   Revisa que la carpeta de SharePoint esté sincronizada con OneDrive en este PC.');
        return;
    }

    try {
        // Render (plan gratis) puede tardar ~50 s en despertar: se da margen de 90 s
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 90000);
        const res = await fetch(`${APP_URL}/api/acrs/push`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-sync-token': SYNC_TOKEN },
            body: JSON.stringify(acrs),
            signal: controller.signal
        });
        clearTimeout(timer);
        const data = await res.json().catch(() => ({}));
        if (res.ok) {
            console.log(`[${hora()}] ✅ ${data.count} ACRs enviados a ${APP_URL}`);
        } else {
            console.error(`[${hora()}] ❌ El servidor respondió ${res.status}: ${data.error || ''}`);
        }
    } catch (e) {
        console.error(`[${hora()}] ❌ No se pudo conectar con ${APP_URL}: ${e.message}`);
        console.error('   Si la red corporativa bloquea la salida, prueba desde otra red o pide a TI permitir el dominio.');
    }
}

console.log('=======================================================');
console.log('🔄 Agente de sincronización SharePoint -> Render');
console.log(`📁 Carpeta de Excel: ${TARGET_DIR}`);
console.log(`🌐 App: ${APP_URL}`);
console.log(`⏱️  Cada ${INTERVAL_MIN} minutos. Deja esta ventana abierta.`);
console.log('=======================================================');

pushOnce();
setInterval(pushOnce, INTERVAL_MIN * 60 * 1000);
