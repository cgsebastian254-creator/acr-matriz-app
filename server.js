const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const storage = require('./storage');

const PORT = process.env.PORT || 3000;
const IS_CLOUD = !!process.env.RENDER;              // Render define esta variable automáticamente
const SYNC_TOKEN = process.env.SYNC_TOKEN || '';    // Clave secreta compartida con el agente de sincronización
const APP_PASSWORD = process.env.APP_PASSWORD || '';  // Contraseña para entrar a la app (si está vacía, la app queda abierta)
const SESSION_DAYS = Number(process.env.SESSION_DAYS || 30);
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
// Acceso a la app
//   LOGIN_MODE=correo  -> correo corporativo + código de 6 dígitos enviado al correo
//   (por defecto)      -> contraseña única APP_PASSWORD (si está vacía, la app queda abierta)
// ---------------------------------------------------------------
const crypto = require('crypto');
const LOGIN_MODE = (() => {
    const m = (process.env.LOGIN_MODE || '').toLowerCase();
    if (m === 'correo' || m === 'clave') return m;
    // Por defecto: correo corporativo si hay una cuenta para enviar códigos
    return (process.env.SMTP_USER || process.env.IMAP_USER) && (process.env.SMTP_PASS || process.env.IMAP_PASS) ? 'correo' : 'clave';
})();
const LOGIN_DOMAINS = (process.env.LOGIN_DOMAINS || 'kcc.com,kimberly-clark.com,arbex.com')
    .split(',').map(d => d.trim().toLowerCase()).filter(Boolean);
const LOGIN_EMAILS = (process.env.LOGIN_EMAILS || '')            // opcional: lista exacta de correos permitidos
    .split(',').map(d => d.trim().toLowerCase()).filter(Boolean);
const SMTP_USER = process.env.SMTP_USER || process.env.IMAP_USER || '';
const SMTP_PASS = process.env.SMTP_PASS || process.env.IMAP_PASS || '';
// La firma usa los secretos del servidor: si se cambia alguno, todas las sesiones se cierran
const SESSION_SECRET = crypto.createHash('sha256').update(['acr-sesion', LOGIN_MODE, APP_PASSWORD,
    process.env.SESSION_SECRET || '', SYNC_TOKEN, SMTP_PASS].join('|')).digest();
const COOKIE = 'acr_sesion';
const accesoProtegido = () => LOGIN_MODE === 'correo' || !!APP_PASSWORD;

function firmar(valor) {
    return crypto.createHmac('sha256', SESSION_SECRET).update(valor).digest('base64url');
}
function igualSeguro(a, b) {
    const x = Buffer.from(String(a));
    const y = Buffer.from(String(b));
    return x.length === y.length && crypto.timingSafeEqual(x, y);
}
function leerCookie(req, nombre) {
    const partes = String(req.headers.cookie || '').split(';');
    for (const p of partes) {
        const i = p.indexOf('=');
        if (i > -1 && p.slice(0, i).trim() === nombre) return decodeURIComponent(p.slice(i + 1).trim());
    }
    return '';
}
// Devuelve la sesión ({ correo }) o null
function leerSesion(req) {
    if (!accesoProtegido()) return { correo: '' };
    const partes = leerCookie(req, COOKIE).split('.');
    if (LOGIN_MODE === 'correo') {
        if (partes.length !== 3) return null;
        const [correoB64, vence, firma] = partes;
        if (!igualSeguro(firma, firmar(correoB64 + '.' + vence)) || Number(vence) <= Date.now()) return null;
        const correo = Buffer.from(correoB64, 'base64url').toString('utf8');
        return correoPermitido(correo) ? { correo } : null;
    }
    if (partes.length !== 2) return null;
    const [vence, firma] = partes;
    if (!igualSeguro(firma, firmar(vence)) || Number(vence) <= Date.now()) return null;
    return { correo: '' };
}
function sesionValida(req) {
    return !!leerSesion(req);
}
function crearCookieSesion(req, correo) {
    const vence = String(Date.now() + SESSION_DAYS * 24 * 3600 * 1000);
    const valor = correo
        ? `${Buffer.from(correo, 'utf8').toString('base64url')}.${vence}`
        : vence;
    const seguro = (req.headers['x-forwarded-proto'] || '').includes('https') ? '; Secure' : '';
    return `${COOKIE}=${valor}.${firmar(valor)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 24 * 3600}${seguro}`;
}

function correoPermitido(correo) {
    const c = String(correo || '').trim().toLowerCase();
    if (!/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(c)) return false;
    if (LOGIN_EMAILS.length) return LOGIN_EMAILS.includes(c);
    const dominio = c.split('@')[1];
    return LOGIN_DOMAINS.some(d => dominio === d || dominio.endsWith('.' + d));
}
function nombreDesdeCorreo(correo) {
    return String(correo || '').split('@')[0].split(/[._-]+/).filter(Boolean)
        .map(p => p.charAt(0).toUpperCase() + p.slice(1)).join(' ');
}

// Límite de intentos por IP para evitar que adivinen la contraseña o el código
const intentos = new Map();
function ipDe(req) {
    return String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
}
function bloqueado(ip) {
    const r = intentos.get(ip);
    if (!r) return false;
    if (Date.now() - r.desde > 15 * 60 * 1000) { intentos.delete(ip); return false; }
    return r.n >= 10;
}
function registrarFallo(ip) {
    const r = intentos.get(ip);
    if (!r || Date.now() - r.desde > 15 * 60 * 1000) intentos.set(ip, { n: 1, desde: Date.now() });
    else r.n++;
}

