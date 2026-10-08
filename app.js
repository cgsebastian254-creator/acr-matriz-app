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
                ? (res.agenteConectado
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
            } else if (data.type === 'daily_updated') {
                console.log('⚡ Evento Reunión Diaria recibido:', data.message);
                dailyTasksData = data.dailyTasks;
                filtrarReunionDiaria();
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

// REUNIÓN DIARIA (DDS / TECNICOS E INGENIEROS)
function filtrarReunionDiaria() {
    const busqueda = (document.getElementById('daily-search')?.value || '').toLowerCase();
    const filtroLinea = document.getElementById('daily-filter-linea')?.value || 'TODAS';
    const filtroEstado = document.getElementById('daily-filter-estado')?.value || 'TODOS';

    const tbody = document.getElementById('daily-tbody');
    if (!tbody) return;
    tbody.innerHTML = '';

    let contador = 0;

    dailyTasksData.forEach(item => {
        if (filtroLinea !== 'TODAS' && item.linea !== filtroLinea) return;
        if (filtroEstado !== 'TODOS' && item.estado !== filtroEstado) return;

        const coincideBusqueda = 
            item.equipo.toLowerCase().includes(busqueda) ||
            item.compromiso.toLowerCase().includes(busqueda) ||
            item.responsable.toLowerCase().includes(busqueda) ||
            (item.observaciones && item.observaciones.toLowerCase().includes(busqueda));

        if (!coincideBusqueda) return;

        contador++;

        let badgeClass = 'badge-pendiente';
        if (item.estado === 'En Proceso') badgeClass = 'badge-en-proceso';
        else if (item.estado === 'Realizado') badgeClass = 'badge-realizado';

        let badgePrioridad = 'badge-linea';
        if (item.prioridad === 'Alta') badgePrioridad = 'badge-vencido';
        else if (item.prioridad === 'Media') badgePrioridad = 'badge-en-proceso';

        tbody.innerHTML += `
            <tr>
                <td style="white-space: nowrap; font-size: 12px; color: var(--text-muted);">${item.fecha}</td>
                <td><span class="badge badge-linea">${item.linea}</span></td>
                <td><strong>${item.equipo}</strong></td>
                <td>${item.compromiso}</td>
                <td>${renderResponsableBadge(item.responsable)}</td>
                <td><span class="badge ${badgePrioridad}">${item.prioridad || 'Alta'}</span></td>
                <td><span class="badge ${badgeClass}">${item.estado}</span></td>
                <td>
                    <button class="btn btn-secondary" style="padding: 4px 10px; font-size: 11px;" 
                        onclick="abrirModalDailyStatus('${item.id}', '${item.compromiso.replace(/'/g, "\\'")}', '${item.estado}', '${(item.observaciones || '').replace(/'/g, "\\'")}')">
                        ✏️ Actualizar
                    </button>
                </td>
            </tr>
        `;
    });

    const countElem = document.getElementById('daily-counter');
    if (countElem) countElem.textContent = `${contador} compromisos de reunión diaria`;
}

function abrirModalNuevoCompromiso() {
    document.getElementById('modal-daily-create').classList.add('active');
}

function cerrarModalNuevoCompromiso() {
    document.getElementById('modal-daily-create').classList.remove('active');
}

async function guardarNuevoCompromiso(e) {
    e.preventDefault();

    const payload = {
        linea: document.getElementById('daily-create-linea').value,
        equipo: document.getElementById('daily-create-equipo').value,
        compromiso: document.getElementById('daily-create-compromiso').value,
        responsable: document.getElementById('daily-create-responsable').value,
        prioridad: document.getElementById('daily-create-prioridad').value,
        usuario: document.getElementById('daily-create-usuario').value
    };

    try {
        const response = await fetch('/api/daily-tasks/create', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        const resData = await response.json();
        if (resData.success) {
            cerrarModalNuevoCompromiso();
            document.getElementById('form-daily-create').reset();
            cargarDatosReunionDiaria();
        } else {
            alert('❌ Error: ' + resData.error);
        }
    } catch (err) {
        console.error('Error al guardar compromiso diario:', err);
        alert('❌ Error de comunicación con el servidor.');
    }
}

function abrirModalDailyStatus(id, compromiso, estado, obs) {
    document.getElementById('modal-daily-id').value = id;
    document.getElementById('modal-daily-desc').value = compromiso;
    document.getElementById('modal-daily-status-val').value = estado;
    document.getElementById('modal-daily-obs').value = obs || '';
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
        usuario: document.getElementById('modal-daily-user').value,
        observaciones: document.getElementById('modal-daily-obs').value
    };

    try {
        const response = await fetch('/api/daily-tasks/status', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        const resData = await response.json();
        if (resData.success) {
            cerrarModalDailyStatus();
            cargarDatosReunionDiaria();
        } else {
            alert('❌ Error: ' + resData.error);
        }
    } catch (err) {
        console.error('Error al guardar estado de compromiso:', err);
        alert('❌ Error de comunicación con el servidor.');
    }
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

        const sinDato = '<span style="color: var(--text-muted); font-style: italic;">Vuelve a subir el Excel para leerlo</span>';
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

// POWERSHELL O365 ALERTAS EXECUTION
async function ejecutarScriptAlertasConfigured() {
    const liderEmail = document.getElementById('o365-lider-email').value;
    const modoEnvio = document.getElementById('o365-modo-envio').value;
    const modoReal = (modoEnvio === 'real');

    const consoleBox = document.getElementById('ps-console-output');
    consoleBox.textContent = `⏳ Ejecutando Send-ACRAlerts.ps1 (${modoReal ? 'ENVÍO REAL SMTP O365' : 'SIMULACIÓN'})...\nLíder CC: ${liderEmail}\nPor favor espere...`;

    try {
        const response = await fetch('/api/send-alerts', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ liderEmail, modoReal })
        });
        const data = await response.json();
        if (data.queued) {
            alertaPendienteId = data.id;
            consoleBox.textContent = data.output || 'Solicitud enviada. Esperando respuesta...';
        } else if (data.agenteDesconectado) {
            consoleBox.textContent = `⚠️ ${data.error}`;
        } else {
            consoleBox.textContent = `[SALIDA POWERSHELL O365 ALERTAS]\n${data.output || ''}${data.error ? '\n[ERRORES]:\n' + data.error : ''}`;
        }
    } catch (err) {
        consoleBox.textContent = "❌ Error al ejecutar el script de alertas por correo.";
    }
}

