// =====================================================================
// Notificaciones automáticas a los ingenieros
//
// 1. Recordatorio diario (por defecto 6:30 a. m., lunes a sábado): a cada ingeniero
//    le llega solo lo de sus líneas: pendientes de la reunión diaria no realizados,
//    pendientes de hoy, acciones de ACR vencidas y las que vencen pronto.
// 2. Cierre del día (por defecto 6:00 p. m.): si un pendiente con fecha de hoy (o
//    anterior) sigue sin realizarse, se avisa una sola vez al ingeniero de esa línea.
//
// El envío se hace con la función `enviar` que entrega server.js (Power Automate u otro).
// =====================================================================
const docs = require('./docs');
const { ahoraBogota, sumarDias, aISO, textoFecha, minutosDe } = require('./fechas');

// Por ahora la app trabaja solo ACR: los pendientes de reunión diaria no entran en los correos
const SOLO_ACR = process.env.INCLUIR_PENDIENTES_DIARIOS !== 'true';
const LINEAS = ['Forte', 'Futura', 'Hinnli', 'Pocket', 'Sincro 1', 'Sincro 2'];

function configPorDefecto() {
    return {
        ingenieros: [],               // { nombre, correo, lineas: ['Forte', ...] o ['Todas'] }
        copia: [],                    // correos que reciben copia de todo (opcional)
        recordatorio: { activo: true, hora: '06:30', dias: [1, 2, 3, 4, 5, 6], anticipacion: 3 },
        cierre: { activo: false, hora: '18:00', dias: [1, 2, 3, 4, 5, 6, 7] },
        estado: { ultimoRecordatorio: '', ultimoCierre: '', registro: [] }
    };
}

function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

function cubreLinea(ing, linea) {
    const l = ing.lineas || [];
    return !l.length || l.includes('Todas') || l.includes(linea);
}

function pendienteAbierto(d) {
    return !d.eliminado && d.estado !== 'Realizado';
}

function fechaCompromiso(d) {
    return d.fechaCompromiso || d.fechaISO || aISO(d.fecha) || '';
}

const TH = 'background:#1e3a8a;color:#fff;padding:7px;border:1px solid #cbd5e1;font-size:12px;text-align:left;';
const TD = 'padding:6px;border:1px solid #cbd5e1;font-size:12px;vertical-align:top;';
function tabla(columnas, filas) {
    if (!filas.length) return '';
    return `<table style="border-collapse:collapse;width:100%;font-family:Segoe UI,Arial,sans-serif;margin-bottom:6px;"><tr>${columnas.map(c => `<th style="${TH}">${esc(c)}</th>`).join('')}</tr>${filas.map(f => `<tr>${f.map(c => `<td style="${TD}">${c}</td>`).join('')}</tr>`).join('')}</table>`;
}
function marco(titulo, subtitulo, cuerpo, urlApp) {
    return `<div style="font-family:Segoe UI,Arial,sans-serif;color:#0f172a;">
<h2 style="color:#1e3a8a;margin:0 0 4px;">${esc(titulo)}</h2>
<p style="font-size:13px;margin:0 0 14px;color:#475569;">${esc(subtitulo)}</p>
${cuerpo}
${urlApp ? `<p style="font-size:12px;color:#64748b;margin-top:18px;">Actualiza el estado en <a href="${esc(urlApp)}">${esc(urlApp)}</a></p>` : ''}
<p style="font-size:11px;color:#94a3b8;">Mensaje automático de la Matriz de ACRs · Planta Conversión.</p>
</div>`;
}
function seccion(titulo, color, html) {
    return html ? `<h3 style="color:${color};margin:16px 0 6px;font-size:15px;">${esc(titulo)}</h3>${html}` : '';
}

