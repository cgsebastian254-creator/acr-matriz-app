// Si la sesión vence, cualquier llamada al servidor lleva de nuevo a la pantalla de ingreso
(function () {
    const fetchOriginal = window.fetch.bind(window);
    window.fetch = async (...args) => {
        const r = await fetchOriginal(...args);
        if (r.status === 401) {
            const copia = r.clone();
            try {
                const d = await copia.json();
                if (d && d.login) { window.location.href = '/login'; }
            } catch (e) { /* respuesta sin JSON */ }
        }
        return r;
    };
})();

// State Management
let acrsData = [];
let dailyTasksData = [];
let currentTab = 'dashboard';
let eventSource = null;
let alertaPendienteId = null;

// Initialize App
document.addEventListener('DOMContentLoaded', () => {
    cargarDatosACRs();
    cargarDatosReunionDiaria();
    iniciarRealtimeSSE();
});

// Helper for Purple Badge when Responsible is missing
function renderResponsableBadge(resp) {
    if (!resp || resp === 'No Hay Responsable' || resp.trim() === '' || resp === 'Sin Responsable' || resp === 'undefined') {
        return `<span class="badge badge-no-responsable">🟣 No Hay Responsable</span>`;
    }
    return `<strong>${resp}</strong>`;
}

// Rescan Excel files manually via REST API
async function rescanExcelFiles() {
    const btn = event ? event.target : null;
    if (btn) btn.innerHTML = '⏳ Escaneando S:\\...';
    try {
        const response = await fetch('/api/acrs/sync', { method: 'POST' });
        const res = await response.json();
        if (res.success) {
            mostrarNotificacionToast('Sistema Sync', res.cloud
                ? (res.correo ? `Buzón de ACR revisado. Mostrando ${res.count} ACRs.` : res.agenteConectado
                    ? `Mostrando ${res.count} ACRs. Se actualizan automáticamente desde SharePoint cada 5 minutos.`
                    : `Mostrando ${res.count} ACRs. ⚠️ El PC corporativo no está conectado: los Excel nuevos aparecerán cuando se conecte.`)
                : `Se han rescaneado ${res.count} formatos Excel desde la red.`);
            cargarDatosACRs();
        } else {
            alert('❌ Error al escanear formatos: ' + res.error);
        }
    } catch (e) {
        console.error('Error al escanear Excel:', e);
        alert('❌ Error de comunicación con el servidor al escanear Excel.');
    } finally {
        if (btn) btn.innerHTML = '🔄 Escanear Excel S:\\';
    }
}

// REAL-TIME SERVER-SENT EVENTS (SSE) STREAM
function iniciarRealtimeSSE() {
    if (eventSource) eventSource.close();

    eventSource = new EventSource('/api/events');

    eventSource.onopen = () => {
        console.log('🟢 Conexión en Tiempo Real establecida con el Servidor');
        actualizarBadgesConexion(true);
    };

    eventSource.onmessage = (event) => {
        try {
            const data = JSON.parse(event.data);

            if (data.type === 'init' || data.type === 'users_count') {
                document.getElementById('live-user-count').textContent = `🟢 En Vivo (${data.count || data.activeUsers} usuarios)`;
            } else if (data.type === 'data_updated') {
                console.log('⚡ Evento ACR en Tiempo Real recibido:', data.message);
                acrsData = data.acrs;
                renderizarTodo();
                mostrarNotificacionToast(data.user, data.message);
            } else if (data.type === 'alert_result') {
                if (alertaPendienteId && data.id === alertaPendienteId) {
                    alertaPendienteId = null;
                    const box = document.getElementById('ps-console-output');
                    if (box) {
                        box.textContent = `[RESULTADO DEL ENVÍO ${data.success ? '✅' : '❌'}]\n${data.output || ''}${data.error ? '\n[ERRORES]:\n' + data.error : ''}`;
                    }
                    mostrarNotificacionToast('Alertas O365', data.success ? 'Correo procesado en el PC corporativo.' : 'No se pudo enviar el correo. Revisa la consola.');
                }
            } else if (data.type === 'tecnicos_updated' || data.type === 'turnos_updated') {
                if (typeof recargarTecnicos === 'function') recargarTecnicos(data.type);
                if (data.user && data.message) mostrarNotificacionToast(data.user, data.message);
            } else if (data.type === 'daily_updated') {
                console.log('⚡ Evento Reunión Diaria recibido:', data.message);
                dailyTasksData = data.dailyTasks;
                filtrarReunionDiaria();
                if (typeof renderTurnoHoy === 'function') renderTurnoHoy();
                mostrarNotificacionToast(data.user, data.message);
            }
        } catch (e) {
            console.error('Error procesando evento SSE:', e);
        }
    };

    eventSource.onerror = (err) => {
        console.warn('⚠️ Conexión SSE interrumpida. Reintentando...');
        actualizarBadgesConexion(false);
    };
}

function actualizarBadgesConexion(online) {
    const badge = document.getElementById('live-user-count');
    if (!badge) return;
    if (online) {
        badge.style.backgroundColor = 'rgba(16, 185, 129, 0.2)';
        badge.style.color = '#10b981';
        badge.style.border = '1px solid rgba(16, 185, 129, 0.4)';
    } else {
        badge.textContent = '🔴 Desconectado';
        badge.style.backgroundColor = 'rgba(239, 68, 68, 0.2)';
        badge.style.color = '#ef4444';
        badge.style.border = '1px solid rgba(239, 68, 68, 0.4)';
    }
}

// FLOATING TOAST NOTIFICATION FOR REAL-TIME EVENTS
function mostrarNotificacionToast(usuario, mensaje) {
    let toastContainer = document.getElementById('toast-container');
    if (!toastContainer) {
        toastContainer = document.createElement('div');
        toastContainer.id = 'toast-container';
        toastContainer.style.cssText = 'position: fixed; bottom: 20px; right: 20px; z-index: 9999; display: flex; flex-direction: column; gap: 10px;';
        document.body.appendChild(toastContainer);
    }

    const toast = document.createElement('div');
    toast.style.cssText = `
        background-color: #1e293b;
        color: #f8fafc;
        border-left: 4px solid #3b82f6;
        border-radius: 8px;
        padding: 12px 18px;
        box-shadow: 0 10px 25px rgba(0,0,0,0.5);
        font-size: 13px;
        max-width: 380px;
        animation: slideInRight 0.3s forwards;
    `;
    toast.innerHTML = `
        <div style="font-weight: 700; color: #3b82f6; margin-bottom: 2px;">⚡ Actualización en Vivo</div>
        <div><strong>${usuario}</strong>: ${mensaje}</div>
    `;

    toastContainer.appendChild(toast);

    setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transition = 'opacity 0.4s ease';
        setTimeout(() => toast.remove(), 400);
    }, 4500);
}

// Fetch Data from REST API
async function cargarDatosACRs() {
    try {
        const response = await fetch('/api/acrs');
        acrsData = await response.json();
        renderizarTodo();
    } catch (error) {
        console.error('Error al cargar datos ACRs:', error);
    }
}

async function cargarDatosReunionDiaria() {
    try {
        const response = await fetch('/api/daily-tasks');
        dailyTasksData = await response.json();
        filtrarReunionDiaria();
    } catch (error) {
        console.error('Error al cargar datos reunión diaria:', error);
    }
}