function sendO365Alerts() {
    switchTab('powershell');
    ejecutarScriptAlertasConfigured();
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
// SUBIR EXCEL DE ACR (ingenieros)
// =====================================================================
function leerPreferencia(clave) {
    try { return localStorage.getItem(clave) || ''; } catch (e) { return ''; }
}
function guardarPreferencia(clave, valor) {
    try { localStorage.setItem(clave, valor); } catch (e) { /* sin almacenamiento local */ }
}

function abrirModalSubirExcel() {
    document.getElementById('subir-resultado').textContent = '';
    document.getElementById('subir-usuario').value = leerPreferencia('acr-subido-por');
    const lista = document.getElementById('eliminar-acr');
    lista.innerHTML = '<option value="">Selecciona el ACR...</option>' + acrsData
        .map(a => `<option value="${a.id}">${a.linea} · ${a.codigoACR || a.id}</option>`).join('');
    document.getElementById('modal-subir-excel').classList.add('active');
    fetch('/api/status').then(r => r.json()).then(st => {
        if (st.sharepointUrl) document.getElementById('link-sharepoint-acr').href = st.sharepointUrl;
    }).catch(() => {});
}

function cerrarModalSubirExcel() {
    document.getElementById('modal-subir-excel').classList.remove('active');
    document.getElementById('form-subir-excel').reset();
}

async function subirExcelACR(event) {
    event.preventDefault();
    const archivo = document.getElementById('subir-archivo').files[0];
    const linea = document.getElementById('subir-linea').value;
    const usuario = document.getElementById('subir-usuario').value.trim();
    const resultado = document.getElementById('subir-resultado');
    const boton = document.getElementById('subir-boton');
    if (!archivo) return;

    boton.disabled = true;
    boton.textContent = '⏳ Subiendo...';
    resultado.style.color = 'var(--text-muted)';
    resultado.textContent = 'Procesando el Excel...';
    try {
        const qs = new URLSearchParams({ nombre: archivo.name, linea, usuario });
        const response = await fetch(`/api/acrs/upload?${qs}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/octet-stream' },
            body: archivo
        });
        const data = await response.json();
        if (data.success) {
            guardarPreferencia('acr-subido-por', usuario);
            resultado.style.color = 'var(--status-green)';
            resultado.textContent = `✅ ${data.reemplazado ? 'ACR actualizado' : 'ACR agregado'}: ${data.acr.codigoACR}\n${data.acr.tareas} tareas · Línea ${data.acr.linea} · ${data.acr.equipo}`;
            document.getElementById('subir-archivo').value = '';
        } else {
            resultado.style.color = 'var(--status-red)';
            resultado.textContent = '❌ ' + (data.error || 'No se pudo subir el archivo.');
        }
    } catch (e) {
        resultado.style.color = 'var(--status-red)';
        resultado.textContent = '❌ Error de comunicación con el servidor.';
    } finally {
        boton.disabled = false;
        boton.textContent = 'Subir ACR';
    }
}

async function eliminarACR() {
    const id = document.getElementById('eliminar-acr').value;
    const usuario = document.getElementById('subir-usuario').value.trim();
    const resultado = document.getElementById('subir-resultado');
    if (!id) { alert('Selecciona el ACR que quieres eliminar.'); return; }
    const acr = acrsData.find(a => a.id === id);
    if (!confirm(`¿Eliminar el ACR "${acr ? acr.codigoACR : id}" y todas sus tareas? Esta acción no se puede deshacer.`)) return;
    try {
        const response = await fetch('/api/acrs/delete', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id, usuario })
        });
        const data = await response.json();
        resultado.style.color = data.success ? 'var(--status-green)' : 'var(--status-red)';
        resultado.textContent = data.success ? '🗑️ ACR eliminado.' : '❌ ' + data.error;
        if (data.success) abrirModalSubirExcel();
    } catch (e) {
        resultado.style.color = 'var(--status-red)';
        resultado.textContent = '❌ Error de comunicación con el servidor.';
    }
}

// =====================================================================
// CORREO DESDE LA CUENTA DEL USUARIO (no necesita el PC corporativo)
// =====================================================================
function convertirFechaACR(texto) {
    const t = String(texto || '').trim().split(' ')[0].split('T')[0];
    let m = t.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{2,4})$/);
    if (m) {
        const anio = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
        return new Date(anio, Number(m[2]) - 1, Number(m[1]));
    }
    m = t.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    return null;
}

function calcularResumenAlertas(diasProximos = 7) {
    const hoy = new Date(); hoy.setHours(0, 0, 0, 0);
    const limite = new Date(hoy); limite.setDate(limite.getDate() + diasProximos);
    const vencidas = [];
    const proximas = [];
    for (const acr of acrsData) {
        for (const t of acr.tareas || []) {
            if (t.estado === 'Realizado') continue;
            const f = convertirFechaACR(t.fechaCompromiso);
            const fila = { linea: acr.linea, tarea: t.descripcion, responsable: t.responsable, fecha: t.fechaCompromiso || 'sin fecha', f };
            if (t.estado === 'Vencido' || (f && f < hoy)) vencidas.push(fila);
            else if (f && f <= limite) proximas.push(fila);
        }
    }
    vencidas.sort((a, b) => (a.f || 0) - (b.f || 0));
    proximas.sort((a, b) => (a.f || 0) - (b.f || 0));
    const compromisos = dailyTasksData.filter(d => d.estado !== 'Realizado');
    return { vencidas, proximas, compromisos, diasProximos, hoy };
}

function textoResumenAlertas(maxCaracteres) {
    const r = calcularResumenAlertas();
    const fecha = r.hoy.toLocaleDateString('es-CO');
    const asunto = `Alertas ACR Planta Conversión - ${fecha} - ${r.vencidas.length} vencidas, ${r.proximas.length} próximas a vencer`;
    const enlace = location.origin;
    const lineas = [
        `Resumen de la Matriz de ACRs al ${fecha}:`,
        `• ${r.vencidas.length} tareas vencidas`,
        `• ${r.proximas.length} tareas vencen en los próximos ${r.diasProximos} días`,
        `• ${r.compromisos.length} compromisos de reunión diaria pendientes`,
        ''
    ];
    const bloques = [
        ['TAREAS VENCIDAS', r.vencidas.map(v => `- [${v.linea}] ${v.tarea} | ${v.responsable || 'Sin responsable'} | ${v.fecha}`)],
        ['PRÓXIMAS A VENCER', r.proximas.map(v => `- [${v.linea}] ${v.tarea} | ${v.responsable || 'Sin responsable'} | ${v.fecha}`)],
        ['COMPROMISOS DIARIOS PENDIENTES', r.compromisos.map(d => `- [${d.linea}] ${d.compromiso} | ${d.responsable || 'Sin responsable'} | ${d.prioridad || ''}`)]
    ];
    const cierre = ['', `Ver y actualizar: ${enlace}`];
    let cuerpo = lineas.join('\n');
    let recortado = false;
    for (const [titulo, filas] of bloques) {
        if (!filas.length) continue;
        const bloque = `\n${titulo}\n` + filas.join('\n') + '\n';
        if (maxCaracteres && cuerpo.length + bloque.length > maxCaracteres) {
            const disponibles = filas.filter((_, i) => (cuerpo.length + (`\n${titulo}\n` + filas.slice(0, i + 1).join('\n')).length) < maxCaracteres);
            if (disponibles.length) cuerpo += `\n${titulo}\n` + disponibles.join('\n') + `\n(... y ${filas.length - disponibles.length} más)\n`;
            recortado = true;
            break;
        }
        cuerpo += bloque;
    }
    if (recortado) cuerpo += '\nEl listado completo está en la aplicación.';
    cuerpo += cierre.join('\n');
    return { asunto, cuerpo };
}

function abrirCorreoEnMiOutlook() {
    const cc = (document.getElementById('o365-lider-email').value || '').trim();
    // Los enlaces de correo muy largos se cortan en algunos equipos: se limita el texto
    const { asunto, cuerpo } = textoResumenAlertas(1500);
    const url = `mailto:?${cc ? 'cc=' + encodeURIComponent(cc) + '&' : ''}subject=${encodeURIComponent(asunto)}&body=${encodeURIComponent(cuerpo)}`;
    document.getElementById('ps-console-output').textContent = `✉️ Se abrió tu aplicación de correo con el resumen.\nRevisa los destinatarios y dale Enviar.\n\nAsunto: ${asunto}`;
    window.location.href = url;
}

async function copiarResumenAlertas() {
    const { asunto, cuerpo } = textoResumenAlertas(0);
    const texto = `${asunto}\n\n${cuerpo}`;
    try {
        await navigator.clipboard.writeText(texto);
        document.getElementById('ps-console-output').textContent = '📋 Resumen completo copiado. Pégalo en un correo nuevo de Outlook.\n\n' + texto;
    } catch (e) {
        document.getElementById('ps-console-output').textContent = texto;
        alert('No se pudo copiar automáticamente. El resumen quedó en la consola para que lo copies a mano.');
    }
}

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
        ${vacio ? '<p style="color: var(--text-muted);">Este ACR se cargó con una versión anterior del lector. Vuelve a subir su Excel con el botón "Subir Excel ACR" para ver el análisis completo; se conservan los estados de sus tareas.</p>' : ''}
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