// Contenido del recordatorio para un ingeniero (o para todas las líneas si no tiene asignadas)
function contenidoRecordatorio(ing, acrs, daily, hoy, anticipacion, urlApp) {
    const limite = sumarDias(hoy, anticipacion);
    const misPend = SOLO_ACR ? [] : daily.filter(d => pendienteAbierto(d) && cubreLinea(ing, d.linea));
    const atrasados = misPend.filter(d => fechaCompromiso(d) && fechaCompromiso(d) < hoy);
    const deHoy = misPend.filter(d => !fechaCompromiso(d) || fechaCompromiso(d) === hoy);
    const vencidas = [], proximas = [], inmediatas = [];
    for (const acr of acrs) {
        if (!cubreLinea(ing, acr.linea)) continue;
        for (const t of acr.tareas || []) {
            if (t.estado === 'Realizado') continue;
            const f = aISO(t.fechaCompromiso);
            const fila = { acr, t, f };
            if (t.estado === 'Vencido' || (f && f < hoy)) vencidas.push(fila);
            else if (f && f <= limite) proximas.push(fila);
            else if (t.tipo === 'Accion Inmediata') inmediatas.push(fila);
        }
    }
    const total = atrasados.length + deHoy.length + vencidas.length + proximas.length + inmediatas.length;
    if (!total) return null;
    const filaPend = d => [esc(textoFecha(fechaCompromiso(d))), esc(d.linea), `<b>${esc(d.equipo)}</b>`, esc(d.compromiso), esc(d.responsable), esc(d.prioridad || ''), esc(d.estado)];
    const filaACR = ({ acr, t }) => [esc(acr.linea), esc(acr.equipo), esc(acr.numeroACR ? 'N° ' + acr.numeroACR : acr.codigoACR), t.tipo === 'Accion Inmediata' ? '⚡ Inmediata' : 'Preventiva', esc(t.descripcion), esc(t.responsable), esc(t.fechaCompromiso || 'Sin fecha')];
    const colsPend = ['Fecha', 'Línea', 'Máquina', 'Pendiente', 'Responsable', 'Prioridad', 'Estado'];
    const colsACR = ['Línea', 'Equipo', 'ACR', 'Tipo', 'Acción', 'Responsable', 'Fecha compromiso'];
    const ordenF = (a, b) => String(a.f || '').localeCompare(String(b.f || ''));
    vencidas.sort(ordenF); proximas.sort(ordenF);
    const cuerpo =
        seccion(`⚠️ Pendientes de reunión diaria NO realizados (${atrasados.length})`, '#b91c1c', tabla(colsPend, atrasados.map(filaPend))) +
        seccion(`📋 Pendientes para hoy (${deHoy.length})`, '#1e3a8a', tabla(colsPend, deHoy.map(filaPend))) +
        seccion(`🔴 Acciones de ACR vencidas (${vencidas.length})`, '#b91c1c', tabla(colsACR, vencidas.map(filaACR))) +
        seccion(`🟡 Acciones de ACR que vencen en los próximos ${anticipacion} días (${proximas.length})`, '#b45309', tabla(colsACR, proximas.map(filaACR))) +
        (inmediatas.length ? seccion(`⚡ Acciones inmediatas abiertas sin vencer (${inmediatas.length})`, '#7c3aed', tabla(colsACR, inmediatas.slice(0, 40).map(filaACR))) : '');
    const lineas = (ing.lineas || []).length && !ing.lineas.includes('Todas') ? ing.lineas.join(', ') : 'todas las líneas';
    const asunto = `Pendientes ACR ${textoFecha(hoy)} - ${atrasados.length ? atrasados.length + ' no realizados, ' : ''}${vencidas.length} vencidas, ${proximas.length} por vencer`;
    return {
        asunto,
        html: marco('Pendientes de ACR', `Hola ${ing.nombre || ''}. Resumen del ${textoFecha(hoy)} para ${lineas}.`, cuerpo, urlApp),
        conteo: { atrasados: atrasados.length, hoy: deHoy.length, vencidas: vencidas.length, proximas: proximas.length }
    };
}