// Global Render Router
function renderizarTodo() {
    renderDashboard();
    renderArchivos();
    filtrarMatriz();
    filtrarReunionDiaria();
    filtrarCatalogo();
    filtrarHistorial();
}

// TAB SWITCHING LOGIC
function switchTab(tabId) {
    currentTab = tabId;
    document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(content => content.classList.remove('active'));

    const activeBtn = document.querySelector(`.tab-btn[onclick="switchTab('${tabId}')"]`);
    const activeContent = document.getElementById(`tab-${tabId}`);

    if (activeBtn) activeBtn.classList.add('active');
    if (activeContent) activeContent.classList.add('active');
}

// EXECUTIVE DASHBOARD RENDERER
function renderDashboard() {
    let totalACRs = acrsData.length;
    let totalTareas = 0;
    let tareasEnProceso = 0;
    let tareasVencidas = 0;
    let tareasRealizadas = 0;

    const lineasStats = {
        'Forte': { total: 0, cerradas: 0 },
        'Futura': { total: 0, cerradas: 0 },
        'Hinnli': { total: 0, cerradas: 0 },
        'Pocket': { total: 0, cerradas: 0 },
        'Sincro 1': { total: 0, cerradas: 0 },
        'Sincro 2': { total: 0, cerradas: 0 }
    };

    const tareasPendientesGlobales = [];

    acrsData.forEach(acr => {
        const linea = acr.linea || 'Conversión 1';
        if (!lineasStats[linea]) lineasStats[linea] = { total: 0, cerradas: 0 };

        (acr.tareas || []).forEach(tarea => {
            totalTareas++;
            lineasStats[linea].total++;

            if (tarea.estado === 'Realizado') {
                tareasRealizadas++;
                lineasStats[linea].cerradas++;
            } else if (tarea.estado === 'Vencido') {
                tareasVencidas++;
                tareasPendientesGlobales.push({ acr, tarea });
            } else if (tarea.estado === 'En Proceso' || tarea.estado === 'Pendiente') {
                tareasEnProceso++;
                tareasPendientesGlobales.push({ acr, tarea });
            }
        });
    });

    const porcentajeCumplimiento = totalTareas > 0 ? Math.round((tareasRealizadas / totalTareas) * 100) : 0;
    const pctRealizadas = totalTareas > 0 ? Math.round((tareasRealizadas / totalTareas) * 100) : 0;
    const pctProceso = totalTareas > 0 ? Math.round((tareasEnProceso / totalTareas) * 100) : 0;
    const pctVencidas = totalTareas > 0 ? Math.round((tareasVencidas / totalTareas) * 100) : 0;

    document.getElementById('kpi-total-acrs').textContent = totalACRs;
    document.getElementById('kpi-en-proceso').textContent = tareasEnProceso;
    document.getElementById('kpi-vencidas').textContent = tareasVencidas;
    document.getElementById('kpi-cerradas').textContent = tareasRealizadas;

    const badgeCumpl = document.getElementById('kpi-cumplimiento-badge');
    if (badgeCumpl) badgeCumpl.textContent = `${porcentajeCumplimiento}% Cumplimiento Global`;

    document.getElementById('label-realizadas-pct').textContent = `${pctRealizadas}% (${tareasRealizadas}/${totalTareas})`;
    document.getElementById('label-proceso-pct').textContent = `${pctProceso}% (${tareasEnProceso}/${totalTareas})`;
    document.getElementById('label-vencidas-pct').textContent = `${pctVencidas}% (${tareasVencidas}/${totalTareas})`;

    document.getElementById('bar-realizadas').style.width = `${pctRealizadas}%`;
    document.getElementById('bar-proceso').style.width = `${pctProceso}%`;
    document.getElementById('bar-vencidas').style.width = `${pctVencidas}%`;

    const container = document.getElementById('line-bars-container');
    container.innerHTML = '';

    Object.keys(lineasStats).forEach(linea => {
        const stat = lineasStats[linea];
        const pct = stat.total > 0 ? Math.round((stat.cerradas / stat.total) * 100) : 0;
        
        let colorClass = '#10b981';
        if (pct < 50) colorClass = '#ef4444';
        else if (pct < 80) colorClass = '#f59e0b';

        container.innerHTML += `
            <div class="line-progress-item">
                <div class="line-progress-header">
                    <span>Línea ${linea}</span>
                    <span style="color: ${colorClass};">${pct}% (${stat.cerradas}/${stat.total})</span>
                </div>
                <div class="progress-bar-bg">
                    <div class="progress-bar-fill" style="width: ${pct}%; background-color: ${colorClass};"></div>
                </div>
            </div>
        `;
    });

    const criticalTbody = document.getElementById('dashboard-critical-tbody');
    criticalTbody.innerHTML = '';

    if (tareasPendientesGlobales.length === 0) {
        criticalTbody.innerHTML = `<tr><td colspan="8" style="text-align: center; color: var(--text-muted);">🎉 ¡Felicidades! No hay tareas pendientes ni vencidas en la planta.</td></tr>`;
    } else {
        tareasPendientesGlobales.forEach(item => {
            const { acr, tarea } = item;
            let badgeClass = 'badge-pendiente';
            if (tarea.estado === 'Vencido') badgeClass = 'badge-vencido';
            else if (tarea.estado === 'En Proceso') badgeClass = 'badge-en-proceso';

            let badgeTipo = tarea.tipo === 'Accion Inmediata' 
                ? '<span class="badge badge-inmediata">⚡ Inmediata</span>' 
                : '<span class="badge badge-preventiva">🛡️ Preventiva</span>';

            criticalTbody.innerHTML += `
                <tr>
                    <td><span class="badge badge-linea">${acr.linea}</span></td>
                    <td><code>${acr.codigoACR || acr.id}</code></td>
                    <td>${acr.equipo}</td>
                    <td>${tarea.descripcion}</td>
                    <td>${badgeTipo}</td>
                    <td>${renderResponsableBadge(tarea.responsable)}</td>
                    <td><strong style="color: ${tarea.estado === 'Vencido' ? 'var(--status-red)' : 'var(--text-main)'};">${tarea.fechaCompromiso || tarea.fechaLimite || 'N/A'}</strong></td>
                    <td><span class="badge ${badgeClass}">${tarea.estado}</span></td>
                </tr>
            `;
        });
    }
}