// ---- Códigos de verificación por correo ----
const codigos = new Map();   // correo -> { hash, vence, intentos, enviados: [timestamps] }
function hashCodigo(correo, codigo) {
    return crypto.createHmac('sha256', SESSION_SECRET).update(correo + '|' + codigo).digest('base64url');
}
// Envío de correos. En el plan gratis de Render el SMTP está bloqueado, así que se usa
// la API HTTPS de Brevo si hay BREVO_API_KEY; si no, SMTP (útil fuera de Render).
const BREVO_API_KEY = (process.env.BREVO_API_KEY || '').trim().replace(/^['"]|['"]$/g, '');
const REMITENTE = process.env.MAIL_FROM || process.env.BREVO_SENDER || SMTP_USER;
const puedeEnviarCorreo = () => !!(BREVO_API_KEY ? REMITENTE : (SMTP_USER && SMTP_PASS));
let transporteCorreo = null;
function transporteSMTP() {
    if (!transporteCorreo) {
        const nodemailer = require('nodemailer');
        transporteCorreo = nodemailer.createTransport({
            host: process.env.SMTP_HOST || 'smtp.gmail.com',
            port: Number(process.env.SMTP_PORT || 465),
            secure: (process.env.SMTP_PORT || '465') === '465',
            auth: { user: SMTP_USER, pass: SMTP_PASS },
            connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 20000
        });
    }
    return transporteCorreo;
}
async function enviarCorreo({ to, cc, subject, html, text }) {
    const aLista = v => (Array.isArray(v) ? v : String(v || '').split(/[,;]+/)).map(x => String(x).trim()).filter(Boolean);
    const para = aLista(to);
    const copia = aLista(cc);
    if (BREVO_API_KEY) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 20000);
        try {
            const r = await fetch(process.env.BREVO_API_URL || 'https://api.brevo.com/v3/smtp/email', {
                method: 'POST',
                headers: { 'api-key': BREVO_API_KEY, 'Content-Type': 'application/json', accept: 'application/json' },
                body: JSON.stringify({
                    sender: { name: 'Matriz de ACRs', email: REMITENTE },
                    to: para.map(email => ({ email })),
                    ...(copia.length ? { cc: copia.map(email => ({ email })) } : {}),
                    subject, htmlContent: html, textContent: text
                }),
                signal: controller.signal
            });
            if (!r.ok) {
                const detalle = await r.text().catch(() => '');
                throw new Error(`Brevo respondió ${r.status}: ${detalle.slice(0, 300)}`);
            }
            return;
        } catch (e) {
            if (e.name === 'AbortError') throw new Error('Brevo no respondió en 20 segundos.');
            throw e;
        } finally {
            clearTimeout(timer);
        }
    }
    await transporteSMTP().sendMail({ from: `"Matriz de ACRs" <${REMITENTE}>`, to: para.join(', '), cc: copia.join(', ') || undefined, subject, html, text });
}
async function enviarCodigo(correo, ip) {
    const ahora = Date.now();
    const reg = codigos.get(correo) || { enviados: [] };
    reg.enviados = (reg.enviados || []).filter(t => ahora - t < 60 * 60 * 1000);
    if (reg.enviados.length && ahora - reg.enviados[reg.enviados.length - 1] < 45 * 1000) {
        return { ok: true, reciente: true };   // ya se envió hace menos de 45 s: no se reenvía
    }
    if (reg.enviados.length >= 6) return { ok: false, error: 'Se enviaron demasiados códigos a este correo. Espera una hora e intenta de nuevo.' };
    const codigo = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    reg.hash = hashCodigo(correo, codigo);
    reg.vence = ahora + 10 * 60 * 1000;
    reg.intentos = 0;
    reg.enviados.push(ahora);
    codigos.set(correo, reg);
    if (global.__ACR_TEST_CODIGOS__) { global.__ACR_TEST_CODIGOS__[correo] = codigo; return { ok: true }; }
    await enviarCorreo({
        to: correo,
        subject: `Tu código de ingreso a la Matriz de ACRs: ${codigo}`,
        text: `Tu código de ingreso es ${codigo}\n\nVence en 10 minutos. Si no lo pediste, ignora este correo.`,
        html: `<div style="font-family:Segoe UI,Arial,sans-serif;max-width:420px">
<h2 style="color:#1e3a8a;margin:0 0 8px">Matriz de ACRs</h2>
<p style="margin:0 0 16px;color:#334155">Tu código de ingreso es:</p>
<div style="font-size:32px;font-weight:700;letter-spacing:8px;background:#eff6ff;border-radius:10px;padding:14px 18px;text-align:center;color:#1e3a8a">${codigo}</div>
<p style="color:#64748b;font-size:13px;margin-top:16px">Vence en 10 minutos. Si no lo pediste, ignora este correo.</p></div>`
    });
    console.log(`🔐 Código de ingreso enviado a ${correo} (IP ${ip})`);
    return { ok: true };
}
function verificarCodigo(correo, codigo) {
    const reg = codigos.get(correo);
    if (!reg || !reg.hash) return 'Pide un código nuevo.';
    if (Date.now() > reg.vence) return 'El código venció. Pide uno nuevo.';
    if (reg.intentos >= 5) return 'Demasiados intentos con este código. Pide uno nuevo.';
    reg.intentos++;
    if (!igualSeguro(hashCodigo(correo, String(codigo).replace(/\D/g, '')), reg.hash)) return 'Código incorrecto.';
    reg.hash = null;    // un código sirve una sola vez
    return '';
}