function contenidoCierre(ing, pendientes, hoy, urlApp) {
    const mios = pendientes.filter(d => cubreLinea(ing, d.linea));
    if (!mios.length) return null;
    const filas = mios.map(d => [esc(textoFecha(fechaCompromiso(d))), esc(d.linea), `<b>${esc(d.equipo)}</b>`, esc(d.compromiso), esc(d.responsable), esc(d.prioridad || ''), esc(d.estado), esc(d.observaciones || '')]);
    return {
        asunto: `⚠️ Pendientes NO realizados ${textoFecha(hoy)} - ${mios.length} ${mios.length === 1 ? 'pendiente' : 'pendientes'}`,
        html: marco('Pendientes no realizados', `Hola ${ing.nombre || ''}. Estos pendientes de la reunión diaria no se marcaron como realizados al cierre del ${textoFecha(hoy)}.`,
            tabla(['Fecha', 'Línea', 'Máquina', 'Pendiente', 'Responsable', 'Prioridad', 'Estado', 'Última observación'], filas), urlApp),
        ids: mios.map(d => d.id)
    };
}

function destinatarios(config) {
    const ings = (config.ingenieros || []).filter(i => i.correo);
    return ings;
}

function crearNotificador({ obtenerACRs, obtenerDaily, guardarDaily, enviar, urlApp, log = console.log }) {
    function config() { return docs.obtener('notificaciones', configPorDefecto); }

    function registrar(tipo, detalle) {
        const c = config();
        c.estado = c.estado || {};
        c.estado.registro = [{ fecha: new Date().toISOString(), tipo, detalle }, ...(c.estado.registro || [])].slice(0, 40);
    }

    async function enviarRecordatorios(hoy, soloPara) {
        const c = config();
        const ings = soloPara ? [soloPara] : destinatarios(c);
        let enviados = 0;
        for (const ing of ings) {
            const m = contenidoRecordatorio(ing, obtenerACRs(), obtenerDaily(), hoy, Number(c.recordatorio.anticipacion) || 3, urlApp());
            if (!m) continue;
            await enviar({ para: [ing.correo], cc: soloPara ? [] : (c.copia || []), asunto: m.asunto, html: m.html, motivo: 'recordatorio' });
            enviados++;
        }
        return enviados;
    }

    function pendientesSinCerrar(hoy) {
        return obtenerDaily().filter(d => pendienteAbierto(d) && fechaCompromiso(d) && fechaCompromiso(d) <= hoy && d.avisoNoRealizado !== fechaCompromiso(d));
    }

    async function enviarCierre(hoy) {
        const c = config();
        const pend = pendientesSinCerrar(hoy);
        if (!pend.length) return 0;
        let enviados = 0;
        const avisados = new Set();
        for (const ing of destinatarios(c)) {
            const m = contenidoCierre(ing, pend, hoy, urlApp());
            if (!m) continue;
            await enviar({ para: [ing.correo], cc: c.copia || [], asunto: m.asunto, html: m.html, motivo: 'no-realizado' });
            m.ids.forEach(id => avisados.add(id));
            enviados++;
        }
        // Se marcan aunque ninguna línea tenga ingeniero, para no reintentar cada minuto
        const daily = obtenerDaily();
        for (const d of daily) {
            if (!pend.some(p => p.id === d.id)) continue;
            d.avisoNoRealizado = fechaCompromiso(d);
            d.historial = d.historial || [];
            d.historial.unshift({
                fecha: new Date().toLocaleString('es-CO', { timeZone: 'America/Bogota' }), ts: Date.now(), usuario: 'Sistema',
                accion: avisados.has(d.id) ? 'No se realizó en la fecha: se notificó al ingeniero de la línea' : 'No se realizó en la fecha (sin ingeniero configurado para la línea)'
            });
        }
        guardarDaily(daily);
        return enviados;
    }

    let enCurso = false;
    async function revisar() {
        if (enCurso) return;
        enCurso = true;
        try {
            const c = config();
            const ahora = ahoraBogota();
            const st = c.estado = c.estado || {};
            const r = c.recordatorio || {};
            if (r.activo && st.ultimoRecordatorio !== ahora.fecha && (r.dias || []).includes(ahora.diaSemana) && ahora.minutos >= (minutosDe(r.hora) ?? 390)) {
                st.ultimoRecordatorio = ahora.fecha;          // se marca antes para no duplicar
                try {
                    const n = await enviarRecordatorios(ahora.fecha);
                    registrar('recordatorio', `${n} correos de recordatorio`);
                    log(`🔔 Recordatorio diario ${ahora.fecha}: ${n} correos`);
                } catch (e) {
                    st.ultimoRecordatorio = '';
                    log('❌ Falló el recordatorio diario: ' + e.message);
                }
                await docs.guardar('notificaciones', c);
            }
            const k = c.cierre || {};
            if (!SOLO_ACR && k.activo && st.ultimoCierre !== ahora.fecha && (k.dias || []).includes(ahora.diaSemana) && ahora.minutos >= (minutosDe(k.hora) ?? 1080)) {
                st.ultimoCierre = ahora.fecha;
                try {
                    const n = await enviarCierre(ahora.fecha);
                    registrar('no-realizado', `${n} avisos de pendientes no realizados`);
                    log(`⚠️ Cierre del día ${ahora.fecha}: ${n} avisos de pendientes no realizados`);
                } catch (e) {
                    st.ultimoCierre = '';
                    log('❌ Falló el aviso de pendientes no realizados: ' + e.message);
                }
                await docs.guardar('notificaciones', c);
            }
        } finally {
            enCurso = false;
        }
    }

    function vistaPrevia(tipo, ing) {
        const c = config();
        const hoy = ahoraBogota().fecha;
        const quien = ing || { nombre: 'Vista previa', lineas: ['Todas'] };
        if (tipo === 'cierre') return contenidoCierre(quien, obtenerDaily().filter(d => pendienteAbierto(d) && fechaCompromiso(d) && fechaCompromiso(d) <= hoy), hoy, urlApp());
        return contenidoRecordatorio(quien, obtenerACRs(), obtenerDaily(), hoy, Number(c.recordatorio.anticipacion) || 3, urlApp());
    }

    function iniciar() {
        revisar();
        setInterval(revisar, 60 * 1000);
    }

    return { config, revisar, iniciar, vistaPrevia, enviarRecordatorios, registrar };
}

