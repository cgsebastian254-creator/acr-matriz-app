// =====================================================================
// Resumen de alertas (tareas vencidas, próximas a vencer y compromisos
// diarios pendientes) para enviar por correo desde la app.
// =====================================================================

function convertirFecha(texto) {
    const t = String(texto || '').trim().split(' ')[0].split('T')[0];
    let m = t.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{2,4})$/);
    if (m) {
        const anio = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
        return new Date(Date.UTC(anio, Number(m[2]) - 1, Number(m[1])));
    }
    m = t.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (m) return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
    return null;
}

// "Hoy" en Bogotá como fecha UTC a medianoche, para comparar solo días
function hoyBogota() {
    const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota', year: 'numeric', month: '2-digit', day: '2-digit' })
        .format(new Date()).split('-').map(Number);
    return new Date(Date.UTC(p[0], p[1] - 1, p[2]));
}

function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

function generarResumen(acrs, compromisosDiarios, { diasProximos = 7, urlApp = '' } = {}) {
    const hoy = hoyBogota();
    const limite = new Date(hoy.getTime() + diasProximos * 86400000);
    const vencidas = [];
    const proximas = [];

    for (const acr of acrs || []) {
        for (const t of acr.tareas || []) {
            if (t.estado === 'Realizado') continue;
            const f = convertirFecha(t.fechaCompromiso);
            const dias = f ? Math.round((hoy - f) / 86400000) : null;
            const fila = {
                linea: acr.linea, equipo: acr.equipo, acr: acr.numeroACR ? `N° ${acr.numeroACR}` : acr.codigoACR,
                tarea: t.descripcion, responsable: t.responsable, fecha: t.fechaCompromiso || 'Sin fecha',
                estado: t.estado, dias
            };
            if (t.estado === 'Vencido' || (f && f < hoy)) vencidas.push(fila);
            else if (f && f <= limite) proximas.push(fila);
        }
    }
    vencidas.sort((a, b) => (b.dias ?? -1) - (a.dias ?? -1));
    proximas.sort((a, b) => (b.dias ?? 0) - (a.dias ?? 0));
    const compromisos = (compromisosDiarios || []).filter(d => d.estado !== 'Realizado');

    const fecha = hoy.toISOString().slice(0, 10).split('-').reverse().join('/');
    const asunto = `Alertas ACR Planta Conversión - ${fecha} - ${vencidas.length} vencidas, ${proximas.length} próximas a vencer`;

    const th = 'background:#1e3a8a;color:#fff;padding:8px;border:1px solid #cbd5e1;font-size:12px;text-align:left;';
    const td = 'padding:7px;border:1px solid #cbd5e1;font-size:12px;vertical-align:top;';
    const tabla = (filas, color, tituloDias) => {
        if (!filas.length) return '<p style="font-size:13px;color:#16a34a;">Sin tareas en esta categoría.</p>';
        const cab = ['Línea', 'Equipo', 'ACR', 'Tarea', 'Responsable', 'Fecha compromiso', 'Estado', tituloDias]
            .map(c => `<th style="${th}">${c}</th>`).join('');
        const cuerpo = filas.map(f => `<tr><td style="${td}">${esc(f.linea)}</td><td style="${td}">${esc(f.equipo)}</td><td style="${td}">${esc(f.acr)}</td><td style="${td}">${esc(f.tarea)}</td><td style="${td}">${esc(f.responsable)}</td><td style="${td}">${esc(f.fecha)}</td><td style="${td}">${esc(f.estado)}</td><td style="${td}color:${color};font-weight:bold;">${f.dias == null ? '' : Math.abs(f.dias)}</td></tr>`).join('');
        return `<table style="border-collapse:collapse;width:100%;font-family:Segoe UI,Arial,sans-serif;"><tr>${cab}</tr>${cuerpo}</table>`;
    };
    const tablaCompromisos = compromisos.length
        ? `<table style="border-collapse:collapse;width:100%;font-family:Segoe UI,Arial,sans-serif;"><tr>${['Fecha', 'Línea', 'Equipo', 'Compromiso', 'Responsable', 'Prioridad', 'Estado'].map(c => `<th style="${th}">${c}</th>`).join('')}</tr>${compromisos.map(d => `<tr><td style="${td}">${esc(d.fecha)}</td><td style="${td}">${esc(d.linea)}</td><td style="${td}">${esc(d.equipo)}</td><td style="${td}">${esc(d.compromiso)}</td><td style="${td}">${esc(d.responsable)}</td><td style="${td}">${esc(d.prioridad)}</td><td style="${td}">${esc(d.estado)}</td></tr>`).join('')}</table>`
        : '<p style="font-size:13px;color:#16a34a;">Sin compromisos pendientes.</p>';

    const html = `<div style="font-family:Segoe UI,Arial,sans-serif;color:#0f172a;">
<h2 style="color:#1e3a8a;margin-bottom:4px;">Matriz de ACRs - Planta Conversión</h2>
<p style="font-size:13px;margin-top:0;">Reporte consolidado del ${fecha}.</p>
<table style="border-collapse:collapse;margin:12px 0;"><tr>
<td style="padding:10px 18px;background:#fee2e2;border-radius:6px;font-size:14px;"><b>${vencidas.length}</b> tareas vencidas</td><td style="width:10px;"></td>
<td style="padding:10px 18px;background:#fef3c7;border-radius:6px;font-size:14px;"><b>${proximas.length}</b> vencen en los próximos ${diasProximos} días</td>${compromisos.length ? `<td style="width:10px;"></td>
<td style="padding:10px 18px;background:#dbeafe;border-radius:6px;font-size:14px;"><b>${compromisos.length}</b> compromisos diarios pendientes</td>` : ''}
</tr></table>
<h3 style="color:#b91c1c;">Tareas vencidas</h3>${tabla(vencidas, '#b91c1c', 'Días de atraso')}
<h3 style="color:#b45309;">Próximas a vencer</h3>${tabla(proximas, '#b45309', 'Días restantes')}
${compromisos.length ? `<h3 style="color:#1e3a8a;">Compromisos de reunión diaria pendientes</h3>${tablaCompromisos}` : ''}
${urlApp ? `<p style="font-size:12px;color:#64748b;margin-top:18px;">Consulta y actualiza el estado en <a href="${esc(urlApp)}">${esc(urlApp)}</a></p>` : ''}
</div>`;

    const lineas = [
        `Resumen al ${fecha}`,
        `  Vencidas: ${vencidas.length}`,
        `  Próximas a vencer (${diasProximos} días): ${proximas.length}`,
        ...(compromisos.length ? [`  Compromisos diarios pendientes: ${compromisos.length}`] : []),
        ...vencidas.slice(0, 15).map(v => `  [VENCIDA] ${v.linea} | ${v.tarea} | ${v.responsable || 'Sin responsable'} | ${v.fecha}`)
    ];
    if (vencidas.length > 15) lineas.push(`  ... y ${vencidas.length - 15} más`);

    return { asunto, html, texto: lineas.join('\n'), conteo: { vencidas: vencidas.length, proximas: proximas.length, compromisos: compromisos.length } };
}

module.exports = { generarResumen, hoyBogota };