// ---- Ingreso enviando un correo desde la cuenta corporativa (no depende de recibir correos) ----
// La persona envía "ACR-LOGIN 123456" desde su correo al buzón de la app; la app lo lee,
// confirma con las firmas de Gmail (DMARC/DKIM) que viene de ese correo y abre la sesión.
const BUZON_APP = process.env.IMAP_USER || '';
const LOGIN_METODO = (() => {
    const m = (process.env.LOGIN_METODO || '').toLowerCase();
    if (m === 'codigo' || m === 'enviar') return m;
    return BUZON_APP && process.env.IMAP_PASS ? 'enviar' : 'codigo';
})();
const pendientes = new Map();   // id -> { correo, codigo, vence, confirmado }
function crearPendiente(correo) {
    const ahora = Date.now();
    for (const [id, p] of pendientes) if (p.vence < ahora) pendientes.delete(id);
    const recientes = [...pendientes.values()].filter(p => p.correo === correo);
    if (recientes.length >= 10) return null;
    let codigo;
    do { codigo = String(crypto.randomInt(100000, 1000000)); } while ([...pendientes.values()].some(p => p.codigo === codigo));
    const id = crypto.randomBytes(24).toString('base64url');
    pendientes.set(id, { correo, codigo, vence: ahora + 15 * 60 * 1000, confirmado: false });
    return { id, codigo };
}
function confirmarIngreso(codigo, correo) {
    for (const p of pendientes.values()) {
        if (p.codigo === codigo && p.correo === correo && p.vence > Date.now()) { p.confirmado = true; return true; }
    }
    return false;
}
let ultimaRevisionLogin = 0;

function escHtml(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}
function paginaLogin(mensaje, opciones = {}) {
    const paso = opciones.paso || (LOGIN_MODE === 'correo' ? 'correo' : 'clave');
    const correo = escHtml(opciones.correo || '');
    let formulario;
    if (paso === 'clave') {
        formulario = `<form method="POST" action="/login">
  <label for="clave">Contraseña</label>
  <input id="clave" name="clave" type="password" autocomplete="current-password" autofocus required>
  <button type="submit">Entrar</button></form>`;
    } else if (paso === 'correo') {
        formulario = `<form method="POST" action="/login/codigo">
  <label for="correo">Correo corporativo</label>
  <input id="correo" name="correo" type="email" inputmode="email" autocomplete="email" placeholder="nombre@kcc.com" value="${correo}" autofocus required>
  <button type="submit">Enviarme un código</button>
  <p class="nota">Te enviaremos un código de 6 dígitos a tu correo de la empresa.</p></form>`;
    } else if (paso === 'enviar') {
        const codigo = escHtml(opciones.codigo || '');
        const asunto = `ACR-LOGIN ${opciones.codigo || ''}`;
        const mailto = `mailto:${encodeURIComponent(BUZON_APP).replace(/%40/g, '@')}?subject=${encodeURIComponent(asunto)}&body=${encodeURIComponent('Ingreso a la Matriz de ACRs')}`;
        formulario = `<p class="ok">Para confirmar que eres <strong>${correo}</strong>, envía este correo <strong>desde esa cuenta</strong>. La app entra sola cuando lo reciba.</p>
  <div class="pasos">
    <div><span>Para</span><code id="c-para">${escHtml(BUZON_APP)}</code></div>
    <div><span>Asunto</span><code id="c-asunto">${escHtml(asunto)}</code></div>
  </div>
  <a class="boton" href="${mailto}">✉️ Abrir Outlook con el correo listo</a>
  <button type="button" class="link copiar" onclick="navigator.clipboard && navigator.clipboard.writeText('${escHtml(asunto)}').then(()=>{this.textContent='✓ Asunto copiado'})">Copiar asunto</button>
  <div class="espera"><span class="punto"></span><span id="estado">Esperando tu correo… (puede tardar hasta 30 segundos)</span></div>
  <form method="POST" action="/login/codigo" class="secundario">
    <input type="hidden" name="correo" value="${correo}">
    <input type="hidden" name="metodo" value="codigo">
    <button type="submit" class="link">Prefiero recibir un código</button>
    <a href="/login" class="link">Usar otro correo</a>
  </form>
  <script>
    (function revisar(){
      fetch('/login/estado',{cache:'no-store'}).then(r=>r.json()).then(d=>{
        if(d.ok){document.getElementById('estado').textContent='¡Listo! Entrando…';location.href='/';return;}
        if(d.vencido){document.getElementById('estado').textContent='El tiempo se acabó. Vuelve a empezar.';return;}
        setTimeout(revisar,3000);
      }).catch(()=>setTimeout(revisar,5000));
    })();
  </script>`;
    } else {
        formulario = `<form method="POST" action="/login/verificar">
  <input type="hidden" name="correo" value="${correo}">
  <p class="ok">Enviamos un código a <strong>${correo}</strong>. Revisa también la carpeta de correo no deseado.</p>
  <label for="codigo">Código de 6 dígitos</label>
  <input id="codigo" name="codigo" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9 ]{6,7}" maxlength="7" placeholder="000000" autofocus required>
  <button type="submit">Entrar</button>
</form>
<form method="POST" action="/login/codigo" class="secundario">
  <input type="hidden" name="correo" value="${correo}">
  <button type="submit" class="link">Reenviar código</button>
  <a href="/login" class="link">Usar otro correo</a>
</form>`;
    }
    return `<!DOCTYPE html>
<html lang="es"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="theme-color" content="#0f172a">
<link rel="manifest" href="/manifest.json">
<title>Matriz de ACRs - Ingreso</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:Inter,Segoe UI,Arial,sans-serif;background:#0f172a;color:#f1f5f9;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:16px}
  .caja{width:100%;max-width:380px;background:#1e293b;border:1px solid #334155;border-radius:16px;padding:28px 24px;box-shadow:0 20px 40px rgba(0,0,0,.4)}
  .logo{display:inline-block;background:#fff;border-radius:8px;padding:6px 12px;margin-bottom:18px}
  .logo img{height:30px;display:block}
  h1{font-size:19px;margin-bottom:4px}
  .sub{font-size:13px;color:#94a3b8;margin-bottom:20px}
  label{display:block;font-size:12px;font-weight:600;color:#94a3b8;text-transform:uppercase;letter-spacing:.04em;margin-bottom:6px}
  input{width:100%;padding:12px 14px;border-radius:10px;border:1px solid #334155;background:#0f172a;color:#f1f5f9;font-size:16px;outline:none}
  input#codigo{font-size:24px;letter-spacing:8px;text-align:center}
  input:focus{border-color:#3b82f6}
  button{width:100%;margin-top:16px;padding:12px;border:0;border-radius:10px;background:#3b82f6;color:#fff;font-size:15px;font-weight:600;cursor:pointer}
  button:hover{background:#2563eb}
  .nota{font-size:12px;color:#94a3b8;margin-top:12px}
  .ok{font-size:13px;color:#cbd5e1;background:rgba(59,130,246,.12);border:1px solid rgba(59,130,246,.35);border-radius:10px;padding:10px 12px;margin-bottom:14px}
  .secundario{display:flex;justify-content:space-between;align-items:center;margin-top:14px;gap:10px}
  .link{background:none;border:0;color:#93c5fd;font-size:13px;font-weight:500;padding:0;margin:0;width:auto;cursor:pointer;text-decoration:none}
  .link:hover{background:none;text-decoration:underline}
  .pasos{display:grid;gap:8px;margin:0 0 14px}
  .pasos div{display:grid;grid-template-columns:62px 1fr;align-items:center;gap:8px;font-size:12px;color:#94a3b8}
  .pasos code{background:#0f172a;border:1px solid #334155;border-radius:8px;padding:8px 10px;color:#f1f5f9;font-size:14px;word-break:break-all;user-select:all}
  .boton{display:block;text-align:center;padding:12px;border-radius:10px;background:#3b82f6;color:#fff;font-size:15px;font-weight:600;text-decoration:none}
  .boton:hover{background:#2563eb}
  .copiar{display:block;margin:10px auto 0}
  .espera{display:flex;align-items:center;gap:10px;margin-top:16px;font-size:13px;color:#cbd5e1}
  .punto{width:10px;height:10px;border-radius:50%;background:#3b82f6;animation:lat 1.2s infinite}
  @keyframes lat{0%,100%{opacity:.3}50%{opacity:1}}
  .error{background:rgba(239,68,68,.15);border:1px solid rgba(239,68,68,.5);color:#fca5a5;border-radius:10px;padding:10px 12px;font-size:13px;margin-bottom:14px}
</style></head>
<body><div class="caja">
  <div class="logo"><img src="/arbex_logo.png" alt="Arbex"></div>
  <h1>Matriz de ACRs</h1>
  <p class="sub">Planta Conversión · Acceso restringido</p>
  ${mensaje ? `<div class="error">${escHtml(mensaje)}</div>` : ''}
  ${formulario}
</div></body></html>`;
}

