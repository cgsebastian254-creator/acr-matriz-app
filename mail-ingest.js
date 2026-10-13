// =====================================================================
// Recepción de ACR por correo (sin Power Automate Premium)
//
// Un flujo de Power Automate con conectores estándar envía el Excel del ACR
// como adjunto a un buzón dedicado. La app revisa ese buzón por IMAP,
// procesa los adjuntos y marca los correos como leídos.
//
// Asunto que debe enviar el flujo:
//   ACR-SYNC <clave> | <ruta de la carpeta>      -> crea o actualiza el ACR
//   ACR-DELETE <clave> | <nombre del archivo>    -> quita el ACR de la app
//
// Variables de entorno:
//   IMAP_USER, IMAP_PASS         cuenta del buzón (en Gmail: contraseña de aplicación)
//   IMAP_HOST (imap.gmail.com), IMAP_PORT (993)
//   MAIL_TOKEN                   clave que debe venir en el asunto (si no hay, usa SYNC_TOKEN)
//   MAIL_ALLOWED_DOMAINS         dominios de remitente aceptados (kcc.com,kimberly-clark.com)
//   MAIL_INTERVAL_SEC            cada cuánto revisar el buzón (60)
// =====================================================================
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');

function crearReceptorCorreo({ procesarExcel, eliminarACR, log = console.log }) {
    const user = process.env.IMAP_USER || '';
    const pass = process.env.IMAP_PASS || '';
    const token = process.env.MAIL_TOKEN || process.env.SYNC_TOKEN || '';
    const dominios = (process.env.MAIL_ALLOWED_DOMAINS || 'kcc.com,kimberly-clark.com')
        .split(',').map(d => d.trim().toLowerCase()).filter(Boolean);
    const intervalo = Math.max(20, Number(process.env.MAIL_INTERVAL_SEC || 60)) * 1000;

    const estado = {
        configurado: !!(user && pass && token),
        ultimaRevision: null,
        ultimoError: '',
        procesados: 0,
        rechazados: 0
    };
    if (!estado.configurado) return { estado, iniciar() {}, revisar: async () => {} };

    let enCurso = false;

    function remitenteValido(direccion) {
        const d = String(direccion || '').toLowerCase().split('@')[1] || '';
        return dominios.some(x => d === x || d.endsWith('.' + x));
    }

    function interpretarAsunto(asunto) {
        const m = String(asunto || '').match(/ACR-(SYNC|DELETE)\s+(\S+)\s*\|?\s*(.*)$/i);
        if (!m) return null;
        return { accion: m[1].toUpperCase(), clave: m[2], dato: m[3].trim() };
    }

    async function procesarMensaje(fuente) {
        const correo = await simpleParser(fuente);
        const de = correo.from && correo.from.value && correo.from.value[0] ? correo.from.value[0] : {};
        const pedido = interpretarAsunto(correo.subject);
        if (!pedido) return { ignorado: true };
        if (pedido.clave !== token || !remitenteValido(de.address)) {
            estado.rechazados++;
            log(`📭 Correo rechazado (clave o remitente no válidos): ${de.address || 'desconocido'}`);
            return { rechazado: true };
        }
        const usuario = de.name || de.address || 'SharePoint';

        if (pedido.accion === 'DELETE') {
            const r = eliminarACR(pedido.dato);
            log(`📭 ${r ? 'Eliminado' : 'No encontrado'} por correo: ${pedido.dato}`);
            estado.procesados++;
            return { eliminado: r };
        }

        const adjuntos = (correo.attachments || []).filter(a => /\.(xlsx|xlsm|xls)$/i.test(a.filename || ''));
        if (!adjuntos.length) {
            log('📭 Correo ACR-SYNC sin adjunto de Excel; se ignora.');
            return { sinAdjunto: true };
        }
        const resultados = [];
        for (const a of adjuntos) {
            if (a.filename.startsWith('~$')) continue;
            const r = procesarExcel(a.content, a.filename, pedido.dato, usuario);
            resultados.push(r);
            log(r.status === 200
                ? `📬 ACR recibido por correo: ${a.filename} (${r.body.acr.tareas} tareas, ${r.body.acr.linea})`
                : `📭 No se pudo leer ${a.filename}: ${r.body.error}`);
        }
        estado.procesados++;
        return { resultados };
    }

    async function revisar() {
        if (enCurso) return;
        enCurso = true;
        const cliente = new ImapFlow({
            host: process.env.IMAP_HOST || 'imap.gmail.com',
            port: Number(process.env.IMAP_PORT || 993),
            secure: process.env.IMAP_SECURE !== 'false',
            auth: { user, pass },
            logger: false
        });
        try {
            await cliente.connect();
            const candado = await cliente.getMailboxLock('INBOX');
            try {
                const uids = await cliente.search({ seen: false, subject: 'ACR-' }, { uid: true });
                for (const uid of uids || []) {
                    const msg = await cliente.fetchOne(String(uid), { source: true }, { uid: true });
                    try {
                        await procesarMensaje(msg.source);
                    } catch (e) {
                        log(`📭 Error procesando un correo: ${e.message}`);
                    }
                    // Se marca como leído para no procesarlo dos veces
                    await cliente.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true });
                }
            } finally {
                candado.release();
            }
            await cliente.logout();
            estado.ultimaRevision = new Date().toISOString();
            estado.ultimoError = '';
        } catch (e) {
            estado.ultimoError = e.message;
            log(`❌ No se pudo revisar el buzón de ACR: ${e.message}`);
            try { await cliente.logout(); } catch (_) { /* conexión ya cerrada */ }
        } finally {
            enCurso = false;
        }
    }

    function iniciar() {
        log(`📬 Revisando el buzón ${user} cada ${intervalo / 1000} s.`);
        revisar();
        setInterval(revisar, intervalo);
    }

    return { estado, iniciar, revisar, _procesarMensaje: procesarMensaje };
}

module.exports = { crearReceptorCorreo };