// MATRIZ & FILTERS
function filtrarMatriz() {
    const busqueda = (document.getElementById('search-input')?.value || '').toLowerCase();
    const filtroLinea = document.getElementById('filter-linea')?.value || 'TODAS';
    const filtroTipo = document.getElementById('filter-tipo')?.value || 'TODOS';
    const filtroEstado = document.getElementById('filter-estado')?.value || 'TODOS';

    const tbody = document.getElementById('matriz-tbody');
    if (!tbody) return;
    tbody.innerHTML = '';

    let contadorResultados = 0;

    acrsData.forEach(acr => {
        if (filtroLinea !== 'TODAS' && acr.linea !== filtroLinea) return;

        (acr.tareas || []).forEach(tarea => {
            if (filtroTipo !== 'TODOS' && tarea.tipo !== filtroTipo) return;
            if (filtroEstado !== 'TODOS' && tarea.estado !== filtroEstado) return;

            const coincideBusqueda = 
                (acr.codigoACR || acr.id).toLowerCase().includes(busqueda) ||
                (acr.linea || '').toLowerCase().includes(busqueda) ||
                (acr.equipo || '').toLowerCase().includes(busqueda) ||
                (acr.falla || '').toLowerCase().includes(busqueda) ||
                tarea.descripcion.toLowerCase().includes(busqueda) ||
                (tarea.responsable || '').toLowerCase().includes(busqueda);

            if (!coincideBusqueda) return;

            contadorResultados++;

            let badgeClass = 'badge-pendiente';
            if (tarea.estado === 'Vencido') badgeClass = 'badge-vencido';
            else if (tarea.estado === 'En Proceso') badgeClass = 'badge-en-proceso';
            else if (tarea.estado === 'Realizado') badgeClass = 'badge-realizado';

            let badgeTipo = tarea.tipo === 'Accion Inmediata' 
                ? '<span class="badge badge-inmediata">⚡ Inmediata</span>' 
                : '<span class="badge badge-preventiva">🛡️ Preventiva</span>';

            tbody.innerHTML += `
                <tr>
                    <td>${badgeTipo}</td>
                    <td><code>${acr.codigoACR || acr.id}</code></td>
                    <td><span class="badge badge-linea">${acr.linea}</span></td>
                    <td><strong>${acr.equipo}</strong></td>
                    <td>${tarea.descripcion}</td>
                    <td>${renderResponsableBadge(tarea.responsable)}</td>
                    <td><strong style="color: ${tarea.estado === 'Vencido' ? 'var(--status-red)' : 'var(--text-main)'};">${tarea.fechaCompromiso || tarea.fechaLimite || 'N/A'}</strong></td>
                    <td><span class="badge ${badgeClass}">${tarea.estado}</span></td>
                    <td>
                        <button class="btn btn-secondary" style="padding: 4px 10px; font-size: 11px;" 
                            onclick="abrirModalTarea('${acr.id}', '${tarea.idTarea}', '${tarea.descripcion.replace(/'/g, "\\'")}', '${tarea.estado}', '${(tarea.observaciones || '').replace(/'/g, "\\'")}')">
                            ✏️ Editar
                        </button>
                    </td>
                </tr>
            `;
        });
    });

    const countElem = document.getElementById('counter-results') || document.getElementById('matriz-counter');
    if (countElem) countElem.textContent = `${contadorResultados} acciones mostradas`;
}

// =====================================================================
// REUNIÓN DIARIA: pendientes del día, no realizados, eliminar e historial
// =====================================================================
function hoyLocalISO() {
    const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    return p;
}
function fechaTxt(iso) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(iso || '')) return iso || '';
    const [a, m, d] = iso.split('-');
    return `${d}/${m}/${a}`;
}
function fechaPend(d) { return d.fechaCompromiso || d.fechaISO || ''; }
function pendAbierto(d) { return !d.eliminado && d.estado !== 'Realizado'; }
function pendNoRealizado(d, hoy) { return pendAbierto(d) && fechaPend(d) && fechaPend(d) < (hoy || hoyLocalISO()); }
function attr(v) { return escaparHTML(v).replace(/`/g, '&#96;'); }

function badgeEstadoPendiente(d) {
    if (d.eliminado) return '<span class="badge badge-gris">🗑️ Eliminado</span>';
    if (pendNoRealizado(d)) return `<span class="badge badge-vencido">⚠️ No realizado</span> <span class="badge badge-pendiente">${escaparHTML(d.estado)}</span>`;
    const cls = d.estado === 'Realizado' ? 'badge-realizado' : d.estado === 'En Proceso' ? 'badge-en-proceso' : 'badge-pendiente';
    return `<span class="badge ${cls}">${escaparHTML(d.estado)}</span>`;
}
function badgePrioridad(p) {
    const cls = p === 'Alta' ? 'badge-vencido' : p === 'Media' ? 'badge-en-proceso' : 'badge-linea';
    return `<span class="badge ${cls}">${escaparHTML(p || 'Alta')}</span>`;
}

function filtrarReunionDiaria() {
    const tbody = document.getElementById('daily-tbody');
    if (!tbody) return;
    const campoFecha = document.getElementById('daily-fecha');
    if (campoFecha && !campoFecha.value) campoFecha.value = hoyLocalISO();
    const dia = campoFecha ? campoFecha.value : hoyLocalISO();
    const busqueda = (document.getElementById('daily-search')?.value || '').toLowerCase();
    const filtroLinea = document.getElementById('daily-filter-linea')?.value || 'TODAS';
    const filtroEstado = document.getElementById('daily-filter-estado')?.value || 'TODOS';

    // Del día elegido + los de días anteriores que siguen abiertos
    const delDia = dailyTasksData.filter(d => !d.eliminado && (fechaPend(d) === dia || (pendAbierto(d) && fechaPend(d) < dia)));
    const lista = delDia.filter(d => {
        if (filtroLinea !== 'TODAS' && d.linea !== filtroLinea) return false;
        if (filtroEstado === 'ABIERTOS' && !pendAbierto(d)) return false;
        if (filtroEstado === 'NOREALIZADO' && !pendNoRealizado(d, dia)) return false;
        if (!['TODOS', 'ABIERTOS', 'NOREALIZADO'].includes(filtroEstado) && d.estado !== filtroEstado) return false;
        const texto = [d.equipo, d.compromiso, d.responsable, d.observaciones, d.linea].join(' ').toLowerCase();
        return !busqueda || texto.includes(busqueda);
    }).sort((a, b) => (pendAbierto(b) - pendAbierto(a)) || fechaPend(a).localeCompare(fechaPend(b)) || ({ Alta: 0, Media: 1, Baja: 2 }[a.prioridad] ?? 0) - ({ Alta: 0, Media: 1, Baja: 2 }[b.prioridad] ?? 0));

    tbody.innerHTML = lista.length ? lista.map(d => `
        <tr class="${pendNoRealizado(d, dia) ? 'fila-alerta' : ''}">
            <td style="white-space: nowrap; font-size: 12px;">${fechaTxt(fechaPend(d))}${fechaPend(d) < dia && pendAbierto(d) ? `<div style="color: var(--status-red); font-weight: 600;">${Math.round((new Date(dia) - new Date(fechaPend(d))) / 86400000)} día(s) de atraso</div>` : ''}</td>
            <td><span class="badge badge-linea">${escaparHTML(d.linea)}</span></td>
            <td><strong>${escaparHTML(d.equipo)}</strong></td>
            <td>${escaparHTML(d.compromiso)}${d.observaciones && d.observaciones !== 'Acordado en reunión diaria' ? `<div style="font-size: 12px; color: var(--text-muted); margin-top: 4px;">💬 ${escaparHTML(d.observaciones)}</div>` : ''}</td>
            <td>${renderResponsableBadge(escaparHTML(d.responsable))}</td>
            <td>${badgePrioridad(d.prioridad)}</td>
            <td>${badgeEstadoPendiente(d)}</td>
            <td>
                <button class="btn btn-secondary" style="padding: 4px 10px; font-size: 11px;" onclick="abrirModalDailyStatus('${attr(d.id)}')">✏️ Actualizar</button>
                <button class="btn btn-danger" style="padding: 4px 10px; font-size: 11px;" onclick="abrirEliminarPendiente('${attr(d.id)}')">🗑️ Eliminar</button>
            </td>
        </tr>`).join('') : `<tr><td colspan="8" style="text-align: center; color: var(--text-muted);">No hay pendientes para este día con esos filtros.</td></tr>`;

    const countElem = document.getElementById('daily-counter');
    if (countElem) countElem.textContent = `${lista.length} pendientes`;

    const resumen = document.getElementById('daily-resumen');
    if (resumen) {
        const base = delDia.filter(d => filtroLinea === 'TODAS' || d.linea === filtroLinea);
        const n = {
            total: base.length,
            abiertos: base.filter(pendAbierto).length,
            noRealizados: base.filter(d => pendNoRealizado(d, dia)).length,
            realizados: base.filter(d => d.estado === 'Realizado').length
        };
        resumen.innerHTML = `
            <div class="kpi-mini"><span>${n.total}</span>Pendientes del día</div>
            <div class="kpi-mini amarillo"><span>${n.abiertos}</span>Sin cerrar</div>
            <div class="kpi-mini rojo"><span>${n.noRealizados}</span>No realizados a tiempo</div>
            <div class="kpi-mini verde"><span>${n.realizados}</span>Realizados</div>`;
    }
    renderInmediatas();
    actualizarListasSugeridas();
}

function renderInmediatas() {
    const tbody = document.getElementById('inmediatas-tbody');
    if (!tbody) return;
    const filtroLinea = document.getElementById('daily-filter-linea')?.value || 'TODAS';
    const hoy = hoyLocalISO();
    const filas = [];
    acrsData.forEach(acr => {
        if (filtroLinea !== 'TODAS' && acr.linea !== filtroLinea) return;
        (acr.tareas || []).forEach(t => {
            if (t.tipo !== 'Accion Inmediata' || t.estado === 'Realizado') return;
            filas.push({ acr, t, f: aIsoCliente(t.fechaCompromiso) });
        });
    });
    filas.sort((a, b) => (a.f || '9').localeCompare(b.f || '9'));
    document.getElementById('inmediatas-counter').textContent = `${filas.length} abiertas`;
    tbody.innerHTML = filas.length ? filas.map(({ acr, t, f }) => {
        const vencida = t.estado === 'Vencido' || (f && f < hoy);
        const cls = vencida ? 'badge-vencido' : t.estado === 'En Proceso' ? 'badge-en-proceso' : 'badge-pendiente';
        return `<tr>
            <td><span class="badge badge-linea">${escaparHTML(acr.linea)}</span></td>
            <td><code>${acr.numeroACR ? 'N° ' + escaparHTML(acr.numeroACR) : escaparHTML(acr.codigoACR || acr.id)}</code></td>
            <td><strong>${escaparHTML(acr.equipo)}</strong></td>
            <td>${escaparHTML(t.descripcion)}</td>
            <td>${renderResponsableBadge(escaparHTML(t.responsable))}</td>
            <td><strong style="color: ${vencida ? 'var(--status-red)' : 'inherit'};">${escaparHTML(t.fechaCompromiso || 'Sin fecha')}</strong></td>
            <td><span class="badge ${cls}">${vencida && t.estado !== 'Vencido' ? 'Vencida' : escaparHTML(t.estado)}</span></td>
            <td><button class="btn btn-secondary" style="padding: 4px 10px; font-size: 11px;" onclick="abrirModalTarea('${attr(acr.id)}', '${attr(t.idTarea)}', '${attr(String(t.descripcion).replace(/'/g, "\\'"))}', '${attr(t.estado)}', '${attr(String(t.observaciones || '').replace(/'/g, "\\'"))}')">✏️ Editar</button></td>
        </tr>`;
    }).join('') : `<tr><td colspan="8" style="text-align: center; color: var(--text-muted);">🎉 No hay acciones inmediatas abiertas${filtroLinea !== 'TODAS' ? ' en ' + escaparHTML(filtroLinea) : ''}.</td></tr>`;
}

function aIsoCliente(v) {
    const t = String(v || '').trim();
    let m = t.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
    m = t.match(/(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{2,4})/);
    if (m) return `${m[3].length === 2 ? '20' + m[3] : m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
    return '';
}

