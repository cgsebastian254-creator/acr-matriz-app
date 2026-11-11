// =====================================================================
// Evaluación 360° de la matriz de polivalencia
//
// Cada técnico es calificado por cuatro fuentes, con la misma escala 1-4 y las
// mismas acciones de su especialidad:
//   auto       el propio técnico
//   par        un compañero de su especialidad
//   supervisor el supervisor de línea
//   ingenieria ingenieros de mantenimiento por correo (o la calificación en la app, ⭐ Calificar)
// El nivel final de cada acción es el promedio ponderado de las fuentes que la calificaron.
//
// Los evaluadores no necesitan cuenta: reciben un enlace personal (/evaluar/<token>)
// que solo abre el cuestionario de ese técnico.
// =====================================================================
const crypto = require('crypto');
const docs = require('./docs');
const T = require('./tecnicos');
const { hoyISO, textoFecha } = require('./fechas');

const TIPOS = {
    auto: { nombre: 'Autoevaluación', corto: 'Auto' },
    par: { nombre: 'Evaluación de compañero', corto: 'Compañero' },
    supervisor: { nombre: 'Evaluación del supervisor', corto: 'Supervisor' },
    ingenieria: { nombre: 'Evaluación de ingeniería', corto: 'Ingeniería' }
};
const PESOS_DEFECTO = { auto: 0.10, par: 0.20, supervisor: 0.30, ingenieria: 0.40 };

function datos() {
    const d = docs.obtener('evaluacion360', () => ({ campanas: [], solicitudes: [] }));
    d.campanas = d.campanas || []; d.solicitudes = d.solicitudes || [];
    return d;
}
function guardar(d) { return docs.guardar('evaluacion360', d); }
function token() { return crypto.randomBytes(18).toString('base64url'); }
function texto(v, max = 120) { return String(v == null ? '' : v).trim().slice(0, max); }
function correoValido(c) { return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(c); }

function limpiarPesos(p) {
    const r = {};
    for (const k of Object.keys(PESOS_DEFECTO)) {
        let v = Number(String(p && p[k] != null ? p[k] : PESOS_DEFECTO[k]).replace(',', '.'));
        if (v > 1) v = v / 100;
        r[k] = Math.max(0, Math.min(1, v || 0));
    }
    const suma = Object.values(r).reduce((a, b) => a + b, 0);
    if (!suma) return { ...PESOS_DEFECTO };
    return r;
}

// Niveles finales por acción y puntaje ponderado de un técnico en una campaña
function resultadoTecnico(t, campana, solicitudes, habilidades) {
    const habs = habilidades.filter(h => h.rol === t.rol);
    const fuentes = {};
    for (const tipo of ['auto', 'par', 'supervisor', 'ingenieria']) {
        const respondidas = solicitudes.filter(s => s.campanaId === campana.id && s.tecnicoId === t.id && s.tipo === tipo && s.estado === 'respondida');
        if (!respondidas.length) continue;
        // Si hay varios compañeros o supervisores, se promedian entre ellos
        const n = {};
        for (const h of habs) {
            const v = respondidas.map(s => Number((s.niveles || {})[h.id])).filter(x => x >= 1 && x <= 4);
            if (v.length) n[h.id] = v.reduce((a, b) => a + b, 0) / v.length;
        }
        fuentes[tipo] = n;
    }
    // Ingeniería: lo que respondieron los ingenieros por correo; lo que falte se toma de la calificación en la app
    const enApp = T.nivelesActuales(t);
    fuentes.ingenieria = { ...enApp, ...(fuentes.ingenieria || {}) };
    const pesos = campana.pesos || PESOS_DEFECTO;
    const final = {};
    for (const h of habs) {
        let suma = 0, w = 0;
        for (const [tipo, niveles] of Object.entries(fuentes)) {
            const v = Number(niveles[h.id]);
            if (v >= 1 && v <= 4 && pesos[tipo] > 0) { suma += v * pesos[tipo]; w += pesos[tipo]; }
        }
        if (w) final[h.id] = suma / w;
    }
    const puntajeDe = niveles => {
        let s = 0, p = 0;
        for (const h of habs) { const v = Number(niveles[h.id]); if (v) { s += v / 4 * h.peso; p += h.peso; } }
        return p ? s / p : null;
    };
    return {
        final,
        fuentes,
        puntajes: Object.fromEntries([...Object.entries(fuentes).map(([k, v]) => [k, puntajeDe(v)]), ['final', puntajeDe(final)]])
    };
}

function resumenCampana(campana, d, tecDatos) {
    const sols = d.solicitudes.filter(s => s.campanaId === campana.id);
    const tecnicos = tecDatos.tecnicos.filter(t => t.activo !== false);
    return tecnicos.map(t => {
        const r = resultadoTecnico(t, campana, sols, tecDatos.habilidades);
        const mias = sols.filter(s => s.tecnicoId === t.id).map(s => ({
            token: s.token, tipo: s.tipo, estado: s.estado, evaluador: s.evaluador, enviada: s.enviada || null, respondida: s.respondida || null
        }));
        return { tecnicoId: t.id, solicitudes: mias, puntajes: r.puntajes, final: r.final, fuentes: r.fuentes };
    });
}