// Rutas que no necesitan sesión: la página de ingreso, lo que el navegador
// necesita para instalar la app, y las que usan su propia clave (agente / Power Automate)
const RUTAS_PUBLICAS = new Set(['/login', '/login/codigo', '/login/verificar', '/login/estado', '/logout', '/manifest.json', '/arbex_logo.png', '/healthz']);
const RUTAS_CON_TOKEN = new Set(['/api/acrs/push', '/api/state/sync', '/api/alerts/result', '/api/acrs/sharepoint', '/api/acrs/sharepoint-delete']);

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
// Procesar un Excel de ACR (subido desde la web o enviado por Power Automate)
// ---------------------------------------------------------------
const LINEAS = ['Forte', 'Futura', 'Hinnli', 'Pocket', 'Sincro 1', 'Sincro 2'];
function lineaDesdeCarpeta(texto) {
    const partes = String(texto).split(/[\\/]/).map(x => x.trim()).filter(Boolean);
    const normal = x => x.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]/g, '');
    // Se busca de la carpeta más profunda hacia arriba una que corresponda a una línea conocida
    for (let i = partes.length - 1; i >= 0; i--) {
        const encontrada = LINEAS.find(l => normal(l) === normal(partes[i]));
        if (encontrada) return encontrada;
    }
    return partes.length ? partes[partes.length - 1].replace(/[^\w áéíóúÁÉÍÓÚñÑ-]/g, '').trim() || 'Sin línea' : 'Sin línea';
}

function procesarExcelACR(buffer, nombre, linea, usuario, origen) {
    const carpeta = fs.mkdtempSync(path.join(os.tmpdir(), 'acr-'));
    try {
        const lineaSegura = String(linea || 'Sin línea').replace(/[^\w áéíóúÁÉÍÓÚñÑ-]/g, '').trim() || 'Sin línea';
        fs.mkdirSync(path.join(carpeta, lineaSegura));
        const ruta = path.join(carpeta, lineaSegura, nombre);
        fs.writeFileSync(ruta, buffer);
        const { parseSingleACRExcel } = require('./excelScanner');
        const nuevo = parseSingleACRExcel(ruta, 1);
        if (!nuevo) return { status: 400, body: { error: 'No se pudo leer el Excel. Verifica que sea un formato de ACR.' } };
        if (!nuevo.tareas || nuevo.tareas.length === 0) {
            return { status: 400, body: { error: 'El Excel no tiene acciones inmediatas ni preventivas reconocibles. Verifica que sea el formato de ACR.' } };
        }
        nuevo.origen = origen;
        nuevo.subidoPor = String(usuario || '').slice(0, 80);
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
        broadcastEvent({ type: 'data_updated', acrs: merged, user: nuevo.subidoPor || 'SharePoint', message: `${reemplaza ? 'Actualizó' : 'Subió'} el ACR '${final.codigoACR}' (${final.tareas.length} tareas).` });
        return { status: 200, body: { success: true, reemplazado: reemplaza, acr: { id: final.id, codigoACR: final.codigoACR, linea: final.linea, equipo: final.equipo, tareas: final.tareas.length } } };
    } catch (e) {
        return { status: 400, body: { error: 'No se pudo procesar el Excel: ' + e.message } };
    } finally {
        fs.rmSync(carpeta, { recursive: true, force: true });
    }
}