// Máquinas (de los ACR y pendientes anteriores) y técnicos para autocompletar
function actualizarListasSugeridas() {
    const maquinas = new Set();
    acrsData.forEach(a => a.equipo && maquinas.add(a.equipo.trim()));
    dailyTasksData.forEach(d => d.equipo && maquinas.add(d.equipo.trim()));
    const dl = document.getElementById('lista-maquinas');
    if (dl) dl.innerHTML = [...maquinas].sort((a, b) => a.localeCompare(b, 'es')).map(m => `<option value="${attr(m)}">`).join('');
}

function vistaDaily(vista) {
    document.querySelectorAll('#tab-daily .subtab').forEach(b => b.classList.toggle('activo', b.dataset.vista === vista));
    document.getElementById('daily-vista-hoy').style.display = vista === 'hoy' ? '' : 'none';
    document.getElementById('daily-vista-historial').style.display = vista === 'historial' ? '' : 'none';
    if (vista === 'historial' && !historialPend.cargado) cargarHistorialPendientes();
}

function abrirModalNuevoCompromiso() {
    const f = document.getElementById('daily-create-fecha');
    if (f) f.value = document.getElementById('daily-fecha')?.value || hoyLocalISO();
    const linea = document.getElementById('daily-filter-linea')?.value;
    if (linea && linea !== 'TODAS') document.getElementById('daily-create-linea').value = linea;
    if (typeof sugerirResponsables === 'function') sugerirResponsables();
    document.getElementById('modal-daily-create').classList.add('active');
}

function cerrarModalNuevoCompromiso() {
    document.getElementById('modal-daily-create').classList.remove('active');
}
function cerrarModal(id) { document.getElementById(id).classList.remove('active'); }