function limpiarConfig(entrada, actual) {
    const c = { ...configPorDefecto(), ...actual };
    const correo = v => String(v || '').trim().toLowerCase();
    if (Array.isArray(entrada.ingenieros)) {
        c.ingenieros = entrada.ingenieros.map(i => ({
            nombre: String(i.nombre || '').trim().slice(0, 80),
            correo: correo(i.correo),
            lineas: (Array.isArray(i.lineas) ? i.lineas : []).filter(l => l === 'Todas' || LINEAS.includes(l))
        })).filter(i => i.correo).slice(0, 60);
    }
    if (entrada.copia !== undefined) c.copia = String(Array.isArray(entrada.copia) ? entrada.copia.join(',') : entrada.copia).split(/[;,\s]+/).map(correo).filter(Boolean).slice(0, 20);
    const dias = v => (Array.isArray(v) ? v : []).map(Number).filter(n => n >= 1 && n <= 7);
    const hora = (v, def) => /^\d{1,2}:\d{2}$/.test(String(v || '').trim()) ? String(v).trim().padStart(5, '0') : def;
    if (entrada.recordatorio) {
        c.recordatorio = {
            activo: entrada.recordatorio.activo !== false,
            hora: hora(entrada.recordatorio.hora, c.recordatorio.hora),
            dias: dias(entrada.recordatorio.dias),
            anticipacion: Math.min(30, Math.max(1, Number(entrada.recordatorio.anticipacion) || 3))
        };
    }
    if (entrada.cierre) {
        c.cierre = { activo: entrada.cierre.activo !== false, hora: hora(entrada.cierre.hora, c.cierre.hora), dias: dias(entrada.cierre.dias) };
    }
    return c;
}

module.exports = { crearNotificador, configPorDefecto, limpiarConfig, LINEAS, fechaCompromiso };
