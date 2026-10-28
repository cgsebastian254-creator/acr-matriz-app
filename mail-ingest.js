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
//   MAIL_ALLOWED_DOMAINS         dominios de remitente aceptados (kcc.com,kimberly-clark.com,arbex.com)
//   MAIL_INTERVAL_SEC            cada cuánto revisar el buzón (60)
// =====================================================================
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const docs = require('./lib/docs');

// Se recuerdan los correos ya procesados (por Message-ID) para no depender de que sigan
// "sin leer": si alguien abre el correo en Gmail antes que la app, igual se procesa.
const DOC = 'correos_acr';
const DIAS_ATRAS = 4;

function crearReceptorCorreo({ procesarExcel, eliminarACR, confirmarIngreso, log = console.log }) {
    const user = process.env.IMAP_USER || '';
    const pass = process.env.IMAP_PASS || '';
    const token = process.env.MAIL_TOKEN || process.env.SYNC_TOKEN || '';
    const dominios = (process.env.MAIL_ALLOWED_DOMAINS || 'kcc.com,kimberly-clark.com,arbex.com')
        .split(',').map(d => d.trim().toLowerCase()).filter(Boolean);
    const intervalo = Math.max(20, Number(process.env.MAIL_INTERVAL_SEC || 60)) * 1000;

    const estado = {
        configurado: !!(user && pass && token),
        ultimaRevision: null,
        ultimoError: '',
        procesados: 0,
        rechazados: 0,
        registro: []
    };
    if (!estado.configurado) return { estado, iniciar() {}, revisar: async () => {} };

    let enCurso = false;

    function memoria() {
        const m = docs.obtener(DOC, () => ({ ids: [], registro: [], inicializado: false }));
        estado.registro = m.registro;
        return m;
    }
    function anotar(m, entrada) {
        m.registro = [{ fecha: new Date().toISOString(), ...entrada }, ...(m.registro || [])].slice(0, 40);
        estado.registro = m.registro;
    }

    function remitenteValido(direccion) {
        const d = String(direccion || '').toLowerCase().split('@')[1] || '';
        return dominios.some(x => d === x || d.endsWith('.' + x));
    }

    function interpretarAsunto(asunto) {
        const m = String(asunto || '').match(/ACR-(SYNC|DELETE)\s+(\S+)\s*\|?\s*(.*)$/i);
        if (!m) return null;
        return { accion: m[1].toUpperCase(), clave: m[2], dato: m[3].trim() };
    }

    // Lee la verificación que hizo Gmail al recibir el correo (SPF / DKIM / DMARC).
    // Solo se confía en el primer encabezado Authentication-Results, que es el que agrega Gmail.
    function autenticacion(correo, dominio) {
        const lineas = (correo.headerLines || []).filter(h => h.key === 'authentication-results').map(h => h.line);
        const gmail = lineas[0] || '';
        if (!/mx\.google\.com/i.test(gmail)) return { ok: false, detalle: 'sin verificación de Gmail' };
        const t = gmail.replace(/\s+/g, ' ').toLowerCase();
        const d = dominio.toLowerCase();
        const dmarc = new RegExp(`dmarc=pass[^;]*header\\.from=([a-z0-9.-]*\\.)?${d.replace(/\./g, '\\.')}(?![a-z0-9.-])`).test(t);
        const dkim = new RegExp(`dkim=pass[^;]*header\\.(i|d)=@?([a-z0-9.-]*\\.)?${d.replace(/\./g, '\\.')}(?![a-z0-9.-])`).test(t);
        return { ok: dmarc || dkim, detalle: (gmail.match(/(spf|dkim|dmarc)=\w+/gi) || []).join(' ') };
    }

    async function procesarMensaje(fuente) {
        const correo = await simpleParser(fuente);
        const de = correo.from && correo.from.value && correo.from.value[0] ? correo.from.value[0] : {};

        // Ingreso a la app: "ACR-LOGIN 123456" enviado desde el correo corporativo
        const login = String(correo.subject || '').match(/ACR-LOGIN\s+(\d{6})/i);
        if (login) {
            if (!confirmarIngreso) return { ignorado: true };
            const direccion = String(de.address || '').toLowerCase();
            const auth = autenticacion(correo, direccion.split('@')[1] || '');
            if (!auth.ok) {
                log(`🚫 Ingreso rechazado para ${direccion}: el correo no pasó la verificación (${auth.detalle})`);
                return { rechazado: true };
            }
            const r = confirmarIngreso(login[1], direccion);
            log(r ? `🔓 Ingreso confirmado por correo: ${direccion}` : `📭 Código de ingreso ${login[1]} no encontrado o vencido (${direccion})`);
            return { ingreso: r };
        }

        const pedido = interpretarAsunto(correo.subject);
        if (!pedido) return { ignorado: true };
        if (pedido.clave !== token || !remitenteValido(de.address)) {
            estado.rechazados++;
            log(`📭 Correo rechazado (clave o remitente no válidos): ${de.address || 'desconocido'}`);
            return { rechazado: true, resumen: { ok: false, de: de.address || '', detalle: pedido.clave !== token ? 'La clave del asunto no coincide' : `Remitente no permitido (${de.address || 'desconocido'})` } };
        }
        const usuario = de.name || de.address || 'SharePoint';

        if (pedido.accion === 'DELETE') {
            const r = eliminarACR(pedido.dato);
            log(`📭 ${r ? 'Eliminado' : 'No encontrado'} por correo: ${pedido.dato}`);
            estado.procesados++;
            return { eliminado: r, resumen: { ok: true, de: de.address || '', archivo: pedido.dato, detalle: r ? 'ACR eliminado (se borró de SharePoint)' : 'Aviso de eliminación: el ACR no estaba en la app' } };
        }

        const adjuntos = (correo.attachments || []).filter(a => /\.(xlsx|xlsm|xls)$/i.test(a.filename || ''));
        if (!adjuntos.length) {
            log('📭 Correo ACR-SYNC sin adjunto de Excel; se ignora.');
            return { sinAdjunto: true, resumen: { ok: false, de: de.address || '', archivo: pedido.dato, detalle: 'El correo llegó sin el Excel adjunto' } };
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
        const r0 = resultados[0] || {};
        return {
            resultados,
            resumen: {
                ok: resultados.length > 0 && resultados.every(r => r.status === 200),
                de: de.address || '',
                archivo: adjuntos.map(a => a.filename).join(', '),
                linea: r0.body && r0.body.acr ? r0.body.acr.linea : '',
                detalle: resultados.map(r => r.status === 200
                    ? `${r.body.reemplazado ? 'Actualizado' : 'Nuevo'}: ${r.body.acr.codigoACR} (${r.body.acr.tareas} acciones)`
                    : r.body.error).join(' · ') || 'Sin archivos válidos'
            }
        };
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
            const m = memoria();
            let cambio = false;
            try {
                const desde = new Date(Date.now() - DIAS_ATRAS * 86400000);
                const uids = (await cliente.search({ since: desde, subject: 'ACR-' }, { uid: true })) || [];
                const vistos = new Set(m.ids);
                for (const uid of uids) {
                    const info = await cliente.fetchOne(String(uid), { envelope: true, flags: true }, { uid: true });
                    const id = (info.envelope && info.envelope.messageId) || `uid-${uid}`;
                    if (vistos.has(id)) continue;
                    const leido = info.flags && info.flags.has('\\Seen');
                    // Primera vez con esta versión: los correos ya leídos se dan por procesados
                    if (!m.inicializado && leido) { m.ids.push(id); vistos.add(id); cambio = true; continue; }
                    const msg = await cliente.fetchOne(String(uid), { source: true }, { uid: true });
                    let r = {};
                    try {
                        r = await procesarMensaje(msg.source) || {};
                    } catch (e) {
                        log(`📭 Error procesando un correo: ${e.message}`);
                        r = { resumen: { ok: false, detalle: 'Error procesando el correo: ' + e.message } };
                    }
                    if (r.resumen) anotar(m, { asunto: (info.envelope && info.envelope.subject || '').replace(/ACR-(SYNC|DELETE)\s+\S+/i, 'ACR-$1').slice(0, 200), ...r.resumen });
                    m.ids.push(id); vistos.add(id); cambio = true;
                    await cliente.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true });
                }
            } finally {
                candado.release();
            }
            if (!m.inicializado) { m.inicializado = true; cambio = true; }
            if (cambio) { m.ids = m.ids.slice(-800); await docs.guardar(DOC, m); }
            await cliente.logout();
            estado.ultimaRevision = new Date().toISOString();
            estado.ultimoError = '';
        } catch (e) {
            const detalle = [e.message, e.responseText, e.serverResponseCode].filter(Boolean).join(' | ');
            let causa = detalle;
            if (e.authenticationFailed || /AUTHENTICATIONFAILED|Invalid credentials|Application-specific password/i.test(detalle)) {
                causa = 'Gmail rechazó el usuario o la contraseña. Usa la CONTRASEÑA DE APLICACIÓN de 16 letras (sin espacios) en IMAP_PASS, no la contraseña normal. Detalle: ' + detalle;
            } else if (/IMAP access is disabled|IMAP.*disabled|web login required/i.test(detalle)) {
                causa = 'Gmail tiene el acceso IMAP desactivado o pide verificar el inicio de sesión en el navegador. Detalle: ' + detalle;
            }
            estado.ultimoError = causa;
            log(`❌ No se pudo revisar el buzón de ACR: ${causa}`);
            try { await cliente.logout(); } catch (_) { /* conexión ya cerrada */ }
        } finally {
            enCurso = false;
        }
    }

    function iniciar() {
        memoria();
        log(`📬 Revisando el buzón ${user} cada ${intervalo / 1000} s.`);
        revisar();
        setInterval(revisar, intervalo);
    }

    return { estado, iniciar, revisar, _procesarMensaje: procesarMensaje };
}

module.exports = { crearReceptorCorreo };