function eliminarACRPorArchivo(nombre, usuario = 'SharePoint') {
    const base = path.basename(String(nombre || '')).trim();
    if (!base) return false;
    const sinExt = base.replace(/\.(xlsx|xlsm|xls)$/i, '');
    const acrs = readJson(DATA_FILE);
    const quedan = acrs.filter(a => a.archivoOrigen !== base && a.codigoACR !== sinExt);
    if (quedan.length === acrs.length) return false;
    writeJson(DATA_FILE, quedan);
    broadcastEvent({ type: 'data_updated', acrs: quedan, user: usuario, message: `Se eliminó el ACR '${sinExt}' (se borró de SharePoint).` });
    return true;
}

// ---------------------------------------------------------------
// Recepción de ACR por correo (Power Automate estándar -> buzón -> app)
// ---------------------------------------------------------------
const { crearReceptorCorreo } = require('./mail-ingest');
const receptorCorreo = crearReceptorCorreo({
    procesarExcel: (buffer, nombre, carpeta, usuario) => {
        const limpio = path.basename(String(nombre)).replace(/[^\w.\- áéíóúÁÉÍÓÚñÑ()]/g, '_');
        return procesarExcelACR(buffer, limpio, lineaDesdeCarpeta(carpeta), usuario, 'sharepoint');
    },
    eliminarACR: nombre => eliminarACRPorArchivo(nombre),
    confirmarIngreso: (codigo, correo) => correoPermitido(correo) && confirmarIngreso(codigo, correo)
});

