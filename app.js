// State Management
let acrsData = [];
let dailyTasksData = [];
let currentTab = 'dashboard';
let eventSource = null;

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
                ? `Mostrando ${res.count} ACRs. Se actualizan automáticamente desde SharePoint cada 5 minutos.`
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
            (acr.codigoACR || acr.id).toLowerCase().includes(busqueda);

        if (!coincideBusqueda) return;

        contador++;

        tbody.innerHTML += `
            <tr>
                <td><span class="badge badge-linea">${acr.linea}</span></td>
                <td><strong>${acr.equipo}</strong></td>
                <td>${acr.falla}</td>
                <td>${acr.causaRaiz}</td>
                <td>${renderResponsableBadge(acr.responsableAcr)}</td>
                <td><code>${acr.codigoACR || acr.id}</code></td>
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
        consoleBox.textContent = `[SALIDA POWERSHELL O365 ALERTAS]\n${data.output}\n${data.error ? '[ERRORES]:\n' + data.error : ''}`;
    } catch (err) {
        consoleBox.textContent = "❌ Error al ejecutar el script de alertas por correo.";
    }
}

function sendO365Alerts() {
    switchTab('powershell');
    ejecutarScriptAlertasConfigured();
}