async function guardarNuevoCompromiso(e) {
    e.preventDefault();
    const payload = {
        linea: document.getElementById('daily-create-linea').value,
        fechaCompromiso: document.getElementById('daily-create-fecha').value,
        equipo: document.getElementById('daily-create-equipo').value.trim(),
        compromiso: document.getElementById('daily-create-compromiso').value.trim(),
        responsable: document.getElementById('daily-create-responsable').value.trim(),
        prioridad: document.getElementById('daily-create-prioridad').value,
        usuario: document.getElementById('daily-create-usuario').value
    };
    try {
        const response = await fetch('/api/daily-tasks/create', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
        const resData = await response.json();
        if (resData.success) {
            cerrarModalNuevoCompromiso();
            const usuario = payload.usuario;
            document.getElementById('form-daily-create').reset();
            document.getElementById('daily-create-usuario').value = usuario;
            cargarDatosReunionDiaria();
        } else {
            alert('❌ Error: ' + resData.error);
        }
    } catch (err) {
        alert('❌ Error de comunicación con el servidor.');
    }
}

function abrirModalDailyStatus(id) {
    const d = dailyTasksData.find(x => x.id === id);
    if (!d) return;
    document.getElementById('modal-daily-id').value = id;
    document.getElementById('modal-daily-desc').value = `${d.equipo} · ${d.compromiso}`;
    document.getElementById('modal-daily-status-val').value = d.estado;
    document.getElementById('modal-daily-fecha').value = fechaPend(d);
    document.getElementById('modal-daily-obs').value = '';
    document.getElementById('modal-daily-historial').innerHTML = (d.historial || []).slice(0, 6).map(h =>
        `<div><span>${escaparHTML(h.fecha)}</span> · <strong>${escaparHTML(h.usuario)}</strong>: ${escaparHTML(h.accion)}</div>`).join('');
    document.getElementById('modal-daily-status').classList.add('active');
}

function cerrarModalDailyStatus() {
    document.getElementById('modal-daily-status').classList.remove('active');
}

async function guardarEstadoDailyTask(e) {
    e.preventDefault();
    const payload = {
        id: document.getElementById('modal-daily-id').value,
        nuevoEstado: document.getElementById('modal-daily-status-val').value,
        fechaCompromiso: document.getElementById('modal-daily-fecha').value,
        usuario: document.getElementById('modal-daily-user').value,
        observaciones: document.getElementById('modal-daily-obs').value
    };
    try {
        const response = await fetch('/api/daily-tasks/status', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
        const resData = await response.json();
        if (resData.success) {
            cerrarModalDailyStatus();
            cargarDatosReunionDiaria();
        } else {
            alert('❌ Error: ' + resData.error);
        }
    } catch (err) {
        alert('❌ Error de comunicación con el servidor.');
    }
}

function abrirEliminarPendiente(id) {
    const d = dailyTasksData.find(x => x.id === id);
    if (!d) return;
    document.getElementById('eliminar-daily-id').value = id;
    document.getElementById('eliminar-daily-texto').innerHTML = `<strong>${escaparHTML(d.equipo)}</strong> · ${escaparHTML(d.compromiso)}`;
    document.getElementById('eliminar-daily-motivo').value = '';
    document.getElementById('modal-daily-eliminar').classList.add('active');
}

async function confirmarEliminarPendiente(e) {
    e.preventDefault();
    const id = document.getElementById('eliminar-daily-id').value;
    const motivo = document.getElementById('eliminar-daily-motivo').value;
    try {
        const r = await (await fetch('/api/daily-tasks/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, motivo, usuario: usuarioActual.nombre }) })).json();
        if (!r.success) return alert('❌ ' + (r.error || 'No se pudo eliminar.'));
        cerrarModal('modal-daily-eliminar');
        cargarDatosReunionDiaria();
        if (historialPend.cargado) cargarHistorialPendientes();
    } catch (err) {
        alert('❌ Error de comunicación con el servidor.');
    }
}

async function restaurarPendiente(id) {
    if (!confirm('¿Restaurar este pendiente?')) return;
    const r = await (await fetch('/api/daily-tasks/restaurar', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, usuario: usuarioActual.nombre }) })).json();
    if (!r.success) return alert('❌ ' + (r.error || 'No se pudo restaurar.'));
    cargarDatosReunionDiaria();
    cargarHistorialPendientes();
}

// ---------- Historial por máquina y fecha ----------
const historialPend = { cargado: false, lista: [] };

async function cargarHistorialPendientes() {
    const hasta = document.getElementById('hist-hasta');
    const desde = document.getElementById('hist-desde');
    if (!hasta.value) hasta.value = hoyLocalISO();
    if (!desde.value) { const d = new Date(hasta.value + 'T12:00:00'); d.setDate(d.getDate() - 30); desde.value = d.toISOString().slice(0, 10); }
    document.getElementById('hist-tbody').innerHTML = '<tr><td colspan="8" style="text-align: center; color: var(--text-muted);">Buscando…</td></tr>';
    try {
        const r = await (await fetch(`/api/daily-tasks/historial?desde=${desde.value}&hasta=${hasta.value}`)).json();
        historialPend.lista = r.pendientes || [];
        historialPend.cargado = true;
        renderHistorialPendientes();
    } catch (e) {
        document.getElementById('hist-tbody').innerHTML = '<tr><td colspan="8">❌ No se pudo cargar el historial.</td></tr>';
    }
}

function historialFiltrado() {
    const texto = (document.getElementById('hist-maquina').value || '').toLowerCase();
    const linea = document.getElementById('hist-linea').value;
    const estado = document.getElementById('hist-estado').value;
    const hoy = hoyLocalISO();
    return historialPend.lista.filter(d => {
        if (linea !== 'TODAS' && d.linea !== linea) return false;
        if (estado === 'Realizado' && (d.eliminado || d.estado !== 'Realizado')) return false;
        if (estado === 'ABIERTOS' && !pendAbierto(d)) return false;
        if (estado === 'ELIMINADO' && !d.eliminado) return false;
        if (estado === 'NOREALIZADO' && !(d.avisoNoRealizado || pendNoRealizado(d, hoy) || (d.fechaCierre && d.fechaCierre > fechaPend(d)))) return false;
        return !texto || [d.equipo, d.compromiso, d.responsable, d.observaciones].join(' ').toLowerCase().includes(texto);
    }).sort((a, b) => fechaPend(b).localeCompare(fechaPend(a)) || (a.equipo || '').localeCompare(b.equipo || ''));
}

function renderHistorialPendientes() {
    const lista = historialFiltrado();
    const porMaquina = {};
    lista.forEach(d => {
        const m = porMaquina[d.equipo || 'Sin máquina'] = porMaquina[d.equipo || 'Sin máquina'] || { total: 0, hechos: 0, tarde: 0 };
        m.total++;
        if (d.estado === 'Realizado' && !d.eliminado) m.hechos++;
        if (d.avisoNoRealizado || (d.fechaCierre && d.fechaCierre > fechaPend(d))) m.tarde++;
    });
    document.getElementById('hist-por-maquina').innerHTML = Object.entries(porMaquina).sort((a, b) => b[1].total - a[1].total).slice(0, 24).map(([m, n]) =>
        `<button class="chip-maquina" onclick="document.getElementById('hist-maquina').value='${attr(m.replace(/'/g, "\\'"))}'; renderHistorialPendientes();">
            <strong>${escaparHTML(m)}</strong><span>${n.total} pendientes · ✅ ${n.hechos}${n.tarde ? ' · ⚠️ ' + n.tarde + ' tarde' : ''}</span></button>`).join('');
    document.getElementById('hist-counter').textContent = `${lista.length} registros`;
    document.getElementById('hist-tbody').innerHTML = lista.length ? lista.map(d => {
        const cierre = d.eliminado
            ? `Eliminado por ${escaparHTML(d.eliminado.por)}${d.eliminado.motivo ? ': ' + escaparHTML(d.eliminado.motivo) : ''}`
            : d.estado === 'Realizado'
                ? `✅ ${d.fechaCierre ? fechaTxt(d.fechaCierre) : ''}${d.cerradoPor ? ' · ' + escaparHTML(d.cerradoPor) : ''}${d.fechaCierre && d.fechaCierre > fechaPend(d) ? ' <span class="badge badge-vencido">fuera de fecha</span>' : ''}`
                : (d.observaciones ? escaparHTML(d.observaciones) : '');
        return `<tr>
            <td style="white-space: nowrap; font-size: 12px;">${fechaTxt(fechaPend(d))}${d.fechaISO && d.fechaISO !== fechaPend(d) ? `<div style="color: var(--text-muted);">reg. ${fechaTxt(d.fechaISO)}</div>` : ''}</td>
            <td><strong>${escaparHTML(d.equipo)}</strong></td>
            <td><span class="badge badge-linea">${escaparHTML(d.linea)}</span></td>
            <td>${escaparHTML(d.compromiso)}</td>
            <td>${escaparHTML(d.responsable)}</td>
            <td>${badgeEstadoPendiente(d)}</td>
            <td style="font-size: 12px;">${cierre}</td>
            <td>${d.eliminado ? `<button class="btn btn-secondary" style="padding: 4px 10px; font-size: 11px;" onclick="restaurarPendiente('${attr(d.id)}')">↩️ Restaurar</button>` : `<button class="btn btn-secondary" style="padding: 4px 10px; font-size: 11px;" onclick="verHistorialPendiente('${attr(d.id)}')">📜 Ver historial</button>`}</td>
        </tr>`;
    }).join('') : '<tr><td colspan="8" style="text-align: center; color: var(--text-muted);">No hay actividades en ese rango con esos filtros.</td></tr>';
}

function verHistorialPendiente(id) {
    const d = historialPend.lista.find(x => x.id === id) || dailyTasksData.find(x => x.id === id);
    if (!d) return;
    document.getElementById('analisis-titulo').textContent = `${d.equipo} · ${fechaTxt(fechaPend(d))}`;
    document.getElementById('analisis-contenido').innerHTML = `
        <p style="margin-bottom: 12px;">${escaparHTML(d.compromiso)}</p>
        <div style="display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 14px;">
            <span class="badge badge-linea">${escaparHTML(d.linea)}</span>${badgeEstadoPendiente(d)}<span class="badge badge-purple">👤 ${escaparHTML(d.responsable)}</span>
        </div>
        <div class="mini-historial">${(d.historial || []).map(h => `<div><span>${escaparHTML(h.fecha)}</span> · <strong>${escaparHTML(h.usuario)}</strong>: ${escaparHTML(h.accion)}</div>`).join('') || 'Sin movimientos.'}</div>`;
    document.getElementById('modal-analisis').classList.add('active');
}

function exportarHistorialPendientes() {
    const lista = historialFiltrado();
    if (!lista.length) return alert('No hay registros para exportar.');
    const cols = ['Fecha compromiso', 'Fecha registro', 'Máquina', 'Línea', 'Pendiente', 'Responsable', 'Prioridad', 'Estado', 'Fecha cierre', 'Cerrado por', 'Eliminado', 'Observaciones'];
    const filas = lista.map(d => [fechaTxt(fechaPend(d)), fechaTxt(d.fechaISO), d.equipo, d.linea, d.compromiso, d.responsable, d.prioridad, d.eliminado ? 'Eliminado' : d.estado,
        d.fechaCierre ? fechaTxt(d.fechaCierre) : '', d.cerradoPor || '', d.eliminado ? `${d.eliminado.por}: ${d.eliminado.motivo || ''}` : '', d.observaciones || '']);
    const csv = '﻿' + [cols, ...filas].map(f => f.map(v => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`).join(';')).join('\r\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    a.download = `historial_pendientes_${document.getElementById('hist-desde').value}_a_${document.getElementById('hist-hasta').value}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

// CATÁLOGO DE FALLAS CON FILTROS DINÁMICOS
function filtrarCatalogo() {
    const busqueda = (document.getElementById('catalogo-search')?.value || '').toLowerCase();
    const filtroLin = document.getElementById('catalogo-linea')?.value || 'TODAS';

    const tbody = document.getElementById('catalogo-tbody');
    if (!tbody) return;
    tbody.innerHTML = '';

    let contador = 0;

    acrsData.forEach(acr => {
        if (filtroLin !== 'TODAS' && acr.linea !== filtroLin) return;

        const coincideBusqueda = 
            (acr.linea || '').toLowerCase().includes(busqueda) ||
            (acr.equipo || '').toLowerCase().includes(busqueda) ||
            (acr.falla || '').toLowerCase().includes(busqueda) ||
            (acr.causaRaiz || '').toLowerCase().includes(busqueda) ||
            (acr.problema || '').toLowerCase().includes(busqueda) ||
            (acr.numeroACR || '').toLowerCase().includes(busqueda) ||
            (acr.codigoACR || acr.id).toLowerCase().includes(busqueda);

        if (!coincideBusqueda) return;

        contador++;

        const sinDato = '<span style="color: var(--text-muted); font-style: italic;">Sin dato en el Excel</span>';
        const causa = acr.causaRaiz && !/^Sin causa ra/i.test(acr.causaRaiz) ? escaparHTML(acr.causaRaiz) : sinDato;
        tbody.innerHTML += `
            <tr>
                <td><span class="badge badge-linea">${escaparHTML(acr.linea)}</span></td>
                <td><strong>${escaparHTML(acr.equipo)}</strong></td>
                <td><code>${acr.numeroACR ? 'N° ' + escaparHTML(acr.numeroACR) + ' · ' : ''}${escaparHTML(acr.codigoACR || acr.id)}</code>${acr.fechaACR ? `<div style="font-size: 11px; color: var(--text-muted); margin-top: 4px;">${escaparHTML(acr.fechaACR)}</div>` : ''}</td>
                <td><div class="texto-recortado">${acr.problema ? escaparHTML(acr.problema) : sinDato}</div></td>
                <td><div class="texto-recortado">${causa}</div></td>
                <td>${renderResponsableBadge(acr.responsableAcr)}</td>
                <td><button class="btn btn-secondary" style="padding: 4px 10px; font-size: 11px;" onclick="abrirModalAnalisis('${acr.id}')">🔍 Ver análisis</button></td>
            </tr>
        `;
    });

    const countElem = document.getElementById('catalogo-counter');
    if (countElem) countElem.textContent = `${contador} fallas de ACRs registradas`;
}

// HISTORIAL Y TRAZABILIDAD RENDERER Y FILTRO POR BUSCADOR
function filtrarHistorial() {
    const busqueda = (document.getElementById('historial-search')?.value || '').toLowerCase();
    const tbody = document.getElementById('historial-tbody');
    if (!tbody) return;
    tbody.innerHTML = '';

    let contador = 0;

    acrsData.forEach(acr => {
        (acr.tareas || []).forEach(tarea => {
            if (tarea.historial && tarea.historial.length > 0) {
                tarea.historial.forEach(item => {
                    const coincideBusqueda = 
                        (acr.codigoACR || acr.id).toLowerCase().includes(busqueda) ||
                        (acr.linea || '').toLowerCase().includes(busqueda) ||
                        tarea.descripcion.toLowerCase().includes(busqueda) ||
                        (tarea.responsable || '').toLowerCase().includes(busqueda) ||
                        (item.usuario || '').toLowerCase().includes(busqueda) ||
                        item.accion.toLowerCase().includes(busqueda);

                    if (!coincideBusqueda) return;

                    contador++;

                    tbody.innerHTML += `
                        <tr>
                            <td style="white-space: nowrap;">${item.fecha}</td>
                            <td><strong>${acr.codigoACR || acr.id}</strong> <span class="badge badge-linea">${acr.linea}</span></td>
                            <td>${tarea.descripcion}</td>
                            <td>${renderResponsableBadge(tarea.responsable)}</td>
                            <td><span class="badge badge-linea">${item.usuario}</span></td>
                            <td>${item.accion}</td>
                        </tr>
                    `;
                });
            }
        });
    });

    const countElem = document.getElementById('historial-counter');
    if (countElem) countElem.textContent = `${contador} registros de auditoría`;
}

// MODAL HANDLERS FOR ACR TASKS
function abrirModalTarea(acrId, taskId, taskDesc, taskStatus, taskObs) {
    document.getElementById('modal-acr-id').value = acrId;
    document.getElementById('modal-task-id').value = taskId;
    document.getElementById('modal-task-desc').value = taskDesc;
    document.getElementById('modal-task-status').value = taskStatus;
    document.getElementById('modal-task-obs').value = taskObs || '';
    document.getElementById('modal-tarea').classList.add('active');
}

function cerrarModalTarea() {
    document.getElementById('modal-tarea').classList.remove('active');
}

async function guardarEstadoTarea(e) {
    e.preventDefault();

    const payload = {
        acrId: document.getElementById('modal-acr-id').value,
        taskId: document.getElementById('modal-task-id').value,
        nuevoEstado: document.getElementById('modal-task-status').value,
        usuario: document.getElementById('modal-task-user').value,
        observaciones: document.getElementById('modal-task-obs').value
    };

    try {
        const response = await fetch('/api/tasks/status', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        const resData = await response.json();
        if (resData.success) {
            cerrarModalTarea();
        } else {
            alert('❌ Error: ' + resData.error);
        }
    } catch (err) {
        console.error('Error al guardar tarea:', err);
        alert('❌ Error de comunicación con el servidor.');
    }
}

// VISTA CELULAR: cada celda recibe el nombre de su columna para mostrar las tablas como tarjetas
function aplicarEtiquetasMoviles(raiz = document) {
    raiz.querySelectorAll('table.data-table').forEach(tabla => {
        const titulos = [...tabla.querySelectorAll('thead th')].map(th => th.textContent.trim());
        tabla.querySelectorAll('tbody tr').forEach(tr => {
            [...tr.children].forEach((td, i) => {
                if (td.hasAttribute('colspan')) {
                    td.classList.add('td-mensaje');
                } else if (titulos[i] && td.getAttribute('data-label') !== titulos[i]) {
                    td.setAttribute('data-label', titulos[i]);
                }
            });
        });
    });
}

document.addEventListener('DOMContentLoaded', () => {
    aplicarEtiquetasMoviles();
    let pendiente = false;
    new MutationObserver(() => {
        if (pendiente) return;
        pendiente = true;
        requestAnimationFrame(() => { pendiente = false; aplicarEtiquetasMoviles(); });
    }).observe(document.querySelector('.main-container') || document.body, { childList: true, subtree: true });
});

// En el celular, desplaza la barra de pestañas para que la pestaña activa quede a la vista
(function () {
    if (typeof switchTab !== 'function') return;
    const original = switchTab;
    switchTab = function (tab) {
        original(tab);
        const activa = document.querySelector('.tab-btn.active');
        if (activa && activa.scrollIntoView) activa.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
    };
})();

// =====================================================================
// ARCHIVOS ACR POR LÍNEA (carpetas)
// =====================================================================
const archivosAbiertos = new Set();

function renderArchivos() {
    const cont = document.getElementById('archivos-contenedor');
    if (!cont) return;
    const busqueda = (document.getElementById('archivos-search')?.value || '').toLowerCase();
    const porLinea = {};
    acrsData.forEach(acr => {
        const texto = [acr.archivoOrigen, acr.codigoACR, acr.numeroACR, acr.equipo, acr.linea].join(' ').toLowerCase();
        if (busqueda && !texto.includes(busqueda)) return;
        (porLinea[acr.linea || 'Sin línea'] = porLinea[acr.linea || 'Sin línea'] || []).push(acr);
    });
    const lineas = Object.keys(porLinea).sort((a, b) => a.localeCompare(b, 'es'));
    const total = lineas.reduce((n, l) => n + porLinea[l].length, 0);
    document.getElementById('archivos-counter').textContent = `${total} archivos en ${lineas.length} líneas`;

    if (!lineas.length) {
        cont.innerHTML = `<div class="section-card" style="text-align: center; color: var(--text-muted);">${busqueda ? 'No hay archivos que coincidan con la búsqueda.' : 'Todavía no hay ACRs.'}</div>`;
        return;
    }
    cont.innerHTML = lineas.map(linea => {
        const archivos = porLinea[linea].slice().sort((a, b) => (Number(b.numeroACR) || 0) - (Number(a.numeroACR) || 0));
        const abierta = busqueda || archivosAbiertos.has(linea);
        const filas = archivos.map(acr => {
            const tareas = acr.tareas || [];
            const cerradas = tareas.filter(t => t.estado === 'Realizado').length;
            const origen = acr.origen === 'sharepoint' ? '☁️ SharePoint' : acr.origen === 'web' ? '⬆️ Subido a mano' : '📁 Carga inicial';
            return `
                <div class="archivo-fila">
                    <div class="archivo-icono">📄</div>
                    <div class="archivo-info">
                        <div class="archivo-nombre">${escaparHTML(acr.archivoOrigen || acr.codigoACR || acr.id)}</div>
                        <div class="archivo-meta">
                            ${acr.numeroACR ? `<span>N° ${escaparHTML(acr.numeroACR)}</span>` : ''}
                            <span>${escaparHTML(acr.equipo || '')}</span>
                            ${acr.fechaACR ? `<span>📅 ${escaparHTML(acr.fechaACR)}</span>` : ''}
                            <span>✅ ${cerradas}/${tareas.length} tareas</span>
                            <span>${origen}${acr.fechaSubida ? ' · ' + escaparHTML(acr.fechaSubida) : ''}</span>
                        </div>
                    </div>
                    <div class="archivo-acciones">
                        <button class="btn btn-secondary btn-sm" onclick="abrirModalAnalisis('${acr.id}')">🔍 Ver detalle</button>
                        <button class="btn btn-danger btn-sm" onclick="eliminarACR('${acr.id}')">🗑️ Eliminar</button>
                    </div>
                </div>`;
        }).join('');
        return `
            <div class="section-card carpeta ${abierta ? 'abierta' : ''}">
                <button class="carpeta-cabecera" onclick="alternarCarpeta('${escaparHTML(linea).replace(/'/g, "\\'")}')">
                    <span class="carpeta-icono">${abierta ? '📂' : '📁'}</span>
                    <span class="carpeta-nombre">${escaparHTML(linea)}</span>
                    <span class="badge badge-linea">${archivos.length} ${archivos.length === 1 ? 'archivo' : 'archivos'}</span>
                    <span class="carpeta-flecha">${abierta ? '▾' : '▸'}</span>
                </button>
                <div class="carpeta-contenido">${filas}</div>
            </div>`;
    }).join('');
}

function alternarCarpeta(linea) {
    if (archivosAbiertos.has(linea)) archivosAbiertos.delete(linea); else archivosAbiertos.add(linea);
    renderArchivos();
}

async function eliminarACR(id) {
    const acr = acrsData.find(a => a.id === id);
    if (!acr) return;
    const nombre = acr.archivoOrigen || acr.codigoACR || id;
    if (!confirm(`¿Eliminar "${nombre}" de la matriz junto con sus ${(acr.tareas || []).length} tareas y su historial?\n\nEl archivo en SharePoint no se borra.`)) return;
    try {
        const response = await fetch('/api/acrs/delete', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id, usuario: (typeof usuarioActual !== 'undefined' && usuarioActual.nombre) || '' })
        });
        const data = await response.json();
        if (!data.success) alert('❌ ' + (data.error || 'No se pudo eliminar.'));
    } catch (e) {
        alert('❌ Error de comunicación con el servidor.');
    }
}

document.addEventListener('DOMContentLoaded', () => {
    fetch('/api/status').then(r => r.json()).then(st => {
        const link = document.getElementById('link-sharepoint-carpeta');
        if (st.sharepointUrl && link) link.href = st.sharepointUrl;
    }).catch(() => {});
});

// AVISO SI LOS DATOS NO ESTÁN PROTEGIDOS (sin base de datos en la nube)
document.addEventListener('DOMContentLoaded', () => {
    fetch('/api/status').then(r => r.json()).then(st => {
        if (!st.cloud || st.baseDatos === 'conectada') return;
        const aviso = document.createElement('div');
        aviso.id = 'aviso-base-datos';
        aviso.style.cssText = 'background: rgba(239,68,68,0.15); border: 1px solid rgba(239,68,68,0.5); color: #fca5a5; padding: 10px 14px; border-radius: 10px; margin-bottom: 16px; font-size: 13px;';
        aviso.innerHTML = st.baseDatos === 'error'
            ? '⚠️ <strong>No hay conexión con la base de datos.</strong> Los cambios que hagas ahora podrían perderse si el servidor se reinicia. Revisa MONGODB_URI en Render.'
            : '⚠️ <strong>Datos temporales:</strong> la base de datos aún no está configurada (MONGODB_URI en Render). Los ACR subidos y los cambios se pierden si el servidor se reinicia.';
        const main = document.querySelector('.main-container');
        if (main) main.prepend(aviso);
    }).catch(() => {});
});


// =====================================================================
// ANÁLISIS COMPLETO DEL ACR (5 POR QUÉ)
// =====================================================================
function escaparHTML(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

function abrirModalAnalisis(id) {
    const acr = acrsData.find(a => a.id === id);
    if (!acr) return;
    const bloque = (titulo, html) => html ? `
        <div style="margin-bottom: 18px;">
            <div style="font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .05em; color: var(--text-muted); margin-bottom: 6px;">${titulo}</div>
            <div style="font-size: 14px; line-height: 1.5;">${html}</div>
        </div>` : '';
    const lista = arr => (arr && arr.length) ? '<ul style="padding-left: 18px; display: grid; gap: 4px;">' + arr.map(x => `<li>${escaparHTML(x)}</li>`).join('') + '</ul>' : '';
    const detalle = (acr.detalleProblema || []).filter(d => d.respuesta && d.respuesta !== acr.problema)
        .map(d => `<div><strong>${escaparHTML(d.pregunta)}:</strong> ${escaparHTML(d.respuesta)}</div>`).join('');
    const porques = (acr.porques || []).map((p, i) => p ? `
        <div style="display: grid; grid-template-columns: 34px 1fr; gap: 10px; align-items: start; margin-bottom: 8px;">
            <span class="badge badge-en-proceso" style="justify-content: center;">${i + 1}</span>
            <span>${escaparHTML(p)}</span>
        </div>` : '').join('');
    const causa = acr.causaRaiz && !/^Sin causa ra/i.test(acr.causaRaiz)
        ? `<div style="background: rgba(239,68,68,.12); border: 1px solid rgba(239,68,68,.4); border-radius: 10px; padding: 12px 14px;">${escaparHTML(acr.causaRaiz)}</div>` : '';
    const vacio = !acr.problema && !causa && !porques;

    document.getElementById('analisis-titulo').textContent = `${acr.numeroACR ? 'ACR N° ' + acr.numeroACR + ' · ' : ''}${acr.equipo || ''}`;
    document.getElementById('analisis-contenido').innerHTML = `
        <div style="display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 18px;">
            <span class="badge badge-linea">${escaparHTML(acr.linea)}</span>
            ${acr.fechaACR ? `<span class="badge badge-pendiente">📅 ${escaparHTML(acr.fechaACR)}</span>` : ''}
            <span class="badge badge-purple">👤 ${escaparHTML(acr.responsableAcr || 'Sin responsable')}</span>
            <span class="badge badge-realizado">${(acr.tareas || []).filter(t => t.estado === 'Realizado').length}/${(acr.tareas || []).length} tareas cerradas</span>
        </div>
        ${vacio ? '<p style="color: var(--text-muted);">Este ACR se cargó con una versión anterior del lector. Vuelve a guardar su Excel en SharePoint para que se lea el análisis completo; se conservan los estados de sus tareas.</p>' : ''}
        ${bloque('1. Descripción del problema', acr.problema ? escaparHTML(acr.problema) + (detalle ? '<div style="margin-top: 8px; font-size: 13px; color: var(--text-muted); display: grid; gap: 4px;">' + detalle + '</div>' : '') : '')}
        ${bloque('2. Síntomas', lista(acr.sintomas))}
        ${bloque('3. Causas potenciales', lista(acr.causasPotenciales))}
        ${bloque('4. Análisis 5 ¿Por qué?', porques)}
        ${bloque('6. Causa raíz', causa)}
        <div style="font-size: 12px; color: var(--text-muted);">Archivo: ${escaparHTML(acr.archivoOrigen || acr.codigoACR || '')}</div>
    `;
    document.getElementById('modal-analisis').classList.add('active');
}

function cerrarModalAnalisis() {
    document.getElementById('modal-analisis').classList.remove('active');
}

// =====================================================================
// USUARIO QUE INGRESÓ (correo corporativo): se muestra arriba y se
// prellena en los formularios de "Usuario que actualiza"
// =====================================================================
let usuarioActual = { correo: '', nombre: '' };
const CAMPOS_USUARIO = ['modal-task-user', 'modal-daily-user', 'daily-create-usuario'];

function prellenarUsuario() {
    if (!usuarioActual.nombre) return;
    CAMPOS_USUARIO.forEach(id => {
        const el = document.getElementById(id);
        if (el && !el.value) el.value = usuarioActual.nombre;
    });
}

document.addEventListener('DOMContentLoaded', () => {
    fetch('/api/me').then(r => r.json()).then(me => {
        if (!me || !me.correo) return;
        usuarioActual = me;
        const salir = document.querySelector('a[href="/logout"]');
        if (salir) {
            salir.title = `Cerrar sesión de ${me.correo}`;
            salir.innerHTML = `🔒 Salir <span class="usuario-sesion">${escaparHTML(me.nombre)}</span>`;
        }
        prellenarUsuario();
        const miCorreo = document.getElementById('notif-mi-correo');
        if (miCorreo) miCorreo.textContent = me.correo;
        ['abrirModalTarea', 'abrirModalDailyStatus', 'abrirModalNuevoCompromiso'].forEach(nombre => {
            const original = window[nombre];
            if (typeof original !== 'function') return;
            window[nombre] = function (...args) {
                const r = original.apply(this, args);
                setTimeout(prellenarUsuario, 0);
                return r;
            };
        });
    }).catch(() => {});
});