// ---------------------------------------------------------------
// Correo de alertas: envío automático diario
//   ALERTAS_AUTO_HORA        hora local (Bogotá) "HH:MM", por ejemplo 07:00. Vacío = desactivado
//   ALERTAS_AUTO_DIAS        días de la semana (1=lunes ... 7=domingo), por defecto 1,2,3,4,5
//   ALERTAS_DESTINATARIOS    correos separados por coma (Para)
//   ALERTAS_CC               correos en copia (opcional)
// Si el servidor estaba dormido a esa hora, el correo sale apenas despierte ese mismo día.
// ---------------------------------------------------------------
const { generarResumen } = require('./alertas');
function listaCorreos(v) {
    return String(v || '').split(/[;,\s]+/).map(x => x.trim().toLowerCase()).filter(Boolean);
}
function correoCorporativo(c) {
    if (!/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(c)) return false;
    const d = c.split('@')[1];
    return LOGIN_DOMAINS.some(x => d === x || d.endsWith('.' + x));
}
function urlPublica(req) {
    if (process.env.APP_URL) return process.env.APP_URL;
    if (process.env.RENDER_EXTERNAL_URL) return process.env.RENDER_EXTERNAL_URL;
    if (req) return `${req.headers['x-forwarded-proto'] || 'http'}://${req.headers.host}`;
    return '';
}
let ultimoEnvioAuto = '';   // fecha (AAAA-MM-DD) del último envío automático
function configAlertasAuto() {
    const hora = (process.env.ALERTAS_AUTO_HORA || '').trim();
    return {
        activo: /^\d{1,2}:\d{2}$/.test(hora) && listaCorreos(process.env.ALERTAS_DESTINATARIOS).length > 0 && puedeEnviarCorreo(),
        hora,
        dias: (process.env.ALERTAS_AUTO_DIAS || '1,2,3,4,5'),
        para: listaCorreos(process.env.ALERTAS_DESTINATARIOS),
        cc: listaCorreos(process.env.ALERTAS_CC),
        ultimoEnvio: ultimoEnvioAuto || null
    };
}
async function revisarEnvioAutomatico() {
    const cfg = configAlertasAuto();
    if (!cfg.activo) return;
    const partes = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
        timeZone: 'America/Bogota', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short'
    }).formatToParts(new Date()).map(p => [p.type, p.value]));
    const hoy = `${partes.year}-${partes.month}-${partes.day}`;
    const diaSemana = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 }[partes.weekday];
    const dias = cfg.dias.split(',').map(Number);
    const [hh, mm] = cfg.hora.split(':').map(Number);
    const ahoraMin = Number(partes.hour) * 60 + Number(partes.minute);
    if (ultimoEnvioAuto === hoy || !dias.includes(diaSemana) || ahoraMin < hh * 60 + mm) return;
    ultimoEnvioAuto = hoy;              // se marca antes de enviar para no duplicar
    try {
        const resumen = generarResumen(readJson(DATA_FILE), readJson(DAILY_DATA_FILE), { urlApp: urlPublica() });
        await enviarCorreo({ to: cfg.para, cc: cfg.cc, subject: resumen.asunto, html: resumen.html, text: resumen.texto });
        await storage.save('alertas_auto', { ultimoEnvio: hoy });
        console.log(`📧 Alertas automáticas del ${hoy} enviadas a ${cfg.para.join(', ')}`);
    } catch (e) {
        ultimoEnvioAuto = '';          // se reintenta en la próxima revisión
        console.error('❌ Falló el envío automático de alertas:', e.message);
    }
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

    if (pathname === '/healthz') {
        res.writeHead(200, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
        res.end('ok');
        return;
    }

    // ---------- Ingreso con contraseña ----------
    if (pathname === '/login' && req.method === 'GET') {
        if (sesionValida(req)) { res.writeHead(302, { Location: '/' }); res.end(); return; }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(paginaLogin(''));
        return;
    }
    const responderLogin = (msg, code, opciones) => {
        res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(paginaLogin(msg, opciones));
    };
    if (pathname === '/login' && req.method === 'POST' && LOGIN_MODE === 'clave') {
        const ip = ipDe(req);
        readBody(req, 4096, body => {
            if (bloqueado(ip)) return responderLogin('Demasiados intentos. Espera 15 minutos e intenta de nuevo.', 429);
            const clave = new URLSearchParams(body).get('clave') || '';
            if (!APP_PASSWORD || igualSeguro(clave, APP_PASSWORD)) {
                intentos.delete(ip);
                res.writeHead(302, { 'Set-Cookie': crearCookieSesion(req), Location: '/', 'Cache-Control': 'no-store' });
                res.end();
                return;
            }
            registrarFallo(ip);
            responderLogin('Contraseña incorrecta.', 401);
        });
        return;
    }
    if (pathname === '/login/codigo' && req.method === 'POST' && LOGIN_MODE === 'correo') {
        const ip = ipDe(req);
        readBody(req, 4096, async body => {
            const correo = String(new URLSearchParams(body).get('correo') || '').trim().toLowerCase();
            if (bloqueado(ip)) return responderLogin('Demasiados intentos. Espera 15 minutos e intenta de nuevo.', 429, { paso: 'correo', correo });
            if (!correoPermitido(correo)) {
                registrarFallo(ip);
                const msg = LOGIN_EMAILS.length
                    ? 'Este correo no tiene acceso a la Matriz de ACRs.'
                    : `Usa tu correo corporativo (${LOGIN_DOMAINS.map(d => '@' + d).join(', ')}).`;
                return responderLogin(msg, 400, { paso: 'correo', correo });
            }
            const metodo = new URLSearchParams(body).get('metodo') || LOGIN_METODO;
            if (metodo === 'enviar' && BUZON_APP) {
                const p = crearPendiente(correo);
                if (!p) return responderLogin('Demasiados intentos con este correo. Espera unos minutos.', 429, { paso: 'correo', correo });
                const seguro = (req.headers['x-forwarded-proto'] || '').includes('https') ? '; Secure' : '';
                res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
                    'Set-Cookie': `acr_pend=${p.id}; Path=/login; HttpOnly; SameSite=Lax; Max-Age=900${seguro}` });
                res.end(paginaLogin('', { paso: 'enviar', correo, codigo: p.codigo }));
                return;
            }
            try {
                const r = await enviarCodigo(correo, ip);
                if (!r.ok) return responderLogin(r.error, 429, { paso: 'correo', correo });
                responderLogin('', 200, { paso: 'codigo', correo });
            } catch (e) {
                console.error('❌ No se pudo enviar el código de ingreso:', e.message);
                responderLogin('No se pudo enviar el código. Intenta de nuevo en un momento.', 500, { paso: 'correo', correo });
            }
        });
        return;
    }
    if (pathname === '/login/verificar' && req.method === 'POST' && LOGIN_MODE === 'correo') {
        const ip = ipDe(req);
        readBody(req, 4096, body => {
            const datos = new URLSearchParams(body);
            const correo = String(datos.get('correo') || '').trim().toLowerCase();
            if (bloqueado(ip)) return responderLogin('Demasiados intentos. Espera 15 minutos e intenta de nuevo.', 429, { paso: 'correo', correo });
            if (!correoPermitido(correo)) return responderLogin('Correo no válido.', 400, { paso: 'correo' });
            const error = verificarCodigo(correo, datos.get('codigo') || '');
            if (error) {
                registrarFallo(ip);
                return responderLogin(error, 401, { paso: /nuevo/.test(error) ? 'correo' : 'codigo', correo });
            }
            intentos.delete(ip);
            console.log(`🔓 Ingreso: ${correo}`);
            res.writeHead(302, { 'Set-Cookie': crearCookieSesion(req, correo), Location: '/', 'Cache-Control': 'no-store' });
            res.end();
        });
        return;
    }
    if (pathname === '/login/estado' && req.method === 'GET') {
        const p = pendientes.get(leerCookie(req, 'acr_pend'));
        if (!p || p.vence < Date.now()) return sendJson(res, 200, { ok: false, vencido: true });
        if (p.confirmado) {
            pendientes.delete(leerCookie(req, 'acr_pend'));
            res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store',
                'Set-Cookie': [crearCookieSesion(req, p.correo), 'acr_pend=; Path=/login; HttpOnly; SameSite=Lax; Max-Age=0'] });
            res.end(JSON.stringify({ ok: true }));
            return;
        }
        // Mientras alguien espera, el buzón se revisa cada ~8 segundos
        if (Date.now() - ultimaRevisionLogin > 8000) { ultimaRevisionLogin = Date.now(); receptorCorreo.revisar(); }
        return sendJson(res, 200, { ok: false });
    }
    if (pathname.startsWith('/login') && req.method === 'POST') {
        res.writeHead(302, { Location: '/login' });
        res.end();
        return;
    }
    if (pathname === '/logout') {
        res.writeHead(302, { 'Set-Cookie': `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`, Location: '/login' });
        res.end();
        return;
    }
    const sesion = leerSesion(req);
    if (!RUTAS_PUBLICAS.has(pathname) && !RUTAS_CON_TOKEN.has(pathname) && !sesion) {
        if (pathname.startsWith('/api/')) return sendJson(res, 401, { error: 'Sesión vencida. Vuelve a ingresar.', login: true });
        res.writeHead(302, { Location: '/login', 'Cache-Control': 'no-store' });
        res.end();
        return;
    }

    // ---------- Usuario de la sesión ----------
    if (pathname === '/api/me' && req.method === 'GET') {
        return sendJson(res, 200, {
            modo: LOGIN_MODE,
            correo: sesion ? sesion.correo : '',
            nombre: sesion && sesion.correo ? nombreDesdeCorreo(sesion.correo) : ''
        });
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
            acceso: LOGIN_MODE === 'correo' ? 'correo corporativo' : (APP_PASSWORD ? 'contraseña' : 'abierto'),
            buzonACR: receptorCorreo.estado,
            alertasAuto: configAlertasAuto(),
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
                incoming.forEach(a => { a.origen = 'agente'; });
                const merged = mergeAcrs(incoming, existing);
                // Los ACRs subidos desde la web se conservan aunque el PC no los tenga
                for (const a of existing) {
                    if ((a.origen === 'web' || a.origen === 'sharepoint') && !merged.some(m => sameAcr(m, a))) merged.push(a);
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
        // Revisa ya mismo el buzón de ACR (si está configurado) y devuelve lo que hay
        if (receptorCorreo.estado.configurado) {
            receptorCorreo.revisar().then(() => sendJson(res, 200, {
                success: true, count: readJson(DATA_FILE).length, cloud: IS_CLOUD, correo: receptorCorreo.estado
            }));
            return;
        }
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
                    correo: sesion ? sesion.correo || undefined : undefined,
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
                        correo: sesion ? sesion.correo || undefined : undefined,
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
                    correo: sesion ? sesion.correo || undefined : undefined,
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

    // ---------- Alertas por correo (enviadas desde la cuenta de la app) ----------
    if (pathname === '/api/send-alerts' && req.method === 'POST') {
        readBody(req, 64 * 1024, async body => {
            let params = {};
            try { params = body ? JSON.parse(body) : {}; } catch (e) { params = {}; }
            const modoReal = params.modoReal === true;
            const para = listaCorreos(params.para || (sesion && sesion.correo) || '');
            const cc = listaCorreos(params.cc || params.liderEmail || '');
            const invalidos = [...para, ...cc].filter(c => !correoCorporativo(c));
            if (invalidos.length) {
                return sendJson(res, 400, { success: false, error: `Solo se puede enviar a correos corporativos (${LOGIN_DOMAINS.map(d => '@' + d).join(', ')}). Revisa: ${invalidos.join(', ')}` });
            }
            if (!para.length) return sendJson(res, 400, { success: false, error: 'Escribe al menos un destinatario.' });

            const resumen = generarResumen(readJson(DATA_FILE), readJson(DAILY_DATA_FILE), { urlApp: urlPublica(req) });
            if (!modoReal) {
                return sendJson(res, 200, { success: true, output: `🧪 VISTA PREVIA (no se envió nada)\nAsunto: ${resumen.asunto}\nPara: ${para.join(', ')}${cc.length ? '\nCC: ' + cc.join(', ') : ''}\n\n${resumen.texto}`, html: resumen.html });
            }
            if (!puedeEnviarCorreo()) {
                return sendJson(res, 200, { success: false, error: 'La app no tiene cómo enviar correos (falta BREVO_API_KEY en Render). Usa "Abrir correo en mi Outlook".' });
            }
            try {
                await enviarCorreo({ to: para, cc, subject: resumen.asunto, html: resumen.html, text: resumen.texto });
                console.log(`📧 Alertas enviadas a ${para.join(', ')}${cc.length ? ' (CC ' + cc.join(', ') + ')' : ''} por ${sesion && sesion.correo ? sesion.correo : 'usuario'}`);
                sendJson(res, 200, { success: true, output: `✅ Correo enviado.\nPara: ${para.join(', ')}${cc.length ? '\nCC: ' + cc.join(', ') : ''}\nAsunto: ${resumen.asunto}\n\n${resumen.texto}\n\nSi no aparece en la bandeja de entrada, revisa correo no deseado.` });
            } catch (e) {
                console.error('❌ No se pudo enviar el correo de alertas:', e.message);
                sendJson(res, 200, { success: false, error: 'No se pudo enviar el correo: ' + e.message });
            }
        });
        return;
    }

    // Configuración del envío automático diario
    if (pathname === '/api/alertas/config' && req.method === 'GET') {
        return sendJson(res, 200, configAlertasAuto());
    }

    // Ingenieros: subir un Excel de ACR desde la web (PC o celular)
    if (pathname === '/api/acrs/upload' && req.method === 'POST') {

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
            const r = procesarExcelACR(Buffer.concat(partes), nombre, linea, usuario, 'web');
            sendJson(res, r.status, r.body);
        });
        return;
    }

    // Power Automate: recibe un Excel de ACR cuando se crea o modifica en SharePoint
    if (pathname === '/api/acrs/sharepoint' && req.method === 'POST') {
        if (!isAgent(req)) return sendJson(res, 401, { error: 'No autorizado (revisa el encabezado x-sync-token).' });
        readBody(req, 25 * 1024 * 1024, body => {
            let p;
            try { p = JSON.parse(body); } catch (e) { return sendJson(res, 400, { error: 'JSON inválido: ' + e.message }); }
            const nombre = path.basename(String(p.nombre || '')).replace(/[^\w.\- áéíóúÁÉÍÓÚñÑ()]/g, '_');
            if (!/\.(xlsx|xlsm|xls)$/i.test(nombre)) {
                return sendJson(res, 200, { success: true, ignorado: true, motivo: 'No es un archivo Excel' });
            }
            if (nombre.startsWith('~$')) return sendJson(res, 200, { success: true, ignorado: true, motivo: 'Archivo temporal de Excel' });

            // El contenido llega como {"$content-type": ..., "$content": "base64"} o como texto base64
            const archivo = p.archivo || p.contenido;
            const base64 = typeof archivo === 'string' ? archivo : (archivo && archivo['$content']);
            if (!base64) return sendJson(res, 400, { error: 'Falta el contenido del archivo (campo "archivo").' });

            const linea = lineaDesdeCarpeta(p.linea || p.carpeta || '');
            const r = procesarExcelACR(Buffer.from(base64, 'base64'), nombre, linea, p.usuario || 'SharePoint', 'sharepoint');
            sendJson(res, r.status, r.body);
        });
        return;
    }

    // Power Automate: un Excel se eliminó de SharePoint
    if (pathname === '/api/acrs/sharepoint-delete' && req.method === 'POST') {
        if (!isAgent(req)) return sendJson(res, 401, { error: 'No autorizado (revisa el encabezado x-sync-token).' });
        readBody(req, 64 * 1024, body => {
            try {
                const p = JSON.parse(body);
                const nombre = path.basename(String(p.nombre || ''));
                const acrs = readJson(DATA_FILE);
                const quedan = acrs.filter(a => a.archivoOrigen !== nombre);
                if (quedan.length === acrs.length) return sendJson(res, 200, { success: true, eliminado: false });
                writeJson(DATA_FILE, quedan);
                broadcastEvent({ type: 'data_updated', acrs: quedan, user: 'SharePoint', message: `Se eliminó el ACR '${nombre}' de SharePoint.` });
                sendJson(res, 200, { success: true, eliminado: true });
            } catch (e) {
                sendJson(res, 400, { error: e.message });
            }
        });
        return;
    }

    // Ingenieros: eliminar un ACR (por ejemplo, si se subió un archivo equivocado)
    if (pathname === '/api/acrs/delete' && req.method === 'POST') {
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
    }
    // Limpieza: quita la tarea falsa que el lector anterior tomaba del pie del formato
    const acrsActuales = readJson(DATA_FILE);
    let quitadas = 0;
    for (const a of acrsActuales) {
        const antes = (a.tareas || []).length;
        a.tareas = (a.tareas || []).filter(t => !/^pasos para la ejecuci[oó]n de un acr/i.test(String(t.descripcion || '').trim()));
        quitadas += antes - a.tareas.length;
    }
    if (quitadas) {
        writeJson(DATA_FILE, acrsActuales);
        console.log(`🧹 Se quitaron ${quitadas} tareas "Pasos para la ejecución de un ACR" leídas por error.`);
    }
    if (!conectada && IS_CLOUD) {
        console.warn('⚠️ Sin base de datos (MONGODB_URI): los cambios se pierden si Render se reinicia.');
    }
    server.listen(PORT, '0.0.0.0', alEscuchar);
}