function nuevaSolicitud(d, campanaId, tecnicoId, tipo, evaluador) {
    // Se reemplaza una asignación pendiente del mismo tipo (las respondidas se conservan)
    d.solicitudes = d.solicitudes.filter(s => !(s.campanaId === campanaId && s.tecnicoId === tecnicoId && s.tipo === tipo && s.estado !== 'respondida'));
    const s = {
        token: token(), campanaId, tecnicoId, tipo, estado: 'pendiente', creada: new Date().toISOString(),
        evaluador: { nombre: texto(evaluador.nombre, 80), correo: texto(evaluador.correo, 120).toLowerCase(), telefono: texto(evaluador.telefono, 30), tecnicoId: evaluador.tecnicoId || '' },
        niveles: {}, comentario: ''
    };
    d.solicitudes.push(s);
    return s;
}

// Compañeros al azar dentro de la misma especialidad y, si alcanza, de la misma área (TM / Conversión),
// sin que nadie se evalúe a sí mismo
// Especialidades que, si no tienen compañero de su misma especialidad y área, las evalúa un mecánico
const APOYO_MECANICO = ['Instrumentista', 'Lubricador'];

function asignarCompaneros(lista, cargaPrevia) {
    const grupos = {};
    lista.forEach(t => { const k = t.rol + '|' + (t.area || ''); (grupos[k] = grupos[k] || []).push(t); });
    const pares = [];
    const carga = {};   // evaluaciones de compañero que ya tiene cada evaluador
    const sumar = ev => { carga[ev.id] = (carga[ev.id] || (cargaPrevia && cargaPrevia(ev.id)) || 0) + 1; };
    const rueda = g => { const m = g.slice().sort(() => Math.random() - 0.5); m.forEach((t, i) => { const ev = m[(i + 1) % m.length]; pares.push([t, ev]); sumar(ev); }); };
    const porRol = {};
    const apoyo = [];
    for (const [k, g] of Object.entries(grupos)) {
        const rol = k.split('|')[0];
        porRol[rol] = porRol[rol] || { grupos: [], sueltos: [] };
        if (g.length >= 2) porRol[rol].grupos.push(g);
        else if (APOYO_MECANICO.includes(rol)) apoyo.push(g[0]);
        else porRol[rol].sueltos.push(...g);
    }
    for (const { grupos: gs, sueltos } of Object.values(porRol)) {
        // Grupos de una sola persona se juntan con el resto de su especialidad
        if (sueltos.length) { if (gs.length) gs[0].push(...sueltos); else gs.push(sueltos); }
        gs.filter(g => g.length >= 2).forEach(rueda);
    }
    // Instrumentista o lubricador sin compañero en su área: lo evalúa el mecánico de su área con menos carga
    const mecanicos = lista.filter(t => t.rol === 'Mecánico');
    for (const t of apoyo) {
        let opciones = mecanicos.filter(m => (m.area || '') === (t.area || ''));
        if (!opciones.length) opciones = mecanicos;
        if (!opciones.length) continue;
        const cargaDe = m => carga[m.id] || (cargaPrevia && cargaPrevia(m.id)) || 0;
        const minimo = Math.min(...opciones.map(cargaDe));
        const menos = opciones.filter(m => cargaDe(m) === minimo);
        const ev = menos[Math.floor(Math.random() * menos.length)];
        pares.push([t, ev]); sumar(ev);
    }
    return pares;   // [evaluado, evaluador]
}