function alEscuchar() {
    receptorCorreo.iniciar();
    storage.load('alertas_auto').then(d => { if (d && d.ultimoEnvio) ultimoEnvioAuto = d.ultimoEnvio; })
        .catch(() => {}).finally(() => { revisarEnvioAutomatico(); setInterval(revisarEnvioAutomatico, 60 * 1000); });
    const auto = configAlertasAuto();
    if (auto.activo) console.log(`⏰ Alertas automáticas: ${auto.hora} (días ${auto.dias}) para ${auto.para.join(', ')}`);
    console.log('=======================================================');
    console.log(`🚀 SERVIDOR ACR DISPONIBLE EN PUERTO: ${PORT} (${IS_CLOUD ? 'nube' : 'local'})`);
    if (!IS_CLOUD) console.log(`👉 En este equipo: http://localhost:${PORT}`);
    if (LOGIN_MODE === 'correo') console.log(`🔑 Método de ingreso: ${LOGIN_METODO === 'enviar' ? 'la persona envía un correo a ' + BUZON_APP : 'código enviado al correo'}`);
    if (LOGIN_MODE === 'correo') console.log(`🔐 Ingreso con correo corporativo (${LOGIN_EMAILS.length ? LOGIN_EMAILS.length + ' correos autorizados' : LOGIN_DOMAINS.map(d => '@' + d).join(', ')})`);
    if (LOGIN_MODE === 'correo' && LOGIN_METODO === 'codigo' && !puedeEnviarCorreo()) console.warn('⚠️ El ingreso es por correo pero la app no puede enviar correos: nadie podrá recibir el código.');
    if (BREVO_API_KEY && !BREVO_API_KEY.startsWith('xkeysib-')) console.warn(`⚠️ BREVO_API_KEY no parece una clave de API de Brevo (debe empezar por "xkeysib-", la tuya empieza por "${BREVO_API_KEY.slice(0, 9)}"). ${BREVO_API_KEY.startsWith('xsmtpsib-') ? 'Esa es una clave SMTP: genera una en SMTP & API → API Keys.' : ''}`);
    console.log(BREVO_API_KEY ? `✉️ Correos salen por Brevo desde ${REMITENTE}` : (IS_CLOUD ? '⚠️ Sin BREVO_API_KEY: en el plan gratis de Render el SMTP está bloqueado y los correos no van a salir.' : '✉️ Correos salen por SMTP'));
    if (IS_CLOUD && !accesoProtegido()) console.warn('⚠️ La app está abierta para cualquiera con el enlace (configura LOGIN_MODE=correo o APP_PASSWORD).');
    if (IS_CLOUD && !SYNC_TOKEN) console.warn('⚠️ Falta la variable SYNC_TOKEN: el agente no podrá enviar datos.');
    console.log('=======================================================');
}

arrancar();