function htmlCorreo(evaluador, pendientes, campana, recordatorio) {
    const filas = pendientes.map(p => `<tr>
        <td style="padding:10px;border-bottom:1px solid #e2e8f0;font-size:14px;"><b>${esc(TIPOS[p.tipo].nombre)}</b><br><span style="color:#475569;">${p.tipo === 'auto' ? 'Califícate a ti mismo' : 'Técnico a evaluar: ' + esc(p.tecnico)} · ${esc(p.rol)}</span></td>
        <td style="padding:10px;border-bottom:1px solid #e2e8f0;text-align:right;"><a href="${esc(p.url)}" style="background:#10b981;color:#fff;text-decoration:none;padding:9px 16px;border-radius:8px;font-weight:bold;font-size:14px;">Evaluar</a></td></tr>`).join('');
    return `<div style="font-family:Segoe UI,Arial,sans-serif;color:#0f172a;max-width:620px;">
<h2 style="color:#047857;margin:0 0 6px;">Matriz de Polivalencia · ${esc(campana.nombre)}</h2>
<p style="font-size:14px;">Hola ${esc(evaluador.nombre || '')}, ${recordatorio ? 'te recordamos que aún tienes' : 'tienes'} ${pendientes.length} ${pendientes.length === 1 ? 'evaluación pendiente' : 'evaluaciones pendientes'}. Cada enlace abre el cuestionario en el celular o el computador; no necesitas usuario ni contraseña.</p>
${campana.limite ? `<p style="font-size:15px;background:#fef3c7;border:1px solid #f59e0b;border-radius:8px;padding:10px 12px;color:#92400e;"><b>⏰ Plazo para responder: hasta el ${esc(fechaLarga(campana.limite))}.</b> Después de esa fecha el enlace se cierra.</p>` : ''}
<table style="border-collapse:collapse;width:100%;margin:12px 0;">${filas}</table>
<p style="font-size:13px;color:#475569;">Escala: 1 No sabe · 2 Básico (requiere acompañamiento) · 3 Autónomo · 4 Experto (forma a otros). Califica con honestidad: el resultado sirve para planear formación y rotaciones.</p>
<p style="font-size:11px;color:#94a3b8;">Mensaje automático de la Matriz de ACRs · Planta Conversión. El enlace es personal, no lo reenvíes.</p></div>`;
}
function fechaLarga(iso) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(iso || '')) return '';
    const [a, m, d] = iso.split('-').map(Number);
    const f = new Date(Date.UTC(a, m - 1, d, 12));
    const dias = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
    const meses = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
    return `${dias[f.getUTCDay()]} ${d} de ${meses[m - 1]}`;
}
const vencida = c => !!(c && c.limite && hoyISO() > c.limite);
function esc(v) { return String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

// ---------------------------------------------------------------
// Página pública del cuestionario
// ---------------------------------------------------------------
function paginaFormulario(s, t, habs, campana) {
    const datosJS = JSON.stringify({
        token: s.token, tipo: s.tipo, niveles: s.niveles || {}, comentario: s.comentario || '', respondida: s.estado === 'respondida',
        habilidades: habs.map(h => ({ id: h.id, categoria: h.categoria, nombre: h.nombre, descripcion: h.descripcion }))
    }).replace(/</g, '\\u003c');
    const quien = s.tipo === 'auto' ? `Autoevaluación de <b>${esc(t.nombre)}</b>` : `Técnico a evaluar: <b>${esc(t.nombre)}</b>`;
    return `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="#0f172a"><title>Evaluación · ${esc(t.nombre)}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}body{font-family:Segoe UI,Inter,Arial,sans-serif;background:#0f172a;color:#f1f5f9;padding:16px;padding-bottom:110px}
.caja{max-width:760px;margin:0 auto}.cab{background:#1e293b;border:1px solid #334155;border-radius:16px;padding:18px;margin-bottom:14px}
.logo{display:inline-block;background:#fff;border-radius:8px;padding:5px 10px;margin-bottom:12px}.logo img{height:26px;display:block}
h1{font-size:20px;margin-bottom:4px}.sub{color:#94a3b8;font-size:13px}.tipo{display:inline-block;margin-top:10px;background:rgba(16,185,129,.15);color:#6ee7b7;border:1px solid rgba(16,185,129,.4);border-radius:999px;padding:4px 12px;font-size:12px;font-weight:700}
.escala{display:grid;grid-template-columns:repeat(4,1fr);gap:6px;margin-top:12px;font-size:11.5px;text-align:center}.escala span{border-radius:8px;padding:6px 4px;font-weight:700;line-height:1.25}.escala em{display:block;font-style:normal;font-weight:500;font-size:10.5px;opacity:.95}
.tit{display:block;font-size:11px;font-weight:700;color:#94a3b8;text-transform:uppercase;letter-spacing:.04em;margin-bottom:3px}
.n1{background:#ef4444}.n2{background:#f59e0b}.n3{background:#65a30d}.n4{background:#10b981}
.cat{background:#1e293b;border:1px solid #334155;border-radius:14px;padding:4px 14px 8px;margin-bottom:12px}.cat h2{font-size:11.5px;text-transform:uppercase;letter-spacing:.06em;color:#22d3ee;padding:10px 0 4px}
.fila{padding:11px 0;border-top:1px dashed rgba(148,163,184,.2)}.fila:first-of-type{border-top:none}.fila b{display:block;font-size:14.5px}.fila small{display:block;color:#94a3b8;font-size:12.5px;margin:2px 0 8px}
.bot{display:grid;grid-template-columns:repeat(4,1fr);gap:6px}.fila .bot button small{display:block;font-size:10px;font-weight:600;margin:1px 0 0;color:inherit}.bot button{height:52px;line-height:1.05;border-radius:10px;border:1px solid #334155;background:#0f172a;color:#94a3b8;font-size:18px;font-weight:800;cursor:pointer}
.bot button.sel{color:#fff;border-color:transparent;transform:scale(1.04)}.bot button.sel.n1{background:#ef4444}.bot button.sel.n2{background:#f59e0b}.bot button.sel.n3{background:#65a30d}.bot button.sel.n4{background:#10b981}
textarea{width:100%;min-height:90px;border-radius:10px;border:1px solid #334155;background:#0f172a;color:#f1f5f9;padding:10px;font:inherit;font-size:15px}
.pie{position:fixed;left:0;right:0;bottom:0;background:rgba(15,23,42,.96);border-top:1px solid #334155;padding:12px 16px}.pie div{max-width:760px;margin:0 auto;display:flex;align-items:center;gap:12px}
.barra{flex:1;height:8px;background:#334155;border-radius:999px;overflow:hidden}.barra span{display:block;height:100%;background:linear-gradient(90deg,#3b82f6,#10b981);width:0}
.enviar{background:#10b981;color:#fff;border:0;border-radius:10px;padding:13px 18px;font-size:15px;font-weight:700;cursor:pointer}.enviar:disabled{opacity:.5}
.ok{background:rgba(16,185,129,.15);border:1px solid rgba(16,185,129,.4);border-radius:12px;padding:14px;margin-bottom:14px;font-size:14px}
</style></head><body><div class="caja">
<div class="cab"><div class="logo"><img src="/arbex_logo.png" alt="Arbex"></div>
<h1>Matriz de Polivalencia</h1><p class="sub">${esc(campana.nombre)} · ${quien} · ${esc(t.rol)}</p>
<span class="tipo">${esc(TIPOS[s.tipo].nombre)}</span>
<p class="sub" style="margin-top:10px">🔒 Tus respuestas son confidenciales: solo las ve el equipo de ingeniería de mantenimiento. El técnico evaluado no ve quién lo calificó.</p>
${campana.limite ? `<p class="sub" style="margin-top:10px;color:#fbbf24;font-weight:700">⏰ Plazo para responder: hasta el ${esc(fechaLarga(campana.limite))}</p>` : ''}
<p class="sub" style="margin-top:10px">Lee cada enunciado y elige el nivel que mejor describe ${s.tipo === 'auto' ? 'cómo lo haces tú hoy' : 'cómo lo hace hoy ' + esc(t.nombre)}:</p>
<div class="escala"><span class="n1">1 No sabe<em>No lo conoce o no lo hace</em></span><span class="n2">2 Básico<em>Lo hace con ayuda o supervisión</em></span><span class="n3">3 Autónomo<em>Lo hace bien solo</em></span><span class="n4">4 Experto<em>Lo domina y puede enseñarlo</em></span></div></div>
<div id="aviso"></div><div id="preguntas"></div>
<div class="cat"><h2>Comentarios (opcional)</h2><textarea id="comentario" placeholder="Fortalezas, oportunidades de mejora, formación recomendada..."></textarea></div>
</div>
<div class="pie"><div><div class="barra"><span id="barra"></span></div><small id="cuenta"></small><button class="enviar" id="enviar" onclick="enviar()">Enviar evaluación</button></div></div>
<script>
const D=${datosJS};const N=D.niveles;
function e(v){return String(v==null?'':v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
function pintar(){const cats=[...new Set(D.habilidades.map(h=>h.categoria))];
document.getElementById('preguntas').innerHTML=cats.map(c=>'<div class="cat"><h2>'+e(c)+'</h2>'+D.habilidades.filter(h=>h.categoria===c).map(h=>'<div class="fila"><span class="tit">'+e(h.nombre)+'</span><b>'+e(h.descripcion||h.nombre)+'</b><small></small><div class="bot">'+[1,2,3,4].map(v=>'<button class="n'+v+(N[h.id]==v?' sel':'')+'" onclick="elegir(\\''+h.id+'\\','+v+')">'+v+'<small>'+['','No sabe','Básico','Autónomo','Experto'][v]+'</small></button>').join('')+'</div></div>').join('')+'</div>').join('');
const hechas=D.habilidades.filter(h=>N[h.id]).length;document.getElementById('barra').style.width=(hechas/D.habilidades.length*100)+'%';
document.getElementById('cuenta').textContent=hechas+'/'+D.habilidades.length;document.getElementById('enviar').disabled=hechas<D.habilidades.length;}
function elegir(id,v){N[id]=v;pintar();try{localStorage.setItem('ev-'+D.token,JSON.stringify(N))}catch(x){}}
async function enviar(){const b=document.getElementById('enviar');b.disabled=true;b.textContent='Enviando…';
try{const r=await fetch(location.pathname,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({niveles:N,comentario:document.getElementById('comentario').value})});const j=await r.json();
if(!r.ok)throw new Error(j.error||'Error');document.getElementById('aviso').innerHTML='<div class="ok">✅ <b>¡Gracias! Tu evaluación quedó guardada.</b><br>Si necesitas corregir algo, cambia las respuestas y vuelve a enviar.</div>';window.scrollTo(0,0);b.textContent='Actualizar evaluación';}
catch(x){alert('No se pudo enviar: '+x.message+'. Revisa tu conexión e intenta de nuevo.');b.textContent='Enviar evaluación'}b.disabled=false;}
try{const g=JSON.parse(localStorage.getItem('ev-'+D.token)||'null');if(g&&!D.respondida)Object.assign(N,g)}catch(x){}
document.getElementById('comentario').value=D.comentario;
if(D.respondida){document.getElementById('aviso').innerHTML='<div class="ok">✅ Ya enviaste esta evaluación. Puedes revisarla y volver a enviarla si quieres corregir algo.</div>';document.getElementById('enviar').textContent='Actualizar evaluación'}
pintar();
</script></body></html>`;
}

function paginaMensaje(titulo, mensaje) {
    return `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(titulo)}</title>
<style>body{font-family:Segoe UI,Arial,sans-serif;background:#0f172a;color:#f1f5f9;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:16px}div{max-width:420px;background:#1e293b;border:1px solid #334155;border-radius:16px;padding:24px;text-align:center}h1{font-size:19px;margin-bottom:8px}p{color:#94a3b8;font-size:14px}</style>
</head><body><div><h1>${esc(titulo)}</h1><p>${esc(mensaje)}</p></div></body></html>`;
}

// ---------------------------------------------------------------
// Rutas públicas (sin sesión): /evaluar/<token>
// ---------------------------------------------------------------
function manejarPublico(req, res, pathname, ctx) {
    const m = pathname.match(/^\/evaluar\/([A-Za-z0-9_-]{16,40})$/);
    if (!m) return false;
    const d = datos();
    const s = d.solicitudes.find(x => x.token === m[1]);
    const html = (code, cuerpo) => { res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' }); res.end(cuerpo); };
    if (!s) { html(404, paginaMensaje('Enlace no válido', 'Este enlace de evaluación no existe o fue reemplazado. Pide a mantenimiento un enlace nuevo.')); return true; }
    const campana = d.campanas.find(c => c.id === s.campanaId);
    const tecDatos = ctx.datosTecnicos();
    const t = tecDatos.tecnicos.find(x => x.id === s.tecnicoId);
    if (!campana || !t) { html(404, paginaMensaje('Evaluación no disponible', 'El técnico o la evaluación ya no existen.')); return true; }
    if (vencida(campana)) { html(410, paginaMensaje('Plazo vencido', `El plazo para responder la evaluación "${campana.nombre}" fue hasta el ${fechaLarga(campana.limite)}. Si necesitas responderla, comunícate con ingeniería de mantenimiento.`)); return true; }
    if (campana.cerrada) { html(410, paginaMensaje('Evaluación cerrada', `La evaluación "${campana.nombre}" ya se cerró. Gracias por participar.`)); return true; }
    const habs = tecDatos.habilidades.filter(h => h.rol === t.rol);
    if (req.method === 'GET') { html(200, paginaFormulario(s, t, habs, campana)); return true; }
    if (req.method === 'POST') {
        ctx.readBody(req, 64 * 1024, async body => {
            let p;
            try { p = JSON.parse(body || '{}'); } catch (e) { return ctx.sendJson(res, 400, { error: 'Datos inválidos' }); }
            const niveles = {};
            for (const h of habs) { const v = Number((p.niveles || {})[h.id]); if (v >= 1 && v <= 4) niveles[h.id] = v; }
            if (Object.keys(niveles).length < habs.length) return ctx.sendJson(res, 400, { error: 'Faltan acciones por calificar' });
            s.niveles = niveles;
            s.comentario = texto(p.comentario, 2000);
            s.estado = 'respondida';
            s.respondida = new Date().toISOString();
            await guardar(d);
            // Aviso sin nombres: nadie que tenga la app abierta puede saber quién calificó a quién
            ctx.broadcastEvent({ type: 'tecnicos_updated', user: 'Evaluación 360°', message: 'Llegó una evaluación nueva' });
            ctx.sendJson(res, 200, { success: true });
        });
        return true;
    }
    return false;
}

// ---------------------------------------------------------------
// Rutas de la app (con sesión): /api/360/...
// ---------------------------------------------------------------
function manejar(req, res, pathname, url, sesion, ctx) {
    if (!pathname.startsWith('/api/360')) return false;
    const { sendJson, readBody } = ctx;
    const usuario = String((sesion && (sesion.nombre || sesion.correo)) || 'Usuario');
    const json = fn => readBody(req, 1024 * 1024, async body => {
        let p;
        try { p = body ? JSON.parse(body) : {}; } catch (e) { return sendJson(res, 400, { error: 'Datos inválidos.' }); }
        try { await fn(p); } catch (e) { sendJson(res, 400, { error: e.message }); }
    });
    const aviso = msg => ctx.broadcastEvent({ type: 'tecnicos_updated', user: usuario, message: msg });
    const base = (ctx.urlPublica() || '').replace(/\/+$/, '');

    if (pathname === '/api/360' && req.method === 'GET') {
        const d = datos();
        const id = url.searchParams.get('campana');
        const campana = d.campanas.find(c => c.id === id) || d.campanas[d.campanas.length - 1] || null;
        sendJson(res, 200, {
            campanas: d.campanas.map(c => ({ id: c.id, nombre: c.nombre, periodo: c.periodo, creada: c.creada, cerrada: !!c.cerrada, pesos: c.pesos })),
            campana: campana ? { ...campana } : null,
            tipos: TIPOS, pesosDefecto: PESOS_DEFECTO, urlBase: base,
            resultados: campana ? resumenCampana(campana, d, ctx.datosTecnicos()) : []
        });
        return true;
    }
    if (pathname === '/api/360/campana' && req.method === 'POST') {
        json(async p => {
            const d = datos();
            let c = p.id ? d.campanas.find(x => x.id === p.id) : null;
            if (p.eliminar) {
                if (!c) throw new Error('Esa evaluación no existe.');
                d.campanas = d.campanas.filter(x => x !== c);
                d.solicitudes = d.solicitudes.filter(s => s.campanaId !== c.id);
                await guardar(d);
                aviso(`Eliminó la evaluación "${c.nombre}"`);
                sendJson(res, 200, { success: true });
                return;
            }
            if (!c) {
                c = { id: 'C-' + Date.now().toString(36), nombre: texto(p.nombre, 80) || `Evaluación ${T.periodoDe(hoyISO())}`, periodo: T.periodoDe(hoyISO()), creada: new Date().toISOString(), creadaPor: usuario, pesos: { ...PESOS_DEFECTO } };
                d.campanas.push(c);
            }
            if (p.nombre !== undefined && texto(p.nombre, 80)) c.nombre = texto(p.nombre, 80);
            if (p.pesos) c.pesos = limpiarPesos(p.pesos);
            if (p.cerrada !== undefined) c.cerrada = !!p.cerrada;
            if (p.limite !== undefined) {
                if (p.limite && !/^\d{4}-\d{2}-\d{2}$/.test(p.limite)) throw new Error('Fecha límite inválida.');
                c.limite = p.limite || '';
            }
            await guardar(d);
            aviso(`Actualizó la evaluación "${c.nombre}"`);
            sendJson(res, 200, { success: true, campana: c });
        });
        return true;
    }
    if (pathname === '/api/360/asignar' && req.method === 'POST') {
        json(async p => {
            const d = datos();
            const c = d.campanas.find(x => x.id === p.campanaId);
            if (!c) throw new Error('Esa evaluación no existe.');
            const tecDatos = ctx.datosTecnicos();
            const porId = Object.fromEntries(tecDatos.tecnicos.map(t => [t.id, t]));
            const activos = tecDatos.tecnicos.filter(t => t.activo !== false && (!p.rol || p.rol === 'TODOS' || t.rol === p.rol) && (!p.area || p.area === 'TODAS' || (t.area || '') === p.area));
            let n = 0;
            const yaTiene = (tid, tipo) => d.solicitudes.some(s => s.campanaId === c.id && s.tecnicoId === tid && s.tipo === tipo);
            if (p.modo === 'auto') {
                for (const t of activos) {
                    if (!p.reemplazar && yaTiene(t.id, 'auto')) continue;
                    nuevaSolicitud(d, c.id, t.id, 'auto', { nombre: t.nombre, correo: t.correo, telefono: t.telefono, tecnicoId: t.id }); n++;
                }
            } else if (p.modo === 'companeros') {
                const candidatos = activos.filter(t => p.reemplazar || !yaTiene(t.id, 'par'));
                const todosRol = tecDatos.tecnicos.filter(t => t.activo !== false);
                // Se arma la rueda con todos los de cada especialidad para que nadie se evalúe a sí mismo
                const cargaPrevia = id => d.solicitudes.filter(s => s.campanaId === c.id && s.tipo === 'par' && s.evaluador && s.evaluador.tecnicoId === id).length;
                for (const [evaluado, evaluador] of asignarCompaneros(todosRol.filter(t => activos.includes(t)), cargaPrevia)) {
                    if (!candidatos.includes(evaluado)) continue;
                    nuevaSolicitud(d, c.id, evaluado.id, 'par', { nombre: evaluador.nombre, correo: evaluador.correo, telefono: evaluador.telefono, tecnicoId: evaluador.id }); n++;
                }
            } else if (p.modo === 'ingenieros') {
                // Reparte por área: cada técnico queda con un ingeniero de su área, parejo y mezclando especialidades
                const ings = (Array.isArray(p.ingenieros) ? p.ingenieros : []).map(x => ({
                    nombre: texto(x.nombre, 80), correo: texto(x.correo, 120).toLowerCase(), area: T.normalizarArea ? T.normalizarArea(x.area || '') : texto(x.area, 40)
                })).filter(x => x.nombre && x.correo);
                if (!ings.length) throw new Error('Escribe al menos un ingeniero con nombre y correo.');
                c.ingenieros = ings;
                const cargaDe = correo => d.solicitudes.filter(s => s.campanaId === c.id && s.tipo === 'ingenieria' && s.evaluador && s.evaluador.correo === correo).length;
                const carga = Object.fromEntries(ings.map(i => [i.correo, cargaDe(i.correo)]));
                const pend = activos.filter(t => p.reemplazar || !yaTiene(t.id, 'ingenieria'))
                    .sort((a, b) => a.rol.localeCompare(b.rol) || a.nombre.localeCompare(b.nombre, 'es'));
                let sinIngeniero = 0;
                for (const t of pend) {
                    let opciones = ings.filter(i => i.area && i.area === (t.area || ''));
                    if (!opciones.length) opciones = ings.filter(i => !i.area);
                    if (!opciones.length) { sinIngeniero++; continue; }
                    const ing = opciones.reduce((m, i) => carga[i.correo] < carga[m.correo] ? i : m, opciones[0]);
                    carga[ing.correo]++;
                    nuevaSolicitud(d, c.id, t.id, 'ingenieria', { nombre: ing.nombre, correo: ing.correo }); n++;
                }
                await guardar(d);
                aviso(`Asignó ${n} evaluaciones de ingeniería en "${c.nombre}"`);
                return sendJson(res, 200, { success: true, asignadas: n, sinIngeniero, reparto: ings.map(i => ({ nombre: i.nombre, area: i.area, total: carga[i.correo] })) });
            } else if (p.modo === 'supervisores-perfil') {
                // Cada técnico con el supervisor registrado en su perfil
                let sinSupervisor = 0;
                for (const t of activos) {
                    if (!t.supervisor) { sinSupervisor++; continue; }
                    if (!p.reemplazar && yaTiene(t.id, 'supervisor')) continue;
                    nuevaSolicitud(d, c.id, t.id, 'supervisor', { nombre: t.supervisor, correo: t.supervisorCorreo, telefono: t.supervisorTelefono }); n++;
                }
                await guardar(d);
                aviso(`Asignó ${n} evaluaciones de supervisor en "${c.nombre}"`);
                return sendJson(res, 200, { success: true, asignadas: n, sinSupervisor });
            } else if (p.modo === 'supervisor') {
                const nombre = texto(p.nombre, 80);
                const correo = texto(p.correo, 120).toLowerCase();
                if (!nombre) throw new Error('Escribe el nombre del supervisor.');
                if (correo && !correoValido(correo)) throw new Error('El correo del supervisor no es válido.');
                const ids = Array.isArray(p.tecnicos) && p.tecnicos.length ? p.tecnicos : activos.map(t => t.id);
                for (const id of ids) {
                    if (!porId[id]) continue;
                    if (!p.reemplazar && yaTiene(id, 'supervisor')) continue;
                    nuevaSolicitud(d, c.id, id, 'supervisor', { nombre, correo, telefono: texto(p.telefono, 30) }); n++;
                }
            } else if (p.modo === 'manual') {
                const t = porId[p.tecnicoId];
                if (!t || !TIPOS[p.tipo]) throw new Error('Asignación inválida.');
                const ev = p.evaluadorTecnicoId ? porId[p.evaluadorTecnicoId] : null;
                if (p.tipo === 'par' && ev && ev.id === t.id) throw new Error('Un técnico no puede ser su propio compañero evaluador.');
                const evaluador = ev ? { nombre: ev.nombre, correo: ev.correo, telefono: ev.telefono, tecnicoId: ev.id } : { nombre: p.nombre, correo: p.correo, telefono: p.telefono };
                if (!evaluador.nombre) throw new Error('Falta el evaluador.');
                nuevaSolicitud(d, c.id, t.id, p.tipo, evaluador); n++;
            } else throw new Error('Modo de asignación desconocido.');
            await guardar(d);
            aviso(`Asignó ${n} evaluaciones en "${c.nombre}"`);
            sendJson(res, 200, { success: true, asignadas: n });
        });
        return true;
    }
    if (pathname === '/api/360/quitar' && req.method === 'POST') {
        json(async p => {
            const d = datos();
            const antes = d.solicitudes.length;
            d.solicitudes = d.solicitudes.filter(s => s.token !== p.token);
            await guardar(d);
            sendJson(res, 200, { success: true, quitadas: antes - d.solicitudes.length });
        });
        return true;
    }
    if (pathname === '/api/360/enviar' && req.method === 'POST') {
        json(async p => {
            const d = datos();
            const c = d.campanas.find(x => x.id === p.campanaId);
            if (!c) throw new Error('Esa evaluación no existe.');
            const tecDatos = ctx.datosTecnicos();
            const porId = Object.fromEntries(tecDatos.tecnicos.map(t => [t.id, t]));
            const pend = d.solicitudes.filter(s => s.campanaId === c.id && s.estado !== 'respondida' && (!p.tokens || p.tokens.includes(s.token)) && (p.reenviar || !s.enviada));
            const porCorreo = {};
            let sinCorreo = 0;
            for (const s of pend) {
                const correo = s.evaluador.correo || (s.evaluador.tecnicoId && porId[s.evaluador.tecnicoId] && porId[s.evaluador.tecnicoId].correo) || '';
                if (!correoValido(correo)) { sinCorreo++; continue; }
                (porCorreo[correo] = porCorreo[correo] || { evaluador: s.evaluador, lista: [] }).lista.push(s);
            }
            let correos = 0;
            const porGrupo = { tecnicos: 0, supervisores: 0, ingenieros: 0 };
            for (const [correo, g] of Object.entries(porCorreo)) {
                const tipos = g.lista.map(s => s.tipo);
                porGrupo[tipos.includes('ingenieria') ? 'ingenieros' : tipos.includes('supervisor') ? 'supervisores' : 'tecnicos']++;
                const items = g.lista.map(s => ({ tipo: s.tipo, tecnico: porId[s.tecnicoId] ? porId[s.tecnicoId].nombre : '', rol: porId[s.tecnicoId] ? porId[s.tecnicoId].rol : '', url: `${base}/evaluar/${s.token}` }));
                const plazo = c.limite ? ` (plazo: ${fechaLarga(c.limite)})` : '';
                await ctx.enviarNotificacion({ para: [correo], cc: [], asunto: `${p.recordatorio ? 'Recordatorio: ' : ''}Evaluación de polivalencia: tienes ${items.length} ${items.length === 1 ? 'evaluación pendiente' : 'evaluaciones pendientes'}${plazo}`, html: htmlCorreo(g.evaluador, items, c, p.recordatorio), motivo: 'evaluacion-360' });
                g.lista.forEach(s => { s.enviada = new Date().toISOString(); });
                correos++;
            }
            await guardar(d);
            sendJson(res, 200, { success: true, correos, porGrupo, evaluaciones: pend.length - sinCorreo, sinCorreo });
        });
        return true;
    }
    if (pathname === '/api/360/exportar' && req.method === 'GET') {
        const d = datos();
        const c = d.campanas.find(x => x.id === url.searchParams.get('campana'));
        if (!c) { sendJson(res, 404, { error: 'No existe' }); return true; }
        const tecDatos = ctx.datosTecnicos();
        const XLSX = require('xlsx');
        const filas = [['Técnico', 'Especialidad', 'Categoría', 'Acción', 'Peso', 'Auto', 'Compañero', 'Supervisor', 'Ingeniería', 'Final ponderado']];
        const resumen = [['Técnico', 'Especialidad', 'Puntaje Auto', 'Puntaje Compañero', 'Puntaje Supervisor', 'Puntaje Ingeniería', 'Puntaje final ponderado']];
        const comentarios = [['Técnico', 'Tipo', 'Evaluador', 'Fecha', 'Comentario']];
        const r1 = v => v == null ? '' : Math.round(v * 100) / 100;
        const pc = v => v == null ? '' : Math.round(v * 1000) / 10;
        for (const t of tecDatos.tecnicos.filter(x => x.activo !== false).sort((a, b) => a.rol.localeCompare(b.rol) || a.nombre.localeCompare(b.nombre))) {
            const r = resultadoTecnico(t, c, d.solicitudes, tecDatos.habilidades);
            resumen.push([t.nombre, t.rol, pc(r.puntajes.auto), pc(r.puntajes.par), pc(r.puntajes.supervisor), pc(r.puntajes.ingenieria), pc(r.puntajes.final)]);
            for (const h of tecDatos.habilidades.filter(x => x.rol === t.rol)) {
                filas.push([t.nombre, t.rol, h.categoria, h.nombre, h.peso, r1((r.fuentes.auto || {})[h.id]), r1((r.fuentes.par || {})[h.id]), r1((r.fuentes.supervisor || {})[h.id]), r1((r.fuentes.ingenieria || {})[h.id]), r1(r.final[h.id])]);
            }
            d.solicitudes.filter(s => s.campanaId === c.id && s.tecnicoId === t.id && s.comentario).forEach(s => comentarios.push([t.nombre, TIPOS[s.tipo].nombre, s.evaluador.nombre, s.respondida ? textoFecha(s.respondida.slice(0, 10)) : '', s.comentario]));
        }
        const wb = XLSX.utils.book_new();
        const hoja = (aoa, nombre, anchos) => { const ws = XLSX.utils.aoa_to_sheet(aoa); ws['!cols'] = anchos.map(w => ({ wch: w })); XLSX.utils.book_append_sheet(wb, ws, nombre); };
        hoja(resumen, 'Resumen', [30, 16, 14, 18, 18, 18, 22]);
        hoja(filas, 'Detalle por acción', [30, 16, 24, 40, 8, 8, 12, 12, 12, 16]);
        hoja(comentarios, 'Comentarios', [30, 24, 26, 12, 80]);
        res.writeHead(200, { 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'Content-Disposition': `attachment; filename="Evaluacion_360_${c.periodo}.xlsx"`, 'Cache-Control': 'no-store' });
        res.end(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
        return true;
    }
    return false;
}

module.exports = { manejar, manejarPublico, resultadoTecnico, asignarCompaneros, TIPOS, PESOS_DEFECTO };
