// =====================================================================
// TÉCNICOS, MATRIZ DE POLIVALENCIA, TURNOS Y NOTIFICACIONES (interfaz)
// =====================================================================
const tec = { tecnicos: [], habilidades: [], niveles: {}, periodoActual: '', cargado: false };
const turnos = { tipos: [], asignaciones: {}, rangos: [], semana: '' };
let diaInicioOffset = 0;

const ICONO_ROL = { 'Mecánico': '🔧', 'Electricista': '⚡', 'Instrumentista': '📟', 'Lubricador': '🛢️', 'Calderista': '🔥', 'Ingeniero': '👷' };
const MOSTRAR_TURNOS = false;   // la programación de turnos está apagada por ahora
const DIAS_CORTOS = ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'];

function ahoraBogotaCliente() {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
        timeZone: 'America/Bogota', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
    }).formatToParts(new Date()).map(x => [x.type, x.value]));
    return { fecha: `${p.year}-${p.month}-${p.day}`, minutos: Number(p.hour) * 60 + Number(p.minute) };
}
function sumarDiasISO(iso, n) {
    const d = new Date(iso + 'T12:00:00Z');
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
}
function lunesISO(iso) {
    const d = new Date(iso + 'T12:00:00Z');
    return sumarDiasISO(iso, -((d.getUTCDay() + 6) % 7));
}
function minutosHora(h) {
    const m = String(h || '').match(/^(\d{1,2}):(\d{2})$/);
    return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}
function normalizarTexto(t) {
    return String(t || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}
function pct(v) { return v == null ? '—' : Math.round(v * 100) + '%'; }
async function postJSON(url, datos) {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(datos || {}) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.success === false) throw new Error(j.error || `Error ${r.status}`);
    return j;
}

// ---------------------------------------------------------------
// Carga de datos
// ---------------------------------------------------------------
async function cargarTecnicos() {
    try {
        const r = await fetch('/api/tecnicos');
        if (r.status === 403) { tec.sinAcceso = true; aplicarAccesoTecnicos(); return; }
        const d = await r.json();
        Object.assign(tec, d, { cargado: true });
        await cargarResultados360();
        llenarSelectoresRoles();
        renderKpisTecnicos();
        const dl = document.getElementById('lista-tecnicos');
        if (dl) dl.innerHTML = tec.tecnicos.filter(t => t.activo !== false).map(t => `<option value="${escaparHTML(t.nombre)}">${escaparHTML(t.rol)}</option>`).join('');
    } catch (e) { console.error('No se pudieron cargar los técnicos', e); }
}

async function cargarRangoTurnos(desde, hasta) {
    const d = await (await fetch(`/api/turnos?desde=${desde}&hasta=${hasta}`)).json();
    turnos.tipos = d.tipos || [];
    for (let f = desde; f <= hasta; f = sumarDiasISO(f, 1)) delete turnos.asignaciones[f];
    Object.assign(turnos.asignaciones, d.asignaciones || {});
    return d;
}

async function recargarTecnicos(tipo) {
    if (tipo !== 'turnos_updated') await cargarTecnicos();
    if (!MOSTRAR_TURNOS) { renderTodoTecnicos(); return; }
    const hoy = ahoraBogotaCliente().fecha;
    const semana = turnos.semana || lunesISO(hoy);
    await cargarRangoTurnos(sumarDiasISO(lunesISO(hoy), -7), sumarDiasISO(lunesISO(hoy), 20));
    if (semana) await cargarRangoTurnos(semana, sumarDiasISO(semana, 6));
    renderTodoTecnicos();
}

let vistaTecActual = 'perfiles';
function renderTodoTecnicos() {
    renderTurnoHoy();
    renderKpisTecnicos();
    if (document.getElementById('tab-tecnicos')?.classList.contains('active')) renderVistaTec(vistaTecActual);
}

document.addEventListener('DOMContentLoaded', async () => {
    const hoy = ahoraBogotaCliente().fecha;
    turnos.semana = lunesISO(hoy);
    const semana = document.getElementById('turnos-semana');
    if (semana) semana.value = turnos.semana;
    await cargarTecnicos();
    try { await cargarRangoTurnos(sumarDiasISO(turnos.semana, -7), sumarDiasISO(turnos.semana, 20)); } catch (e) { /* sin conexión */ }
    renderTurnoHoy();
    renderChipsBuscador();
    cargarNotificaciones();
    setInterval(renderTurnoHoy, 5 * 60 * 1000);
});

// Al entrar a la pestaña se dibuja lo que esté visible
(function () {
    const original = switchTab;
    switchTab = function (tab) {
        original(tab);
        if (tab === 'tecnicos') renderTodoTecnicos();
        if (tab === 'powershell') cargarNotificaciones();
    };
})();

// ---------------------------------------------------------------
// Turnos: consultas
// ---------------------------------------------------------------
function tipoTurno(codigo) { return turnos.tipos.find(t => t.codigo === codigo); }
function codigoTurno(tecId, fecha) { return (turnos.asignaciones[fecha] || {})[tecId] || ''; }

// ¿Está trabajando en este momento? (el turno de noche de ayer sigue activo en la madrugada)
function turnoActivoAhora(tecId) {
    const { fecha, minutos } = ahoraBogotaCliente();
    const revisar = (f, deAyer) => {
        const t = tipoTurno(codigoTurno(tecId, f));
        if (!t || !t.labora) return null;
        const ini = minutosHora(t.inicio), fin = minutosHora(t.fin);
        if (ini == null || fin == null) return deAyer ? null : t;
        if (ini < fin) return !deAyer && minutos >= ini && minutos < fin ? t : null;
        return deAyer ? (minutos < fin ? t : null) : (minutos >= ini ? t : null);
    };
    return revisar(fecha, false) || revisar(sumarDiasISO(fecha, -1), true);
}

function badgeTurno(codigo, extra = '') {
    const t = tipoTurno(codigo);
    if (!t) return '<span class="badge badge-gris">Sin programar</span>';
    return `<span class="badge" style="background:${t.color}26;color:${t.color};border:1px solid ${t.color}66;">${escaparHTML(t.nombre)}${t.inicio ? ' ' + t.inicio + '–' + t.fin : ''}${extra}</span>`;
}

// ---------------------------------------------------------------
// INICIO: personal en turno
// ---------------------------------------------------------------
function moverDiaInicio(n) {
    diaInicioOffset = n === 0 ? 0 : diaInicioOffset + n;
    const fecha = sumarDiasISO(ahoraBogotaCliente().fecha, diaInicioOffset);
    if (!turnos.asignaciones[fecha] && (fecha < sumarDiasISO(turnos.semana, -7) || fecha > sumarDiasISO(turnos.semana, 20))) {
        cargarRangoTurnos(lunesISO(fecha), sumarDiasISO(lunesISO(fecha), 6)).then(renderTurnoHoy);
    }
    renderTurnoHoy();
}
function irAProgramacion() { switchTab('tecnicos'); vistaTecnicos('turnos'); }
function buscarDesdeInicio() {
    const q = document.getElementById('inicio-buscar-tecnico').value;
    switchTab('tecnicos');
    vistaTecnicos('buscar');
    document.getElementById('buscar-tec-texto').value = q;
    renderBuscador();
}

function renderTurnoHoy() {
    const cont = document.getElementById('turno-hoy-contenido');
    if (!cont) return;
    const hoy = ahoraBogotaCliente().fecha;
    const fecha = sumarDiasISO(hoy, diaInicioOffset);
    const d = new Date(fecha + 'T12:00:00Z');
    document.getElementById('turno-hoy-fecha').textContent = (diaInicioOffset === 0 ? 'hoy, ' : '') + `${DIAS_CORTOS[(d.getUTCDay() + 6) % 7]} ${fechaTxt(fecha)}`;
    if (!tec.cargado) return;
    const activos = tec.tecnicos.filter(t => t.activo !== false);
    if (!activos.length) {
        cont.innerHTML = `<div class="vacio">Aún no hay técnicos registrados. Ve a <a href="#" onclick="switchTab('tecnicos'); vistaTecnicos('perfiles'); return false;">Técnicos y Turnos → Perfiles</a> para agregarlos o importar la matriz de polivalencia desde Excel.</div>`;
        return;
    }
    const grupos = {};
    const sinProgramar = [];
    const pendientesDe = nombre => {
        const n = normalizarTexto(nombre).split(' ').filter(x => x.length > 2).slice(0, 2);
        return dailyTasksData.filter(p => pendAbierto(p) && fechaPend(p) <= fecha && n.length && n.every(x => normalizarTexto(p.responsable).includes(x))).length;
    };
    for (const t of activos) {
        const c = codigoTurno(t.id, fecha);
        if (!c) { sinProgramar.push(t); continue; }
        (grupos[c] = grupos[c] || []).push(t);
    }
    const orden = turnos.tipos.map(t => t.codigo);
    const bloques = Object.keys(grupos).sort((a, b) => {
        const ta = tipoTurno(a), tb = tipoTurno(b);
        return (tb?.labora ? 1 : 0) - (ta?.labora ? 1 : 0) || orden.indexOf(a) - orden.indexOf(b);
    }).map(c => {
        const tipo = tipoTurno(c) || { nombre: c, color: '#64748b' };
        const personas = grupos[c].sort((a, b) => (a.rol || '').localeCompare(b.rol || '') || a.nombre.localeCompare(b.nombre));
        const ahora = diaInicioOffset === 0 && personas.some(p => turnoActivoAhora(p.id));
        return `<div class="turno-bloque ${tipo.labora ? '' : 'no-labora'}" style="border-top: 3px solid ${tipo.color};">
            <div class="turno-bloque-cab">
                <strong style="color:${tipo.color};">${escaparHTML(tipo.nombre)}</strong>
                <span>${tipo.inicio ? tipo.inicio + ' – ' + tipo.fin : ''}</span>
                ${ahora ? '<span class="badge badge-realizado">🟢 Ahora</span>' : ''}
                <span class="turno-conteo">${personas.length}</span>
            </div>
            ${personas.map(p => {
                const pend = pendientesDe(p.nombre);
                return `<button class="persona-turno" onclick="abrirPerfil('${attr(p.id)}')">
                    <span>${ICONO_ROL[p.rol] || '👤'} ${escaparHTML(p.nombre)}</span>
                    <small>${escaparHTML(p.rol)}${p.linea ? ' · ' + escaparHTML(p.linea) : ''}${pend ? ` · 📝 ${pend}` : ''}</small>
                </button>`;
            }).join('')}
        </div>`;
    }).join('');
    const laboran = Object.entries(grupos).filter(([c]) => tipoTurno(c)?.labora).reduce((n, [, l]) => n + l.length, 0);
    cont.innerHTML = `
        <div class="turno-resumen">
            <span><strong>${laboran}</strong> laboran</span>
            <span>🔧 ${Object.entries(grupos).filter(([c]) => tipoTurno(c)?.labora).flatMap(([, l]) => l).filter(p => p.rol === 'Mecánico').length} mecánicos</span>
            <span>⚡ ${Object.entries(grupos).filter(([c]) => tipoTurno(c)?.labora).flatMap(([, l]) => l).filter(p => p.rol === 'Electricista').length} electricistas</span>
            ${sinProgramar.length ? `<span class="texto-aviso">${sinProgramar.length} sin programar</span>` : ''}
        </div>
        <div class="turno-bloques">${bloques || '<div class="vacio">No hay turnos programados para este día. Cárgalos en <a href="#" onclick="irAProgramacion(); return false;">Programación de turnos</a>.</div>'}</div>`;
}

// ---------------------------------------------------------------
// Sub-vistas de la pestaña
// ---------------------------------------------------------------
const VISTAS_TEC = ['perfiles', 'calificar', 'matriz', 'e360', 'ranking', 'buscar', 'acciones'];
function vistaTecnicos(vista) {
    if (vista === 'turnos') vista = 'perfiles';
    if (vistaTecActual === 'acciones' && vista !== 'acciones' && accionesCambiadas && !confirm('Tienes cambios sin guardar en las acciones a calificar. ¿Salir sin guardar?')) return;
    if (vista !== 'acciones') accionesCambiadas = false;
    vistaTecActual = vista;
    document.querySelectorAll('#tab-tecnicos .subtab').forEach(b => b.classList.toggle('activo', b.dataset.vista === vista));
    VISTAS_TEC.forEach(v => { const el = document.getElementById('tec-vista-' + v); if (el) el.style.display = v === vista ? '' : 'none'; });
    renderVistaTec(vista);
}
function renderVistaTec(vista) {
    if (vista === 'buscar') renderBuscador();
    if (vista === 'perfiles') renderPerfiles();
    if (vista === 'calificar') renderCalificar();
    if (vista === 'matriz') renderMatrizPolivalencia();
    if (vista === 'ranking') renderRanking();
    if (vista === 'e360') cargar360();
    if (vista === 'acciones' && !accionesCambiadas) renderAcciones(true);
    if (vista === 'acciones') cargarAcceso();
}

// ---------------------------------------------------------------
// BUSCADOR: "¿quién me ayuda a cambiar un rodillo?"
// ---------------------------------------------------------------
const GRUPO_ELECTRICO = ['electri', 'motor', 'tablero', 'variador', 'plc', 'sensor', 'cableado', 'instrumento', 'multimetro', 'megger', 'termograf', 'diagrama'];
const GRUPO_MECANICO = ['mecani', 'rodamiento', 'transmision', 'lubric', 'correa', 'cadena', 'rodillo', 'ajuste', 'montaje', 'tolerancia'];
const SINONIMOS = {
    electrico: GRUPO_ELECTRICO, electrica: GRUPO_ELECTRICO, electricidad: GRUPO_ELECTRICO, electricista: GRUPO_ELECTRICO,
    mecanico: GRUPO_MECANICO, mecanica: GRUPO_MECANICO,
    rodillo: ['rodillo', 'rodamiento', 'montaje', 'transmision'], rodillos: ['rodillo', 'rodamiento', 'montaje', 'transmision'],
    rodamiento: ['rodamiento', 'montaje'], rodamientos: ['rodamiento', 'montaje'], balinera: ['rodamiento', 'montaje'],
    correa: ['correa', 'transmision'], banda: ['correa', 'transmision', 'banda'], cadena: ['cadena', 'transmision'],
    plano: ['plano', 'diagrama'], planos: ['plano', 'diagrama'],
    medicion: ['instrumento', 'multimetro', 'megger', 'termograf'], medir: ['instrumento', 'multimetro', 'megger'],
    seguridad: ['lototo', 'bloqueo', 'apr', 'seguridad'], bloqueo: ['lototo', 'bloqueo'],
    falla: ['diagnostico', 'falla', 'causa'], diagnostico: ['diagnostico', 'falla', 'causa'],
    lubricar: ['lubric'], aceite: ['lubric'], engrase: ['lubric'],
    neumatica: ['neumat'], hidraulica: ['hidraul'], soldar: ['soldad'], soldadura: ['soldad']
};
const VACIAS = new Set(['de', 'del', 'la', 'el', 'los', 'las', 'un', 'una', 'para', 'que', 'me', 'ayuda', 'ayude', 'con', 'cambiar', 'cambio', 'quien', 'hacer', 'en', 'y', 'a', 'algo', 'por', 'sabe', 'necesito', 'arreglar', 'reparar', 'revisar', 'o', 'al', 'se', 'mi', 'tecnico']);

function raiz(p) { return p.length > 5 ? p.slice(0, p.length - 2) : p; }

function puntuarTecnico(t, tokens) {
    let total = 0;
    const razones = [];
    const especialidades = (t.especialidades || []).map(e => ({ e, n: normalizarTexto(e) }));
    const habs = tec.habilidades.filter(h => h.rol === t.rol);
    for (const tok of tokens) {
        const terminos = [raiz(tok), ...(SINONIMOS[tok] || [])];
        let mejor = 0, razon = '';
        if (normalizarTexto(t.nombre).includes(tok)) { mejor = 12; razon = ''; }
        const esp = especialidades.find(x => terminos.some(term => x.n.includes(term)));
        if (esp && 8 > mejor) { mejor = 8; razon = `⭐ Especialidad: ${esp.e}`; }
        for (const h of habs) {
            const nivel = Number((t.niveles || {})[h.id]) || 0;
            if (nivel < 2) continue;
            const texto = normalizarTexto(`${h.nombre} ${h.descripcion} ${h.categoria}`);
            if (!terminos.some(term => texto.includes(term))) continue;
            const v = nivel * 2;
            if (v > mejor) { mejor = v; razon = `${h.nombre}: ${tec.niveles[nivel] || nivel}`; }
        }
        if (!mejor) {
            if ((SINONIMOS[tok] === GRUPO_ELECTRICO && t.rol === 'Electricista') || (SINONIMOS[tok] === GRUPO_MECANICO && t.rol === 'Mecánico')) { mejor = 4; razon = `${ICONO_ROL[t.rol]} ${t.rol}`; }
            else if (normalizarTexto(`${t.notas} ${t.cargo} ${t.linea}`).includes(raiz(tok))) { mejor = 2; razon = 'Mencionado en sus notas o línea'; }
        }
        total += mejor;
        if (razon && !razones.includes(razon)) razones.push(razon);
    }
    return { total, razones };
}

function renderChipsBuscador() {
    const cont = document.getElementById('buscar-chips');
    if (!cont) return;
    const chips = ['Rodillos', 'Rodamientos', 'Eléctrico', 'Mecánico', 'Transmisión', 'Planos', 'Instrumentos', 'Lubricación', 'Diagnóstico', 'LOTOTO'];
    cont.innerHTML = chips.map(c => `<button class="chip" onclick="document.getElementById('buscar-tec-texto').value='${c}'; renderBuscador();">${c}</button>`).join('');
}

function renderBuscador() {
    const cont = document.getElementById('buscar-resultados');
    if (!cont || !tec.cargado) return;
    const q = normalizarTexto(document.getElementById('buscar-tec-texto').value);
    const rol = document.getElementById('buscar-tec-rol').value;
    const disp = document.getElementById('buscar-tec-turno')?.value || 'TODOS';
    const hoy = ahoraBogotaCliente().fecha;
    const tokens = q.split(/[^a-z0-9ñ]+/).filter(x => x.length > 1 && !VACIAS.has(x));
    let lista = tec.tecnicos.filter(t => t.activo !== false && (rol === 'TODOS' || t.rol === rol)).map(t => {
        const s = tokens.length ? puntuarTecnico(t, tokens) : { total: 0, razones: [] };
        const cod = codigoTurno(t.id, hoy);
        const ahora = turnoActivoAhora(t.id);
        return { t, ...s, cod, labora: !!tipoTurno(cod)?.labora, ahora };
    });
    if (tokens.length) lista = lista.filter(x => x.total > 0);
    if (disp === 'HOY') lista = lista.filter(x => x.labora);
    if (disp === 'AHORA') lista = lista.filter(x => x.ahora);
    lista.sort((a, b) => b.total - a.total || (b.ahora ? 1 : 0) - (a.ahora ? 1 : 0) || (b.labora ? 1 : 0) - (a.labora ? 1 : 0) || (b.t.puntaje || 0) - (a.t.puntaje || 0));
    if (!tec.tecnicos.length) {
        cont.innerHTML = '<div class="vacio">Aún no hay técnicos. Agrégalos en <a href="#" onclick="vistaTecnicos(\'perfiles\'); return false;">Perfiles</a> o importa la matriz desde Excel.</div>';
        return;
    }
    if (!lista.length) {
        cont.innerHTML = `<div class="vacio">Nadie coincide con "${escaparHTML(q)}"${disp !== 'TODOS' ? ' en ese turno' : ''}. Prueba con otra palabra o agrega esa especialidad al perfil del técnico que la domina.</div>`;
        return;
    }
    cont.innerHTML = lista.slice(0, 60).map(({ t, razones, cod, ahora }) => tarjetaTecnico(t, {
        razones, cod, ahora,
        acciones: `<button class="btn btn-secondary btn-sm" onclick="abrirPerfil('${attr(t.id)}')">🪪 Perfil</button>
                   <button class="btn btn-primary btn-sm" onclick="irACalificar('${attr(t.id)}')">⭐ Calificar</button>`
    })).join('');
}

function tarjetaTecnico(t, { razones = [], cod, ahora, acciones = '' } = {}) {
    const hoy = ahoraBogotaCliente().fecha;
    cod = cod === undefined ? codigoTurno(t.id, hoy) : cod;
    const variacion = t.variacion != null ? `<span class="${t.variacion >= 0 ? 'sube' : 'baja'}">${t.variacion >= 0 ? '▲' : '▼'} ${Math.abs(Math.round(t.variacion * 100))} pts</span>` : '';
    return `<div class="tarjeta-tecnico ${ahora ? 'en-turno' : ''}">
        <div class="tt-cab">
            <div class="tt-avatar">${ICONO_ROL[t.rol] || '👤'}</div>
            <div class="tt-nombre">
                <strong>${escaparHTML(t.nombre)}</strong>
                <small>${escaparHTML(t.rol)}${t.cargo ? ' · ' + escaparHTML(t.cargo) : ''}${t.area ? ' · ' + escaparHTML(t.area) : ''}${t.linea ? ' · ' + escaparHTML(t.linea) : ''}</small>
                ${t.supervisor ? `<small>👔 ${escaparHTML(t.supervisor)}</small>` : ''}
            </div>
            <div class="tt-puntaje" title="Calificación de ingeniería">${pct(t.puntaje)}${variacion}${chip360(t)}</div>
        </div>
        ${MOSTRAR_TURNOS ? `<div class="tt-turno">Hoy: ${badgeTurno(cod)} ${ahora ? '<span class="badge badge-realizado">🟢 En turno ahora</span>' : ''}</div>` : ''}
        ${barraAvance(t)}
        ${razones.length ? `<ul class="tt-razones">${razones.slice(0, 4).map(r => `<li>${escaparHTML(r)}</li>`).join('')}</ul>` : ''}
        ${(t.especialidades || []).length ? `<div class="tt-esp">${t.especialidades.slice(0, 6).map(e => `<span>${escaparHTML(e)}</span>`).join('')}</div>` : ''}
        <div class="tt-acciones">
            ${t.telefono ? `<a class="btn btn-secondary btn-sm" href="tel:${attr(t.telefono.replace(/[^\d+]/g, ''))}" style="text-decoration:none;">📞 ${escaparHTML(t.telefono)}</a>` : ''}
            ${acciones}
        </div>
    </div>`;
}

function asignarAPendiente(id) {
    const t = tec.tecnicos.find(x => x.id === id);
    if (!t) return;
    switchTab('daily');
    vistaDaily('hoy');
    abrirModalNuevoCompromiso();
    document.getElementById('daily-create-responsable').value = t.nombre;
    if (t.linea) document.getElementById('daily-create-linea').value = t.linea;
}

// Chips con quienes laboran ese día, para armar el responsable del pendiente
function sugerirResponsables() {
    const cont = document.getElementById('daily-create-sugeridos');
    if (!cont) return;
    const fecha = document.getElementById('daily-create-fecha')?.value || ahoraBogotaCliente().fecha;
    const enTurno = tec.tecnicos.filter(t => t.activo !== false && tipoTurno(codigoTurno(t.id, fecha))?.labora);
    cont.innerHTML = enTurno.length
        ? '<small>En turno ese día:</small> ' + enTurno.map(t => `<button type="button" class="chip" onclick="agregarResponsable('${attr(t.nombre.replace(/'/g, "\\'"))}')">${ICONO_ROL[t.rol] || ''} ${escaparHTML(t.nombre)} <em>${escaparHTML(tipoTurno(codigoTurno(t.id, fecha)).codigo)}</em></button>`).join('')
        : '';
}
function agregarResponsable(nombre) {
    const campo = document.getElementById('daily-create-responsable');
    const actuales = campo.value.split('/').map(x => x.trim()).filter(Boolean);
    if (!actuales.includes(nombre)) actuales.push(nombre);
    campo.value = actuales.join(' / ');
}
document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('daily-create-fecha')?.addEventListener('change', sugerirResponsables);
});

// ---------------------------------------------------------------
// PERFILES
// ---------------------------------------------------------------
function renderPerfiles() {
    const cont = document.getElementById('perfiles-lista');
    if (!cont || !tec.cargado) return;
    const q = normalizarTexto(document.getElementById('perfiles-buscar').value);
    const rol = document.getElementById('perfiles-rol').value;
    const orden = document.getElementById('perfiles-orden')?.value || 'nombre';
    const area = filtroArea('perfiles-area');
    const lista = tec.tecnicos.filter(t => (rol === 'TODOS' || t.rol === rol) && (area === 'TODAS' || (t.area || '') === area) &&
        (!q || normalizarTexto([t.nombre, t.rol, t.linea, t.cargo, t.area, t.supervisor, ...(t.especialidades || [])].join(' ')).includes(q)))
        .sort((a, b) => (b.activo !== false) - (a.activo !== false)
            || (orden === 'puntaje' ? (b.puntaje ?? -1) - (a.puntaje ?? -1) : 0)
            || (orden === 'pendientes' ? avance(a).hechas / (avance(a).total || 1) - avance(b).hechas / (avance(b).total || 1) : 0)
            || a.nombre.localeCompare(b.nombre, 'es'));
    // Agrupados por especialidad
    const grupos = {};
    lista.forEach(t => (grupos[t.rol] = grupos[t.rol] || []).push(t));
    const roles = rolesCatalogo().filter(r => grupos[r]).concat(Object.keys(grupos).filter(r => !rolesCatalogo().includes(r)));
    cont.innerHTML = lista.length ? roles.map(r => `
        <div class="grupo-rol">
            <div class="grupo-rol-titulo">${ICONO_ROL[r] || '👤'} ${escaparHTML(r)} <span>${grupos[r].length}</span></div>
            <div class="tarjetas-tecnicos">${grupos[r].map(t => tarjetaTecnico(t, {
                acciones: `<button class="btn btn-primary btn-sm" onclick="irACalificar('${attr(t.id)}')">⭐ Calificar</button>
                           <button class="btn btn-secondary btn-sm" onclick="abrirPerfil('${attr(t.id)}')">✏️ Perfil</button>${t.activo === false ? ' <span class="badge badge-gris">Inactivo</span>' : ''}`
            })).join('')}</div>
        </div>`).join('') : `<div class="vacio">${tec.tecnicos.length ? 'Ningún técnico coincide.' : 'Aún no hay técnicos. Usa <strong>➕ Nuevo técnico</strong> para crear el primero: nombre, especialidad y listo, después lo calificas en ⭐ Calificar.'}</div>`;
}

let perfilNiveles = {};
function abrirPerfil(id) {
    const t = id ? tec.tecnicos.find(x => x.id === id) : null;
    document.getElementById('perfil-titulo').textContent = t ? t.nombre : 'Nuevo técnico';
    document.getElementById('perfil-id').value = t ? t.id : '';
    document.getElementById('perfil-nombre').value = t ? t.nombre : '';
    const selRol = document.getElementById('perfil-rol');
    const rolPorDefecto = (document.getElementById('perfiles-rol')?.value || 'TODOS') !== 'TODOS' ? document.getElementById('perfiles-rol').value : (rolesCatalogo()[0] || 'Mecánico');
    const rolElegido = t ? t.rol : rolPorDefecto;
    if (![...selRol.options].some(o => o.value === rolElegido)) selRol.add(new Option(rolElegido, rolElegido));
    selRol.value = rolElegido;
    document.getElementById('perfil-cargo').value = t ? t.cargo || '' : '';
    const selLinea = document.getElementById('perfil-linea');
    if (t && t.linea && ![...selLinea.options].some(o => o.value === t.linea)) selLinea.add(new Option(t.linea, t.linea));
    selLinea.value = t ? t.linea || '' : '';
    document.getElementById('perfil-telefono').value = t ? t.telefono || '' : '';
    document.getElementById('perfil-correo').value = t ? t.correo || '' : '';
    document.getElementById('perfil-especialidades').value = t ? (t.especialidades || []).join(', ') : '';
    document.getElementById('perfil-notas').value = t ? t.notas || '' : '';
    document.getElementById('perfil-area').value = t ? t.area || '' : (filtroArea('perfiles-area') !== 'TODAS' ? filtroArea('perfiles-area') : '');
    document.getElementById('perfil-supervisor').value = t ? t.supervisor || '' : '';
    document.getElementById('perfil-supervisor-correo').value = t ? t.supervisorCorreo || '' : '';
    document.getElementById('perfil-activo').value = t && t.activo === false ? 'false' : 'true';
    document.getElementById('perfil-periodo').textContent = tec.periodoActual;
    document.getElementById('perfil-eliminar').style.display = t ? '' : 'none';
    perfilNiveles = t ? { ...(t.niveles || {}) } : {};

    const resumen = document.getElementById('perfil-resumen');
    const extra = document.getElementById('perfil-extra');
    if (t) {
        const hoy = ahoraBogotaCliente().fecha;
        const lunes = lunesISO(hoy);
        const semana = [...Array(7)].map((_, i) => sumarDiasISO(lunes, i));
        const n = normalizarTexto(t.nombre).split(' ').filter(x => x.length > 2).slice(0, 2);
        const pend = dailyTasksData.filter(p => !p.eliminado && n.length && n.every(x => normalizarTexto(p.responsable).includes(x)))
            .sort((a, b) => fechaPend(b).localeCompare(fechaPend(a))).slice(0, 8);
        const habs = tec.habilidades.filter(h => h.rol === t.rol);
        const fuertes = habs.filter(h => (t.niveles || {})[h.id] >= 4).map(h => h.nombre);
        const formar = habs.filter(h => (t.niveles || {})[h.id] && (t.niveles || {})[h.id] <= 2).map(h => h.nombre);
        resumen.innerHTML = `
            <div class="perfil-kpis">
                <div><span>${pct(t.puntaje)}</span>Ingeniería ${escaparHTML(t.periodo || "")}</div>
                <div><span>${t.variacion == null ? '—' : (t.variacion >= 0 ? '▲ ' : '▼ ') + Math.abs(Math.round(t.variacion * 100)) + ' pts'}</span>vs ${escaparHTML(t.periodoAnterior || 'semestre anterior')}</div>
                <div><span>${avance(t).hechas}/${avance(t).total}</span>Acciones calificadas</div>
            </div>
            ${resumen360Html(t)}
            ${fuertes.length ? `<p class="perfil-linea">💪 <strong>Experto en:</strong> ${fuertes.map(escaparHTML).join(', ')}</p>` : ''}
            ${formar.length ? `<p class="perfil-linea">📚 <strong>Por formar:</strong> ${formar.map(escaparHTML).join(', ')}</p>` : ''}`;
        extra.innerHTML = !MOSTRAR_TURNOS ? '' : `
            <div class="form-group" style="margin-top: 14px;"><label>Esta semana</label>
                <div class="semana-mini">${semana.map((f, i) => `<div class="${f === hoy ? 'hoy' : ''}"><small>${DIAS_CORTOS[i]} ${f.slice(8)}</small>${(() => { const c = codigoTurno(t.id, f); const tt = tipoTurno(c); return tt ? `<b style="color:${tt.color}">${escaparHTML(tt.codigo)}</b>` : '<b>—</b>'; })()}</div>`).join('')}</div>
            </div>
            ${pend.length ? `<div class="form-group"><label>Pendientes asignados recientes</label><div class="mini-historial">${pend.map(p => `<div><span>${fechaTxt(fechaPend(p))}</span> · <strong>${escaparHTML(p.equipo)}</strong>: ${escaparHTML(p.compromiso)} — ${badgeEstadoPendiente(p)}</div>`).join('')}</div></div>` : ''}`;
    } else {
        resumen.innerHTML = '';
        extra.innerHTML = '';
    }
    renderNivelesPerfil();
    document.getElementById('modal-perfil').classList.add('active');
}

function renderNivelesPerfil() {
    const rol = document.getElementById('perfil-rol').value;
    const habs = tec.habilidades.filter(h => h.rol === rol);
    const cont = document.getElementById('perfil-niveles');
    if (!habs.length) { cont.innerHTML = '<p style="font-size: 13px; color: var(--text-muted);">Este rol no tiene habilidades en la matriz.</p>'; return; }
    const cats = [...new Set(habs.map(h => h.categoria))];
    cont.innerHTML = cats.map(c => `
        <div class="niveles-cat">
            <div class="niveles-cat-titulo">${escaparHTML(c)}</div>
            ${habs.filter(h => h.categoria === c).map(h => `
                <div class="nivel-fila" title="${attr(h.descripcion)}">
                    <span>${escaparHTML(h.nombre)} <small>${Math.round(h.peso * 100)}%</small></span>
                    <div class="selector-nivel">${[1, 2, 3, 4].map(n => `<button type="button" class="nivel n${n} ${Number(perfilNiveles[h.id]) === n ? 'sel' : ''}" onclick="elegirNivelPerfil('${h.id}', ${n})" title="${tec.niveles[n]}">${n}</button>`).join('')}</div>
                </div>`).join('')}
        </div>`).join('');
}
function elegirNivelPerfil(h, n) {
    perfilNiveles[h] = Number(perfilNiveles[h]) === n ? 0 : n;
    renderNivelesPerfil();
}

async function guardarPerfil(e) {
    e.preventDefault();
    const datos = {
        id: document.getElementById('perfil-id').value || undefined,
        nombre: document.getElementById('perfil-nombre').value,
        rol: document.getElementById('perfil-rol').value,
        cargo: document.getElementById('perfil-cargo').value,
        linea: document.getElementById('perfil-linea').value,
        telefono: document.getElementById('perfil-telefono').value,
        correo: document.getElementById('perfil-correo').value,
        especialidades: document.getElementById('perfil-especialidades').value,
        notas: document.getElementById('perfil-notas').value,
        area: document.getElementById('perfil-area').value,
        supervisor: document.getElementById('perfil-supervisor').value,
        supervisorCorreo: document.getElementById('perfil-supervisor-correo').value,
        activo: document.getElementById('perfil-activo').value === 'true',
        niveles: perfilNiveles,
        usuario: usuarioActual.nombre
    };
    try {
        await postJSON('/api/tecnicos/guardar', datos);
        cerrarModal('modal-perfil');
        await cargarTecnicos();
        renderTodoTecnicos();
    } catch (err) { alert('❌ ' + err.message); }
}

async function eliminarPerfil() {
    const id = document.getElementById('perfil-id').value;
    const t = tec.tecnicos.find(x => x.id === id);
    if (!t || !confirm(`¿Eliminar a ${t.nombre}? Se borran su perfil, su matriz y sus turnos.\n\nSi solo dejó de trabajar aquí, mejor cambia su Estado a Inactivo: así se conserva su historial.`)) return;
    try {
        await postJSON('/api/tecnicos/eliminar', { id, usuario: usuarioActual.nombre });
        cerrarModal('modal-perfil');
        await recargarTecnicos();
    } catch (err) { alert('❌ ' + err.message); }
}

async function importarMatrizExcel(input, soloTecnicos) {
    const archivo = input.files[0];
    input.value = '';
    if (!archivo) return;
    if (soloTecnicos ? !confirm(`¿Cargar "${archivo.name}"?\n\nSe actualizan los técnicos por nombre (área, cargo, supervisor, correo...) y se crean los que no existan. Las calificaciones no cambian.`) : !confirm(`¿Importar "${archivo.name}"?\n\nSe agregan o actualizan los técnicos por nombre/código, y si el archivo trae la hoja DimHabilidad se reemplaza el catálogo de habilidades.`)) return;
    try {
        const r = await fetch('/api/tecnicos/importar', { method: 'POST', body: archivo });
        const j = await r.json();
        if (!r.ok) throw new Error(j.error || 'No se pudo importar.');
        alert(`✅ Importado.\n• ${j.tecnicosNuevos} técnicos nuevos\n• ${j.tecnicosActualizados} actualizados\n• ${j.habilidades || 'sin cambios en las'} habilidades\n• ${j.evaluaciones} calificaciones${(j.avisos || []).length ? '\n\n⚠️ ' + j.avisos.join('\n') : ''}`);
        await cargarTecnicos();
        renderTodoTecnicos();
    } catch (err) { alert('❌ ' + err.message); }
}

// ---------------------------------------------------------------
// MATRIZ DE POLIVALENCIA
// ---------------------------------------------------------------
function renderMatrizPolivalencia() {
    const tabla = document.getElementById('matriz-polivalencia');
    if (!tabla || !tec.cargado) return;
    document.getElementById('matriz-periodo').textContent = 'semestre actual ' + tec.periodoActual;
    const rol = document.getElementById('matriz-rol').value;
    const fuente = fuenteActiva();
    document.getElementById('matriz-fuente').style.display = hay360() ? '' : 'none';
    const editar = document.getElementById('matriz-editar').checked && fuente === 'ingenieria';
    document.getElementById('matriz-editar').parentElement.style.display = fuente === 'ingenieria' ? '' : 'none';
    const habs = tec.habilidades.filter(h => h.rol === rol);
    const hoy = ahoraBogotaCliente().fecha;
    const lista = tec.tecnicos.filter(t => t.rol === rol && t.activo !== false);
    if (document.getElementById('matriz-orden').value === 'nombre') lista.sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));
    else lista.sort((a, b) => (puntajeVista(b) ?? -1) - (puntajeVista(a) ?? -1));
    if (!lista.length) { tabla.innerHTML = `<tr><td style="padding: 20px; color: var(--text-muted);">Todavía no hay técnicos de ${escaparHTML(rol)}. Créalos en 🪪 Técnicos → ➕ Nuevo técnico.</td></tr>`; return; }
    const cats = [];
    habs.forEach(h => { const c = cats.find(x => x.nombre === h.categoria); if (c) c.n++; else cats.push({ nombre: h.categoria, n: 1 }); });
    // Fila final: promedio por habilidad (dónde está la brecha del equipo)
    const promedio = h => {
        const v = lista.map(t => Number(nivelesVista(t)[h.id])).filter(Boolean);
        return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
    };
    tabla.innerHTML = `
        <thead>
            <tr><th rowspan="2" class="col-fija">#&nbsp;Técnico</th>${MOSTRAR_TURNOS ? '<th rowspan="2">Hoy</th>' : ''}${cats.map(c => `<th colspan="${c.n}" class="cat">${escaparHTML(c.nombre)}</th>`).join('')}<th rowspan="2">${fuente === 'final' ? 'Final 360°' : 'Puntaje'}</th></tr>
            <tr>${habs.map(h => `<th class="hab" title="${attr(h.descripcion)} · peso ${Math.round(h.peso * 100)}%"><span>${escaparHTML(h.nombre)}</span></th>`).join('')}</tr>
        </thead>
        <tbody>
            ${lista.map((t, i) => `<tr>
                <td class="col-fija"><button class="link" onclick="abrirPerfil('${attr(t.id)}')">${i + 1}. ${escaparHTML(t.nombre)}</button></td>
                ${MOSTRAR_TURNOS ? `<td>${(() => { const tt = tipoTurno(codigoTurno(t.id, hoy)); return tt ? `<span class="cod-turno" style="background:${tt.color}">${escaparHTML(tt.codigo)}</span>` : '—'; })()}</td>` : ''}
                ${habs.map(h => {
                    const n = Number(nivelesVista(t)[h.id]) || 0;
                    if (fuente === 'final') return `<td class="nivel-celda n${Math.round(n)}" title="${attr(h.nombre)}: ${n ? n.toFixed(2) + ' (final ponderado)' : 'Sin calificar'}">${n ? (Math.round(n * 10) / 10).toFixed(1) : '—'}</td>`;
                    return editar
                        ? `<td class="nivel-celda n${n}"><select onchange="cambiarNivel('${attr(t.id)}', '${h.id}', this.value)"><option value="0">—</option>${[1, 2, 3, 4].map(v => `<option value="${v}" ${v === n ? 'selected' : ''}>${v}</option>`).join('')}</select></td>`
                        : `<td class="nivel-celda n${n}" title="${attr(h.nombre)}: ${n ? tec.niveles[n] : 'Sin evaluar'}">${n || '—'}</td>`;
                }).join('')}
                <td class="puntaje-celda">${fuente === 'final' ? `${pct(puntajeVista(t))}<small style="color: var(--text-muted);">Ing ${pct(t.puntaje)}</small>` : pct(t.puntaje)}${fuente !== 'final' && t.variacion != null ? `<small class="${t.variacion >= 0 ? 'sube' : 'baja'}">${t.variacion >= 0 ? '▲' : '▼'}${Math.abs(Math.round(t.variacion * 100))}</small>` : ''}</td>
            </tr>`).join('')}
            <tr class="fila-promedio"><td class="col-fija">Promedio del equipo</td>${MOSTRAR_TURNOS ? '<td></td>' : ''}${habs.map(h => { const p = promedio(h); return `<td class="nivel-celda n${p ? Math.round(p) : 0}">${p ? p.toFixed(1) : '—'}</td>`; }).join('')}<td></td></tr>
        </tbody>`;
}

async function cambiarNivel(id, hab, valor) {
    try {
        const r = await postJSON('/api/tecnicos/evaluar', { id, niveles: { [hab]: Number(valor) }, usuario: usuarioActual.nombre });
        const t = tec.tecnicos.find(x => x.id === id);
        if (t) {
            t.niveles = { ...(t.niveles || {}) };
            if (Number(valor)) t.niveles[hab] = Number(valor); else delete t.niveles[hab];
            Object.assign(t, { puntaje: r.puntaje, variacion: r.variacion, periodo: r.periodo, periodoAnterior: r.periodoAnterior });
        }
        renderMatrizPolivalencia();
    } catch (err) { alert('❌ ' + err.message); }
}

// ---------------------------------------------------------------
// PROGRAMACIÓN DE TURNOS
// ---------------------------------------------------------------
async function cargarTurnos() {
    const campo = document.getElementById('turnos-semana');
    turnos.semana = lunesISO(campo.value || ahoraBogotaCliente().fecha);
    campo.value = turnos.semana;
    try { await cargarRangoTurnos(turnos.semana, sumarDiasISO(turnos.semana, 6)); } catch (e) { /* se dibuja lo que haya */ }
    renderTurnos();
}
function moverSemana(n) {
    const campo = document.getElementById('turnos-semana');
    campo.value = sumarDiasISO(lunesISO(campo.value || ahoraBogotaCliente().fecha), n);
    cargarTurnos();
}

function renderTurnos() {
    const tabla = document.getElementById('tabla-turnos');
    if (!tabla || !tec.cargado) return;
    const lunes = turnos.semana || lunesISO(ahoraBogotaCliente().fecha);
    const dias = [...Array(7)].map((_, i) => sumarDiasISO(lunes, i));
    const hoy = ahoraBogotaCliente().fecha;
    const rol = document.getElementById('turnos-rol').value;
    const lista = tec.tecnicos.filter(t => t.activo !== false && (rol === 'TODOS' || t.rol === rol))
        .sort((a, b) => (a.rol || '').localeCompare(b.rol || '') || a.nombre.localeCompare(b.nombre, 'es'));
    document.getElementById('leyenda-turnos').innerHTML = turnos.tipos.map(t =>
        `<span><b class="cod-turno" style="background:${t.color}">${escaparHTML(t.codigo)}</b> ${escaparHTML(t.nombre)}${t.inicio ? ' ' + t.inicio + '–' + t.fin : ''}</span>`).join('');
    if (!lista.length) { tabla.innerHTML = '<tr><td style="padding: 20px; color: var(--text-muted);">No hay técnicos registrados todavía.</td></tr>'; return; }
    const opciones = sel => `<option value="">—</option>` + turnos.tipos.map(t => `<option value="${attr(t.codigo)}" ${t.codigo === sel ? 'selected' : ''}>${escaparHTML(t.codigo)} · ${escaparHTML(t.nombre)}</option>`).join('');
    const cobertura = f => turnos.tipos.filter(t => t.labora).map(t => {
        const n = lista.filter(p => codigoTurno(p.id, f) === t.codigo).length;
        return n ? `<span style="color:${t.color}">${escaparHTML(t.codigo)} ${n}</span>` : '';
    }).filter(Boolean).join(' · ') || '<span style="color: var(--status-red);">Nadie</span>';
    tabla.innerHTML = `
        <thead><tr><th class="col-fija">Técnico</th>${dias.map((f, i) => `<th class="${f === hoy ? 'col-hoy' : ''}">${DIAS_CORTOS[i]}<br><small>${f.slice(8)}/${f.slice(5, 7)}</small></th>`).join('')}</tr></thead>
        <tbody>
            ${lista.map(t => `<tr>
                <td class="col-fija"><button class="link" onclick="abrirPerfil('${attr(t.id)}')">${ICONO_ROL[t.rol] || '👤'} ${escaparHTML(t.nombre)}</button></td>
                ${dias.map(f => {
                    const c = codigoTurno(t.id, f);
                    const tt = tipoTurno(c);
                    return `<td class="${f === hoy ? 'col-hoy' : ''}"><select class="sel-turno" style="${tt ? `background:${tt.color}33;border-color:${tt.color};` : ''}" data-tec="${attr(t.id)}" data-fecha="${f}" onchange="cambiarTurno(this)">${opciones(c)}</select></td>`;
                }).join('')}
            </tr>`).join('')}
            <tr class="fila-promedio"><td class="col-fija">Cobertura</td>${dias.map(f => `<td class="${f === hoy ? 'col-hoy' : ''}" style="font-size: 11px;">${cobertura(f)}</td>`).join('')}</tr>
        </tbody>`;
}

async function cambiarTurno(sel) {
    const cambio = { tecnicoId: sel.dataset.tec, fecha: sel.dataset.fecha, codigo: sel.value };
    const previo = codigoTurno(cambio.tecnicoId, cambio.fecha);
    turnos.asignaciones[cambio.fecha] = turnos.asignaciones[cambio.fecha] || {};
    if (cambio.codigo) turnos.asignaciones[cambio.fecha][cambio.tecnicoId] = cambio.codigo; else delete turnos.asignaciones[cambio.fecha][cambio.tecnicoId];
    renderTurnos();
    renderTurnoHoy();
    try {
        await postJSON('/api/turnos/asignar', { cambios: [cambio], usuario: usuarioActual.nombre });
    } catch (err) {
        if (previo) turnos.asignaciones[cambio.fecha][cambio.tecnicoId] = previo; else delete turnos.asignaciones[cambio.fecha][cambio.tecnicoId];
        renderTurnos();
        alert('❌ No se guardó: ' + err.message);
    }
}

async function copiarSemanaAnterior() {
    const destino = turnos.semana;
    const origen = sumarDiasISO(destino, -7);
    const sobrescribir = confirm(`Copiar la programación de la semana del ${fechaTxt(origen)} a la del ${fechaTxt(destino)}.\n\nAceptar = reemplazar también lo que ya esté programado.\nCancelar = solo llenar los días vacíos.`);
    try {
        const r = await postJSON('/api/turnos/copiar-semana', { origen, destino, sobrescribir, usuario: usuarioActual.nombre });
        await cargarTurnos();
        renderTurnoHoy();
        mostrarNotificacionToast('Turnos', `${r.cambios} turnos copiados.`);
    } catch (err) { alert('❌ ' + err.message); }
}

function descargarPlantillaTurnos() {
    window.location.href = `/api/turnos/plantilla?semana=${turnos.semana}`;
}

async function importarTurnosExcel(input) {
    const archivo = input.files[0];
    input.value = '';
    if (!archivo) return;
    try {
        const r = await fetch('/api/turnos/importar', { method: 'POST', body: archivo });
        const j = await r.json();
        if (!r.ok) throw new Error(j.error || 'No se pudo cargar.');
        let msg = `✅ Programación cargada del ${fechaTxt(j.desde)} al ${fechaTxt(j.hasta)} (${j.celdas} celdas).`;
        if (j.noEncontrados.length) msg += `\n\n⚠️ No encontré estos técnicos (créalos primero en Perfiles): ${j.noEncontrados.join(', ')}`;
        if (j.codigosDesconocidos.length) msg += `\n\n⚠️ Códigos de turno desconocidos (se ignoraron): ${j.codigosDesconocidos.join(', ')}`;
        alert(msg);
        document.getElementById('turnos-semana').value = j.desde;
        await cargarTurnos();
        renderTurnoHoy();
    } catch (err) { alert('❌ ' + err.message); }
}

let tiposEditando = [];
function abrirTiposTurno() {
    tiposEditando = turnos.tipos.map(t => ({ ...t }));
    renderTiposTurno();
    document.getElementById('modal-tipos-turno').classList.add('active');
}
function renderTiposTurno() {
    document.getElementById('tipos-turno-lista').innerHTML = tiposEditando.map((t, i) => `
        <div class="tipo-turno-fila">
            <input class="form-control" value="${attr(t.codigo)}" maxlength="4" placeholder="Cód." oninput="tiposEditando[${i}].codigo = this.value">
            <input class="form-control" value="${attr(t.nombre)}" placeholder="Nombre" oninput="tiposEditando[${i}].nombre = this.value">
            <input class="form-control" type="time" value="${attr(t.inicio)}" oninput="tiposEditando[${i}].inicio = this.value">
            <input class="form-control" type="time" value="${attr(t.fin)}" oninput="tiposEditando[${i}].fin = this.value">
            <input type="color" value="${attr(t.color)}" oninput="tiposEditando[${i}].color = this.value">
            <label class="interruptor"><input type="checkbox" ${t.labora ? 'checked' : ''} onchange="tiposEditando[${i}].labora = this.checked"> Labora</label>
            <button type="button" class="btn btn-danger btn-sm" onclick="tiposEditando.splice(${i}, 1); renderTiposTurno();">✕</button>
        </div>`).join('');
}
function agregarTipoTurno() {
    tiposEditando.push({ codigo: '', nombre: '', inicio: '', fin: '', color: '#0ea5e9', labora: true });
    renderTiposTurno();
}
async function guardarTiposTurno() {
    try {
        const r = await postJSON('/api/turnos/tipos', { tipos: tiposEditando, usuario: usuarioActual.nombre });
        turnos.tipos = r.tipos;
        cerrarModal('modal-tipos-turno');
        renderTurnos();
        renderTurnoHoy();
    } catch (err) { alert('❌ ' + err.message); }
}

// ---------------------------------------------------------------
// NOTIFICACIONES AUTOMÁTICAS
// ---------------------------------------------------------------
let notif = null;
const DIAS_LETRA = ['L', 'M', 'X', 'J', 'V', 'S', 'D'];

async function cargarNotificaciones() {
    try {
        notif = await (await fetch('/api/notificaciones')).json();
    } catch (e) { return; }
    document.getElementById('notif-rec-activo').checked = notif.recordatorio.activo;
    document.getElementById('notif-rec-hora').value = notif.recordatorio.hora;
    document.getElementById('notif-rec-anticipacion').value = notif.recordatorio.anticipacion;
    renderDias('notif-rec-dias', notif.recordatorio.dias);
    renderIngenieros();
    renderEstadoPowerAutomate();
    fetch('/api/status').then(r => r.json()).then(st => {
        const caja = document.getElementById('estado-base-datos');
        if (!caja) return;
        caja.innerHTML = st.baseDatos === 'conectada'
            ? '🟢 <strong>MongoDB Atlas conectada.</strong> Los ACR, sus acciones y el historial se guardan en la nube y no se pierden aunque Render se reinicie.'
            : `🔴 <strong>Base de datos ${escaparHTML(st.baseDatos || 'sin configurar')}.</strong> Revisa MONGODB_URI en Render.`;
    }).catch(() => {});
}

function renderDias(id, dias) {
    document.getElementById(id).innerHTML = DIAS_LETRA.map((l, i) =>
        `<label class="dia ${dias.includes(i + 1) ? 'sel' : ''}"><input type="checkbox" value="${i + 1}" ${dias.includes(i + 1) ? 'checked' : ''} onchange="this.parentElement.classList.toggle('sel', this.checked)">${l}</label>`).join('');
}
function leerDias(id) {
    return [...document.querySelectorAll(`#${id} input:checked`)].map(x => Number(x.value));
}

function renderIngenieros() {
    const cont = document.getElementById('notif-ingenieros');
    const lineas = ['Todas', ...(notif.lineas || [])];
    cont.innerHTML = (notif.ingenieros || []).length ? notif.ingenieros.map((ing, i) => `
        <div class="ingeniero-fila">
            <input class="form-control" placeholder="Nombre" value="${attr(ing.nombre)}" oninput="notif.ingenieros[${i}].nombre = this.value">
            <input class="form-control" type="email" placeholder="correo@kcc.com" value="${attr(ing.correo)}" oninput="notif.ingenieros[${i}].correo = this.value">
            <div class="lineas-check">${lineas.map(l => `<label class="${(ing.lineas || []).includes(l) ? 'sel' : ''}"><input type="checkbox" ${(ing.lineas || []).includes(l) ? 'checked' : ''} onchange="alternarLineaIng(${i}, '${l}', this.checked)">${l}</label>`).join('')}</div>
            <button class="btn btn-danger btn-sm" onclick="notif.ingenieros.splice(${i}, 1); renderIngenieros();">✕</button>
        </div>`).join('') : '<div class="vacio">Todavía no hay destinatarios. Agrega al menos un correo con sus líneas para que salga el correo automático.</div>';
}
function alternarLineaIng(i, linea, marcado) {
    const ing = notif.ingenieros[i];
    ing.lineas = (ing.lineas || []).filter(l => l !== linea);
    if (marcado) ing.lineas.push(linea);
    renderIngenieros();
}
function agregarIngeniero() {
    notif.ingenieros = notif.ingenieros || [];
    notif.ingenieros.push({ nombre: notif.ingenieros.length ? '' : usuarioActual.nombre, correo: notif.ingenieros.length ? '' : usuarioActual.correo, lineas: ['Todas'] });
    renderIngenieros();
}

async function guardarNotificaciones() {
    const datos = {
        ingenieros: notif.ingenieros,
        copia: [],
        recordatorio: {
            activo: document.getElementById('notif-rec-activo').checked,
            hora: document.getElementById('notif-rec-hora').value,
            anticipacion: Number(document.getElementById('notif-rec-anticipacion').value),
            dias: leerDias('notif-rec-dias')
        },
        cierre: { activo: false, hora: '18:00', dias: [] }
    };
    try {
        await postJSON('/api/notificaciones', datos);
        mostrarNotificacionToast('Notificaciones', 'Configuración guardada.');
        cargarNotificaciones();
    } catch (err) { alert('❌ ' + err.message); }
}

async function vistaPreviaNotificacion(tipo) {
    const box = document.getElementById('ps-console-output');
    const prev = document.getElementById('alerta-preview');
    box.textContent = '⏳ Generando…';
    try {
        const r = await (await fetch(`/api/notificaciones/vista-previa?tipo=${tipo}`)).json();
        box.textContent = r.asunto ? `Asunto: ${r.asunto}\n(vista previa con todas las líneas; cada persona recibe solo sus líneas)` : 'Nada que enviar ahora mismo.';
        prev.innerHTML = r.html;
        prev.style.display = 'block';
    } catch (e) { box.textContent = '❌ No se pudo generar.'; }
}

async function probarNotificacion(tipo) {
    const box = document.getElementById('ps-console-output');
    box.textContent = '⏳ Enviando prueba…';
    try {
        const r = await postJSON('/api/notificaciones/probar', { tipo });
        box.textContent = r.output;
        cargarNotificaciones();
    } catch (err) { box.textContent = '❌ ' + err.message; }
}

function renderEstadoPowerAutomate() {
    const caja = document.getElementById('alertas-auto-estado');
    if (!caja || !notif) return;
    const fecha = iso => iso ? new Date(iso).toLocaleString('es-CO', { dateStyle: 'short', timeStyle: 'short' }) : 'nunca';
    if (notif.via !== 'powerautomate') { caja.textContent = 'Los correos salen directamente desde la app (Brevo).'; return; }
    const pa = notif.powerAutomate || {};
    const reciente = pa.ultimaLecturaEnvios && Date.now() - new Date(pa.ultimaLecturaEnvios) < 30 * 60 * 1000;
    const st = notif.estado || {};
    caja.innerHTML = `
        <div style="font-weight: 600; margin-bottom: 6px; color: ${reciente ? 'var(--status-green)' : 'var(--status-yellow)'};">
            ${reciente ? '🟢 Flujo de Power Automate conectado' : '🟡 El flujo de Power Automate no ha revisado la app en los últimos 30 minutos (si no está creado, los correos no salen)'}
        </div>
        <div>Última revisión del flujo: <strong>${escaparHTML(fecha(pa.ultimaLecturaEnvios))}</strong></div>
        <div>Último correo automático: <strong>${escaparHTML(st.ultimoRecordatorio ? fechaTxt(st.ultimoRecordatorio) : 'aún no')}</strong></div>
        ${(pa.ultimosEnvios || []).length ? `<div style="margin-top: 8px;">Últimos correos en cola:</div><ul style="margin: 4px 0 0 18px;">${pa.ultimosEnvios.map(e => `<li>${escaparHTML(fecha(e.fecha))} → ${escaparHTML((e.para || []).join(', '))}: ${escaparHTML(e.asunto)}</li>`).join('')}</ul>` : ''}`;
}

// =====================================================================
// PORTADA: elegir módulo (ACR o Técnicos)
// =====================================================================
function aplicarAccesoTecnicos() {
    const bloqueado = window.esAdminTec === false || tec.sinAcceso;
    const op = document.querySelector('.portada-op.tec');
    if (op) {
        op.classList.toggle('bloqueado', !!bloqueado);
        const dato = document.getElementById('portada-dato-tec');
        if (bloqueado && dato) dato.textContent = '🔒 Solo administradores de la matriz';
    }
    if (bloqueado && document.body.classList.contains('modo-tec')) abrirModulo('acr');
}
function abrirModulo(modulo) {
    if (modulo === 'tecnicos' && (window.esAdminTec === false || tec.sinAcceso)) {
        alert('🔒 El módulo Técnicos es solo para los administradores de la matriz de polivalencia. Si necesitas acceso, pídelo a Sara Moreno.');
        return;
    }
    document.body.classList.remove('modo-portada', 'modo-acr', 'modo-tec');
    document.body.classList.add(modulo === 'tecnicos' ? 'modo-tec' : 'modo-acr');
    document.getElementById('btn-portada').style.display = '';
    if (modulo === 'tecnicos') { switchTab('tecnicos'); vistaTecnicos(vistaTecActual || 'perfiles'); }
    else if (currentTab === 'tecnicos' || !currentTab) switchTab('dashboard');
    else switchTab(currentTab);
    history.replaceState(null, '', '#' + (modulo === 'tecnicos' ? 'tecnicos' : 'acr'));
    window.scrollTo(0, 0);
}
function irPortada() {
    if (vistaTecActual === 'acciones' && accionesCambiadas && !confirm('Tienes cambios sin guardar en las acciones a calificar. ¿Salir sin guardar?')) return;
    accionesCambiadas = false;
    document.body.classList.remove('modo-acr', 'modo-tec');
    document.body.classList.add('modo-portada');
    document.getElementById('btn-portada').style.display = 'none';
    history.replaceState(null, '', location.pathname);
    renderPortada();
}
function renderPortada() {
    const a = document.getElementById('portada-dato-acr');
    if (a && typeof acrsData !== 'undefined') {
        const abiertas = acrsData.reduce((n, x) => n + (x.tareas || []).filter(t => t.estado !== 'Realizado').length, 0);
        a.textContent = `${acrsData.length} ACR · ${abiertas} acciones abiertas`;
    }
    const t = document.getElementById('portada-dato-tec');
    if (t && tec.cargado && !tec.sinAcceso && window.esAdminTec !== false) {
        const activos = tec.tecnicos.filter(x => x.activo !== false);
        t.textContent = `${activos.length} técnicos · ${rolesCatalogo().length} especialidades`;
    }
}
document.addEventListener('DOMContentLoaded', () => {
    const h = location.hash.replace('#', '');
    if (h === 'acr' || h === 'tecnicos') abrirModulo(h);
    else { document.body.classList.add('modo-portada'); renderPortada(); }
    setTimeout(renderPortada, 1500);
});

// =====================================================================
// Especialidades, avance y KPIs
// =====================================================================
function rolesCatalogo() {
    const r = [];
    (tec.habilidades || []).forEach(h => { if (!r.includes(h.rol)) r.push(h.rol); });
    return r;
}
function areasTecnicos() {
    const a = new Set(['TM', 'Conversión']);
    tec.tecnicos.forEach(t => t.area && a.add(t.area));
    return [...a];
}
function filtroArea(id) { const el = document.getElementById(id); return el ? el.value : 'TODAS'; }
function llenarSelectoresRoles() {
    document.querySelectorAll('select.sel-areas').forEach(sel => {
        const antes = sel.value;
        sel.innerHTML = '<option value="TODAS">Área: Todas</option>' + areasTecnicos().map(a => `<option value="${attr(a)}">${escaparHTML(a)}</option>`).join('') + '<option value="">Sin área</option>';
        if ([...sel.options].some(o => o.value === antes)) sel.value = antes;
    });
    const roles = rolesCatalogo();
    document.querySelectorAll('select.sel-roles').forEach(sel => {
        const antes = sel.value;
        const todos = sel.dataset.todos === '1';
        sel.innerHTML = (todos ? '<option value="TODOS">Especialidad: Todas</option>' : '') +
            roles.map(r => `<option value="${attr(r)}">${ICONO_ROL[r] || '👤'} ${escaparHTML(r)}</option>`).join('');
        if ([...sel.options].some(o => o.value === antes)) sel.value = antes;
    });
}
function avance(t) {
    const habs = tec.habilidades.filter(h => h.rol === t.rol);
    const hechas = habs.filter(h => Number((t.niveles || {})[h.id]) > 0).length;
    return { hechas, total: habs.length };
}
function barraAvance(t) {
    const a = avance(t);
    const p = a.total ? Math.round(a.hechas / a.total * 100) : 0;
    return `<div class="tt-avance" title="Acciones calificadas este semestre"><div><span style="width:${p}%"></span></div><small>${a.hechas}/${a.total} calificadas</small></div>`;
}
function puntajeLocal(niveles, rol) {
    let suma = 0, pesos = 0;
    tec.habilidades.filter(h => h.rol === rol).forEach(h => {
        const n = Number(niveles[h.id]);
        if (n) { suma += n / 4 * h.peso; pesos += h.peso; }
    });
    return pesos ? suma / pesos : null;
}
function renderKpisTecnicos() {
    const cont = document.getElementById('tec-kpis');
    if (!cont || !tec.cargado) return;
    document.getElementById('tec-periodo').textContent = tec.periodoActual || '';
    const activos = tec.tecnicos.filter(t => t.activo !== false);
    const completos = activos.filter(t => { const a = avance(t); return a.total && a.hechas === a.total; }).length;
    const conPuntaje = activos.filter(t => t.puntaje != null);
    const prom = conPuntaje.length ? conPuntaje.reduce((s, t) => s + t.puntaje, 0) / conPuntaje.length : null;
    cont.innerHTML = `
        <div><span>${activos.length}</span>Técnicos</div>
        <div><span>${completos}</span>Calificados al 100%</div>
        <div><span>${pct(prom)}</span>Puntaje promedio</div>`;
    renderPortada();
}

// =====================================================================
// CALIFICAR: un técnico a la vez, con botones grandes 1-4
// =====================================================================
let calificarId = '';
function irACalificar(id) {
    const t = tec.tecnicos.find(x => x.id === id);
    if (!t) return;
    calificarId = id;
    document.getElementById('calificar-rol').value = t.rol;
    if (document.body.classList.contains('modo-tec')) vistaTecnicos('calificar');
    else { abrirModulo('tecnicos'); vistaTecnicos('calificar'); }
}
function listaCalificar() {
    const rol = document.getElementById('calificar-rol').value;
    return tec.tecnicos.filter(t => t.activo !== false && t.rol === rol).sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));
}
function moverCalificar(n) {
    const lista = listaCalificar();
    if (!lista.length) return;
    const i = Math.max(0, lista.findIndex(t => t.id === calificarId));
    calificarId = lista[(i + n + lista.length) % lista.length].id;
    renderCalificar();
    document.getElementById('tec-vista-calificar').scrollIntoView({ behavior: 'smooth', block: 'start' });
}
function renderCalificar(cambioRol) {
    const cont = document.getElementById('calificar-contenido');
    if (!cont || !tec.cargado) return;
    const sel = document.getElementById('calificar-tecnico');
    const lista = listaCalificar();
    if (!cambioRol && sel.value && lista.some(t => t.id === sel.value) && sel.value !== calificarId && document.activeElement === sel) calificarId = sel.value;
    if (!lista.some(t => t.id === calificarId)) calificarId = lista[0] ? lista[0].id : '';
    sel.innerHTML = lista.map(t => { const a = avance(t); return `<option value="${attr(t.id)}">${escaparHTML(t.nombre)} — ${a.hechas}/${a.total}${a.hechas === a.total && a.total ? ' ✅' : ''}</option>`; }).join('') || '<option value="">Sin técnicos</option>';
    sel.value = calificarId;
    const t = lista.find(x => x.id === calificarId);
    if (!t) {
        cont.innerHTML = `<div class="vacio">No hay técnicos de ${escaparHTML(document.getElementById('calificar-rol').value)} todavía. <a href="#" onclick="abrirPerfil(); return false;">➕ Crear técnico</a></div>`;
        return;
    }
    const habs = tec.habilidades.filter(h => h.rol === t.rol);
    const cats = [...new Set(habs.map(h => h.categoria))];
    const a = avance(t);
    const p = t.puntaje;
    const grados = Math.round((p || 0) * 360);
    cont.innerHTML = `
        <div class="calif-cabecera">
            <div class="calif-anillo" style="background: conic-gradient(var(--accent-cyan) ${grados}deg, rgba(148,163,184,.18) 0);"><div><strong>${pct(p)}</strong><small>puntaje</small></div></div>
            <div class="calif-datos">
                <h3>${ICONO_ROL[t.rol] || '👤'} ${escaparHTML(t.nombre)}</h3>
                <p>${escaparHTML(t.rol)}${t.cargo ? ' · ' + escaparHTML(t.cargo) : ''}${t.linea ? ' · ' + escaparHTML(t.linea) : ''} · semestre ${escaparHTML(tec.periodoActual)}</p>
                <div class="calif-progreso"><div><span style="width:${a.total ? a.hechas / a.total * 100 : 0}%"></span></div><small>${a.hechas} de ${a.total} acciones calificadas</small></div>
                ${r360(t) && r360(t).puntajes.final != null ? `<p style="margin:6px 0 0; font-size: 13px;">${chip360(t)} <span style="color: var(--text-muted);">final ponderado con auto, compañero y supervisor</span></p>` : ''}
                ${t.variacion != null ? `<p class="${t.variacion >= 0 ? 'sube' : 'baja'}" style="margin:6px 0 0; font-size: 13px;">${t.variacion >= 0 ? '▲' : '▼'} ${Math.abs(Math.round(t.variacion * 100))} puntos vs ${escaparHTML(t.periodoAnterior)}</p>` : ''}
            </div>
            <div class="grupo-botones"><button class="btn btn-secondary btn-sm" onclick="abrirPerfil('${attr(t.id)}')">✏️ Editar perfil</button></div>
        </div>
        <div class="calif-leyenda">${[1, 2, 3, 4].map(n => `<span class="nivel n${n}">${n} ${tec.niveles[n]}</span>`).join('')}<small>Toca otra vez el mismo número para borrarlo. Se guarda solo.</small></div>
        ${cats.map(c => `
            <div class="calif-cat">
                <div class="calif-cat-titulo">${escaparHTML(c)}</div>
                ${habs.filter(h => h.categoria === c).map(h => {
                    const n = Number((t.niveles || {})[h.id]) || 0;
                    return `<div class="calif-fila ${n ? 'hecha' : ''}">
                        <div class="calif-texto"><strong>${escaparHTML(h.nombre)}</strong>${h.descripcion ? `<small>${escaparHTML(h.descripcion)}</small>` : ''}</div>
                        <span class="calif-peso" title="Peso en el puntaje">${Math.round(h.peso * 1000) / 10}%</span>
                        <div class="calif-botones">${[1, 2, 3, 4].map(v => `<button class="nivel n${v} ${n === v ? 'sel' : ''}" title="${tec.niveles[v]}" onclick="calificarAccion('${attr(t.id)}', '${h.id}', ${v})">${v}</button>`).join('')}</div>
                    </div>`;
                }).join('')}
            </div>`).join('')}
        <div class="calif-pie">
            <button class="btn btn-secondary" onclick="moverCalificar(-1)">◀ Anterior</button>
            <button class="btn btn-primary" onclick="moverCalificar(1)">Siguiente técnico ▶</button>
        </div>`;
}
async function calificarAccion(id, hab, valor) {
    const t = tec.tecnicos.find(x => x.id === id);
    if (!t) return;
    const previo = Number((t.niveles || {})[hab]) || 0;
    const nuevo = previo === valor ? 0 : valor;
    t.niveles = { ...(t.niveles || {}) };
    if (nuevo) t.niveles[hab] = nuevo; else delete t.niveles[hab];
    t.puntaje = puntajeLocal(t.niveles, t.rol);
    renderCalificar();
    renderKpisTecnicos();
    try {
        const r = await postJSON('/api/tecnicos/evaluar', { id, niveles: { [hab]: nuevo }, usuario: usuarioActual.nombre });
        Object.assign(t, { puntaje: r.puntaje, variacion: r.variacion, periodo: r.periodo, periodoAnterior: r.periodoAnterior });
        if (vistaTecActual === 'calificar') renderCalificar();
    } catch (err) {
        if (previo) t.niveles[hab] = previo; else delete t.niveles[hab];
        t.puntaje = puntajeLocal(t.niveles, t.rol);
        renderCalificar();
        alert('❌ No se guardó la calificación: ' + err.message);
    }
}

// =====================================================================
// RANKING por especialidad
// =====================================================================
function renderRanking() {
    const cont = document.getElementById('ranking-contenido');
    if (!cont || !tec.cargado) return;
    const filtro = document.getElementById('ranking-rol').value;
    document.getElementById('ranking-fuente').style.display = hay360() ? '' : 'none';
    const fuente = fuenteActiva();
    const roles = rolesCatalogo().filter(r => filtro === 'TODOS' || r === filtro);
    const bloques = roles.map(rol => {
        const lista = tec.tecnicos.filter(t => t.activo !== false && t.rol === rol && puntajeVista(t) != null).map(t => ({ ...t, puntaje: puntajeVista(t), variacion: fuente === 'final' ? null : t.variacion })).sort((a, b) => b.puntaje - a.puntaje);
        if (!lista.length) return filtro === 'TODOS' ? '' : `<div class="vacio">Aún no hay técnicos de ${escaparHTML(rol)} calificados.</div>`;
        const podio = [lista[1], lista[0], lista[2]].map((t, i) => t ? `
            <div class="podio-lugar p${[2, 1, 3][i]}">
                <div class="podio-medalla">${['🥈', '🥇', '🥉'][i]}</div>
                <strong>${escaparHTML(t.nombre)}</strong>
                <span>${pct(t.puntaje)}</span>
                <div class="podio-base">${[2, 1, 3][i]}</div>
            </div>` : '<div class="podio-lugar vacio-podio"></div>').join('');
        const barras = lista.map((t, i) => `
            <div class="rank-fila" onclick="irACalificar('${attr(t.id)}')" title="Ver y calificar">
                <span class="rank-pos">${i + 1}</span>
                <span class="rank-nombre">${escaparHTML(t.nombre)}<small>${avance(t).hechas}/${avance(t).total} calificadas</small></span>
                <div class="rank-barra"><span style="width:${Math.round(t.puntaje * 100)}%; background:${t.puntaje >= .875 ? 'var(--status-green)' : t.puntaje >= .75 ? '#84cc16' : t.puntaje >= .5 ? 'var(--status-yellow)' : 'var(--status-red)'};"></span></div>
                <span class="rank-pct">${pct(t.puntaje)}${t.variacion != null ? `<small class="${t.variacion >= 0 ? 'sube' : 'baja'}">${t.variacion >= 0 ? '▲' : '▼'}${Math.abs(Math.round(t.variacion * 100))}</small>` : ''}</span>
            </div>`).join('');
        return `<div class="section-card">
            <div class="section-title"><span>${ICONO_ROL[rol] || '👤'} ${escaparHTML(rol)}</span><span style="font-size: 12px; color: var(--text-muted);">${lista.length} calificados</span></div>
            <div class="podio">${podio}</div>
            <div class="rank-lista">${barras}</div>
        </div>`;
    }).join('');
    cont.innerHTML = bloques || '<div class="vacio">Todavía no hay técnicos calificados. Empieza en ⭐ Calificar.</div>';
}

// =====================================================================
// ACCIONES A CALIFICAR (catálogo editable por especialidad)
// =====================================================================
let accionesEdit = [];
let accionesCambiadas = false;
const GENERALES = ['bloqueo y aislamiento', 'apr y estandares', 'orden y 5s', 'reduccion de averias', 'aumento de mtbf', 'calidad del preventivo',
    'conocimientos administrativos', 'planeacion - mrp', 'manejo de sap', 'tipos de mantenimiento y/o tpm', 'habilidades de control de procesos',
    'trabajo en equipo', 'toma de decisiones', 'comunicacion', 'lototo'];

function renderAcciones(recargar) {
    if (recargar || !accionesEdit.length) accionesEdit = JSON.parse(JSON.stringify(tec.habilidades || []));
    const tabla = document.getElementById('tabla-acciones');
    if (!tabla) return;
    const sel = document.getElementById('acciones-rol');
    const rolesEdit = [];
    accionesEdit.forEach(h => { if (!rolesEdit.includes(h.rol)) rolesEdit.push(h.rol); });
    const antes = sel.value;
    sel.innerHTML = rolesEdit.map(r => `<option value="${attr(r)}">${ICONO_ROL[r] || '👤'} ${escaparHTML(r)}</option>`).join('');
    if (rolesEdit.includes(antes)) sel.value = antes;
    const rol = sel.value;
    const cats = [...new Set(accionesEdit.map(h => h.categoria).concat(['Competencias Técnicas', 'Confiabilidad del Activo', 'Seguridad', 'Habilidades Blandas']))];
    const filas = accionesEdit.map((h, i) => ({ h, i })).filter(x => x.h.rol === rol);
    const calificados = id => tec.tecnicos.filter(t => (t.niveles || {})[id]).length;
    tabla.innerHTML = `
        <thead><tr><th>#</th><th>Categoría</th><th>Acción a calificar</th><th>Descripción</th><th>Peso %</th><th>Tipo</th><th></th></tr></thead>
        <tbody>${filas.map(({ h, i }, k) => `
            <tr>
                <td>${k + 1}</td>
                <td><input class="form-control" list="lista-categorias" value="${attr(h.categoria)}" oninput="editarAccion(${i}, 'categoria', this.value)"></td>
                <td><input class="form-control" value="${attr(h.nombre)}" placeholder="Nombre de la acción" oninput="editarAccion(${i}, 'nombre', this.value)"></td>
                <td><input class="form-control" value="${attr(h.descripcion)}" placeholder="Qué se evalúa" oninput="editarAccion(${i}, 'descripcion', this.value)"></td>
                <td><input class="form-control peso" type="number" min="0" max="100" step="0.5" value="${Math.round(h.peso * 1000) / 10}" oninput="editarAccion(${i}, 'peso', this.value / 100)"></td>
                <td><select class="form-control" onchange="editarAccion(${i}, 'tipo', this.value)"><option ${h.tipo !== 'Resultado' ? 'selected' : ''}>Capacidad</option><option ${h.tipo === 'Resultado' ? 'selected' : ''}>Resultado</option></select></td>
                <td><button class="btn btn-danger btn-sm" title="Quitar acción${calificados(h.id) ? ' (' + calificados(h.id) + ' técnicos ya calificados)' : ''}" onclick="quitarAccion(${i})">🗑️</button></td>
            </tr>`).join('')}</tbody>`;
    let dl = document.getElementById('lista-categorias');
    if (!dl) { dl = document.createElement('datalist'); dl.id = 'lista-categorias'; document.body.appendChild(dl); }
    dl.innerHTML = cats.map(c => `<option value="${attr(c)}">`).join('');
    actualizarSumaPesos();
}
function actualizarSumaPesos() {
    const rol = document.getElementById('acciones-rol').value;
    const suma = accionesEdit.filter(h => h.rol === rol).reduce((s, h) => s + (Number(h.peso) || 0), 0);
    const ok = Math.abs(suma - 1) < 0.005;
    document.getElementById('acciones-suma').innerHTML = `
        <span class="${ok ? 'suma-ok' : 'suma-mal'}">${ok ? '✅' : '⚠️'} Suma de pesos de ${escaparHTML(rol)}: <strong>${Math.round(suma * 1000) / 10}%</strong>${ok ? '' : ' — debe dar 100%. Usa "⚖️ Ajustar pesos a 100%".'}</span>
        <span>${accionesEdit.filter(h => h.rol === rol).length} acciones${accionesCambiadas ? ' · <strong style="color: var(--status-yellow);">cambios sin guardar</strong>' : ''}</span>`;
}
function editarAccion(i, campo, valor) {
    accionesEdit[i][campo] = campo === 'peso' ? Math.max(0, Number(valor) || 0) : valor;
    accionesCambiadas = true;
    actualizarSumaPesos();
}
function agregarAccion() {
    const rol = document.getElementById('acciones-rol').value;
    const ultima = [...accionesEdit].reverse().find(h => h.rol === rol);
    const pos = accionesEdit.lastIndexOf(ultima) + 1 || accionesEdit.length;
    const nueva = { id: '', rol, categoria: ultima ? ultima.categoria : 'Competencias Técnicas', nombre: '', descripcion: '', peso: 0, tipo: 'Capacidad' };
    accionesEdit.splice(pos, 0, nueva);
    accionesCambiadas = true;
    renderAcciones();
    const k = accionesEdit.filter(h => h.rol === rol).indexOf(nueva);
    const fila = document.querySelectorAll('#tabla-acciones tbody tr')[k];
    if (fila) { fila.scrollIntoView({ block: 'center' }); fila.querySelectorAll('input')[1].focus(); }
}
function quitarAccion(i) {
    const h = accionesEdit[i];
    const n = tec.tecnicos.filter(t => (t.niveles || {})[h.id]).length;
    if (!confirm(`¿Quitar "${h.nombre || 'acción sin nombre'}"?${n ? `\n\n${n} técnicos ya tienen calificación en esta acción; dejará de contar en su puntaje.` : ''}`)) return;
    accionesEdit.splice(i, 1);
    accionesCambiadas = true;
    renderAcciones();
}
function ajustarPesos() {
    const rol = document.getElementById('acciones-rol').value;
    const del = accionesEdit.filter(h => h.rol === rol);
    if (!del.length) return;
    // Las acciones nuevas (peso 0) reciben el peso promedio de las demás antes de repartir
    const conPeso = del.filter(h => Number(h.peso) > 0);
    const promedio = conPeso.length ? conPeso.reduce((s, h) => s + Number(h.peso), 0) / conPeso.length : 1;
    del.forEach(h => { if (!(Number(h.peso) > 0)) h.peso = promedio; });
    let suma = del.reduce((s, h) => s + (Number(h.peso) || 0), 0);
    if (!suma) del.forEach(h => { h.peso = 1 / del.length; });
    else del.forEach(h => { h.peso = (Number(h.peso) || 0) / suma; });
    // Redondeo a décimas de porcentaje y el sobrante a la acción de mayor peso
    del.forEach(h => { h.peso = Math.round(h.peso * 1000) / 1000; });
    const resto = Math.round((1 - del.reduce((s, h) => s + h.peso, 0)) * 1000) / 1000;
    if (resto) { const mayor = del.reduce((a, b) => (b.peso > a.peso ? b : a)); mayor.peso = Math.round((mayor.peso + resto) * 1000) / 1000; }
    accionesCambiadas = true;
    renderAcciones();
}
function nuevaEspecialidad() {
    const nombre = (prompt('Nombre de la nueva especialidad (ej. Soldador, Tornero, Electromecánico):') || '').trim();
    if (!nombre) return;
    if (accionesEdit.some(h => normalizarTexto(h.rol) === normalizarTexto(nombre))) return alert('Esa especialidad ya existe.');
    const base = rolesCatalogo()[0];
    const copiar = base && confirm(`¿Copiar las competencias generales (seguridad, confiabilidad, SAP, TPM, habilidades blandas) de ${base}?\n\nDespués agregas las acciones técnicas propias de ${nombre}.`);
    if (copiar) {
        accionesEdit.filter(h => h.rol === base && GENERALES.includes(normalizarTexto(h.nombre))).forEach(h => accionesEdit.push({ ...h, id: '', rol: nombre }));
    }
    accionesEdit.push({ id: '', rol: nombre, categoria: 'Competencias Técnicas', nombre: '', descripcion: '', peso: 0, tipo: 'Capacidad' });
    accionesCambiadas = true;
    renderAcciones();
    document.getElementById('acciones-rol').value = nombre;
    renderAcciones();
}
async function guardarAcciones() {
    const vacias = accionesEdit.filter(h => !String(h.nombre || '').trim());
    if (vacias.length && !confirm(`${vacias.length} acciones no tienen nombre y no se guardarán. ¿Continuar?`)) return;
    const malas = [];
    [...new Set(accionesEdit.map(h => h.rol))].forEach(rol => {
        const suma = accionesEdit.filter(h => h.rol === rol && String(h.nombre || '').trim()).reduce((s, h) => s + (Number(h.peso) || 0), 0);
        if (Math.abs(suma - 1) >= 0.005) malas.push(`${rol}: ${Math.round(suma * 1000) / 10}%`);
    });
    if (malas.length && !confirm(`Los pesos no suman 100% en:\n${malas.join('\n')}\n\nEl puntaje igual se calcula sobre lo que sí suma, pero lo ideal es ajustarlos. ¿Guardar así?`)) return;
    try {
        const r = await postJSON('/api/habilidades', { habilidades: accionesEdit.filter(h => String(h.nombre || '').trim()), usuario: usuarioActual.nombre });
        accionesCambiadas = false;
        await cargarTecnicos();
        renderAcciones(true);
        mostrarNotificacionToast('Polivalencia', `Acciones guardadas (${r.habilidades.length}).`);
    } catch (err) { alert('❌ ' + err.message); }
}
window.addEventListener('beforeunload', e => { if (accionesCambiadas) { e.preventDefault(); e.returnValue = ''; } });

// =====================================================================
// EVALUACIÓN 360°: autoevaluación, compañero, supervisor e ingeniería
// =====================================================================
const e360 = { datos: null, campanaId: '' };
const TIPOS_360 = ['auto', 'par', 'supervisor', 'ingenieria'];

async function cargar360(id) {
    if (id !== undefined) e360.campanaId = id;
    try {
        e360.datos = await (await fetch('/api/360' + (e360.campanaId ? '?campana=' + encodeURIComponent(e360.campanaId) : ''))).json();
        if (e360.datos.campana) e360.campanaId = e360.datos.campana.id;
    } catch (e) { document.getElementById('e360-contenido').innerHTML = '<div class="vacio">No se pudo cargar la evaluación.</div>'; return; }
    render360();
}

async function nuevaCampana360() {
    const sugerido = `Evaluación ${tec.periodoActual || ''}`.trim();
    const nombre = (prompt('Nombre de la evaluación:', sugerido) || '').trim();
    if (!nombre) return;
    try {
        const r = await postJSON('/api/360/campana', { nombre });
        await cargar360(r.campana.id);
    } catch (err) { alert('❌ ' + err.message); }
}

function enlace360(token) { return `${(e360.datos && e360.datos.urlBase) || location.origin}/evaluar/${token}`; }
function solicitud360(r, tipo) { return (r.solicitudes || []).filter(s => s.tipo === tipo); }

function celda360(t, r, tipo) {
    if (tipo === 'ingenieria') {
        const a = avance(t);
        return `<div class="e360-celda ${a.hechas === a.total && a.total ? 'ok' : a.hechas ? 'parcial' : ''}">
            <span class="e360-estado">${a.hechas === a.total && a.total ? '✅ Completa' : a.hechas ? `⏳ ${a.hechas}/${a.total}` : '— Sin calificar'}</span>
            <span class="e360-puntaje">${pct(r.puntajes.ingenieria)}</span>
            <button class="link" onclick="irACalificar('${attr(t.id)}')">⭐ Calificar</button></div>`;
    }
    const sols = solicitud360(r, tipo);
    if (!sols.length) {
        return `<div class="e360-celda vacia"><span class="e360-estado">— Sin asignar</span>${botonAsignar360(t, tipo)}</div>`;
    }
    return sols.map(s => {
        const hecha = s.estado === 'respondida';
        return `<div class="e360-celda ${hecha ? 'ok' : ''}">
            <span class="e360-estado">${hecha ? '✅ Respondida' : s.enviada ? '📨 Enviada' : '⏳ Pendiente'}</span>
            ${tipo !== 'auto' ? `<span class="e360-evaluador">${escaparHTML(s.evaluador.nombre)}</span>` : ''}
            ${hecha ? `<span class="e360-puntaje">${pct(r.puntajes[tipo])}</span>` : ''}
            <div class="e360-acciones">
                <button title="Copiar enlace" onclick="copiarEnlace360('${attr(s.token)}')">🔗</button>
                <a title="Abrir el cuestionario" href="${attr(enlace360(s.token))}" target="_blank" rel="noopener">↗</a>
                ${tipo !== 'auto' ? botonAsignar360(t, tipo, true) : ''}
                <button title="Quitar asignación" onclick="quitar360('${attr(s.token)}', ${hecha})">✕</button>
            </div></div>`;
    }).join('');
}

function botonAsignar360(t, tipo, corto) {
    if (tipo === 'auto') return `<button class="link" onclick="asignar360('auto', '${attr(t.id)}')">➕ Crear</button>`;
    if (tipo === 'par') {
        const opciones = tec.tecnicos.filter(x => x.activo !== false && x.rol === t.rol && x.id !== t.id)
            .map(x => `<option value="${attr(x.id)}">${escaparHTML(x.nombre)}</option>`).join('');
        return `<select class="e360-select" title="Elegir compañero" onchange="if (this.value) asignarManual360('${attr(t.id)}', 'par', { evaluadorTecnicoId: this.value })"><option value="">${corto ? '✏️' : '➕ Elegir…'}</option>${opciones}</select>`;
    }
    return `<button class="${corto ? '' : 'link'}" title="Asignar supervisor" onclick="pedirSupervisor360('${attr(t.id)}')">${corto ? '✏️' : '➕ Asignar'}</button>`;
}

function render360() {
    const cont = document.getElementById('e360-contenido');
    if (!cont || !e360.datos || !tec.cargado) return;
    const d = e360.datos;
    const sel = document.getElementById('e360-campana');
    sel.innerHTML = d.campanas.length ? d.campanas.slice().reverse().map(c => `<option value="${attr(c.id)}">${escaparHTML(c.nombre)}${c.cerrada ? ' (cerrada)' : ''}</option>`).join('') : '<option value="">Sin evaluaciones</option>';
    if (d.campana) sel.value = d.campana.id;
    if (!d.campana) {
        cont.innerHTML = `<div class="section-card e360-intro">
            <h3>🔄 Evaluación 360°</h3>
            <p>Cada técnico es calificado en las mismas acciones de su especialidad por <strong>él mismo</strong>, <strong>un compañero</strong>, <strong>su supervisor de línea</strong> e <strong>ingeniería</strong>. El resultado final es el promedio ponderado de las cuatro miradas.</p>
            <p>Los evaluadores no necesitan cuenta: reciben un enlace personal por correo y responden desde el celular o el computador.</p>
            <button class="btn btn-primary" onclick="nuevaCampana360()">➕ Crear la primera evaluación</button></div>`;
        return;
    }
    const c = d.campana;
    const filtro = document.getElementById('e360-rol').value;
    const q = normalizarTexto(document.getElementById('e360-buscar').value);
    const porId = Object.fromEntries(d.resultados.map(r => [r.tecnicoId, r]));
    const area360 = filtroArea('e360-area');
    const lista = tec.tecnicos.filter(t => t.activo !== false && (filtro === 'TODOS' || t.rol === filtro) && (area360 === 'TODAS' || (t.area || '') === area360) && porId[t.id])
        .filter(t => !q || normalizarTexto([t.nombre, ...(porId[t.id].solicitudes || []).map(s => s.evaluador.nombre)].join(' ')).includes(q))
        .sort((a, b) => a.rol.localeCompare(b.rol) || a.nombre.localeCompare(b.nombre, 'es'));
    const cuenta = tipo => {
        const s = lista.flatMap(t => solicitud360(porId[t.id], tipo));
        return { total: s.length, hechas: s.filter(x => x.estado === 'respondida').length, sinAsignar: lista.filter(t => !solicitud360(porId[t.id], tipo).length).length };
    };
    const ing = { hechas: lista.filter(t => { const a = avance(t); return a.total && a.hechas === a.total; }).length };
    const suma = Object.values(c.pesos).reduce((a, b) => a + b, 0);
    const tarjeta = (tipo, icono, extra) => {
        const k = tipo === 'ingenieria' ? { total: lista.length, hechas: ing.hechas, sinAsignar: 0 } : cuenta(tipo);
        const p = k.total ? Math.round(k.hechas / k.total * 100) : 0;
        return `<div class="e360-fuente">
            <div class="e360-fuente-cab"><span>${icono} ${escaparHTML(d.tipos[tipo].corto)}</span>
                <label title="Peso en el resultado final"><input type="number" min="0" max="100" step="5" value="${Math.round(c.pesos[tipo] * 100)}" data-tipo="${tipo}" class="e360-peso" oninput="marcarPesos360()">%</label></div>
            <div class="tt-avance"><div><span style="width:${p}%"></span></div><small>${k.hechas}/${k.total}${tipo === 'ingenieria' ? ' completas' : ' respondidas'}</small></div>
            ${k.sinAsignar ? `<small class="texto-aviso">${k.sinAsignar} sin asignar</small>` : ''}
            ${extra || ''}
        </div>`;
    };
    cont.innerHTML = `
        <div class="e360-fuentes">
            ${tarjeta('auto', '🙋', `<button class="btn btn-secondary btn-sm" onclick="asignar360('auto')">👤 Crear autoevaluaciones</button>`)}
            ${tarjeta('par', '🤝', `<button class="btn btn-secondary btn-sm" onclick="asignar360('companeros')">🎲 Asignar compañeros al azar</button>`)}
            ${tarjeta('supervisor', '👔', `<button class="btn btn-secondary btn-sm" onclick="asignarSupervisoresPerfil360()">👔 Supervisores del perfil</button><button class="btn btn-secondary btn-sm" onclick="pedirSupervisor360()">✏️ Asignar uno a varios</button>`)}
            ${tarjeta('ingenieria', '🛠️', `<button class="btn btn-secondary btn-sm" onclick="vistaTecnicos('calificar')">⭐ Ir a calificar</button>`)}
        </div>
        <div class="e360-barra-acciones">
            <span id="e360-suma" class="${Math.abs(suma - 1) < 0.005 ? 'suma-ok' : 'suma-mal'}">Pesos: ${Math.round(suma * 100)}%${Math.abs(suma - 1) < 0.005 ? ' ✅' : ' (se reparten sobre lo que sume)'}</span>
            <div class="grupo-botones">
                <button class="btn btn-secondary btn-sm" id="e360-guardar-pesos" style="display: none;" onclick="guardarPesos360()">💾 Guardar pesos</button>
                <button class="btn btn-primary btn-sm" onclick="enviar360()">📨 Enviar correos pendientes</button>
            </div>
        </div>
        <div class="section-card" style="padding: 0;">
            <div class="tabla-desplazable"><table class="grid-tabla tabla-360">
                <thead><tr><th class="col-fija">Técnico</th><th>🙋 Autoevaluación</th><th>🤝 Compañero</th><th>👔 Supervisor</th><th>🛠️ Ingeniería</th><th>Final ponderado</th></tr></thead>
                <tbody>${lista.map(t => {
                    const r = porId[t.id];
                    return `<tr>
                        <td class="col-fija"><button class="link" onclick="detalle360('${attr(t.id)}')">${ICONO_ROL[t.rol] || '👤'} ${escaparHTML(t.nombre)}</button><small class="e360-rol">${escaparHTML(t.rol)}${t.correo ? '' : ' · sin correo'}</small></td>
                        ${TIPOS_360.map(tipo => `<td>${celda360(t, r, tipo)}</td>`).join('')}
                        <td><div class="e360-final"><strong>${pct(r.puntajes.final)}</strong><button class="btn btn-secondary btn-sm" onclick="detalle360('${attr(t.id)}')">🔍 Detalle</button></div></td>
                    </tr>`;
                }).join('') || '<tr><td colspan="6" style="padding: 20px; color: var(--text-muted);">No hay técnicos con esos filtros.</td></tr>'}</tbody>
            </table></div>
        </div>
        <p style="font-size: 12px; color: var(--text-muted);">🔗 copia el enlace · ↗ abre el cuestionario · ✏️ cambia el evaluador · ✕ quita la asignación. "Enviar correos" agrupa en un solo correo todas las evaluaciones de cada persona que tenga correo registrado. Las autoevaluaciones y las de compañero llegan al correo registrado en el perfil de cada técnico; las de supervisor, al correo del supervisor.</p>`;
}

function marcarPesos360() {
    const ins = [...document.querySelectorAll('.e360-peso')];
    const suma = ins.reduce((s, i) => s + (Number(i.value) || 0), 0);
    const el = document.getElementById('e360-suma');
    el.textContent = `Pesos: ${suma}%${suma === 100 ? ' ✅' : ' — deben sumar 100%'}`;
    el.className = suma === 100 ? 'suma-ok' : 'suma-mal';
    document.getElementById('e360-guardar-pesos').style.display = '';
}
async function guardarPesos360() {
    const pesos = {};
    document.querySelectorAll('.e360-peso').forEach(i => { pesos[i.dataset.tipo] = (Number(i.value) || 0) / 100; });
    const suma = Object.values(pesos).reduce((a, b) => a + b, 0);
    if (Math.abs(suma - 1) > 0.001 && !confirm(`Los pesos suman ${Math.round(suma * 100)}%. ¿Guardar así? (el final se calcula repartiendo sobre lo que sume)`)) return;
    try { await postJSON('/api/360/campana', { id: e360.campanaId, pesos }); await cargar360(); mostrarNotificacionToast('Evaluación 360°', 'Pesos guardados.'); }
    catch (err) { alert('❌ ' + err.message); }
}

async function asignar360(modo, tecnicoId) {
    const rol = document.getElementById('e360-rol').value;
    const ambito = rol === 'TODOS' ? 'todos los técnicos' : `los técnicos de ${rol}`;
    if (!tecnicoId && modo === 'companeros' && !confirm(`Asignar al azar un compañero de su misma especialidad a ${ambito} que aún no tengan uno.\n\n¿Continuar?`)) return;
    try {
        const r = tecnicoId
            ? await postJSON('/api/360/asignar', { campanaId: e360.campanaId, modo: 'manual', tipo: 'auto', tecnicoId, evaluadorTecnicoId: tecnicoId })
            : await postJSON('/api/360/asignar', { campanaId: e360.campanaId, modo, rol, area: filtroArea('e360-area') });
        await cargar360();
        mostrarNotificacionToast('Evaluación 360°', `${r.asignadas} evaluaciones asignadas.`);
    } catch (err) { alert('❌ ' + err.message); }
}
async function asignarManual360(tecnicoId, tipo, datos) {
    try { await postJSON('/api/360/asignar', { campanaId: e360.campanaId, modo: 'manual', tipo, tecnicoId, ...datos }); await cargar360(); }
    catch (err) { alert('❌ ' + err.message); }
}
async function pedirSupervisor360(tecnicoId) {
    const t = tecnicoId ? tec.tecnicos.find(x => x.id === tecnicoId) : null;
    const rol = document.getElementById('e360-rol').value;
    const nombre = (prompt(t ? `Supervisor que evaluará a ${t.nombre}:` : `Nombre del supervisor de línea.\nSe asignará a ${rol === 'TODOS' ? 'todos los técnicos' : 'los técnicos de ' + rol} que aún no tengan supervisor (filtra por especialidad o búsqueda antes si es para un grupo):`) || '').trim();
    if (!nombre) return;
    const correo = (prompt(`Correo de ${nombre} (le llegarán sus evaluaciones por correo):`) || '').trim();
    if (!correo && !confirm(`${nombre} quedará sin correo y no le llegará el enlace. ¿Continuar igual?`)) return;
    const telefono = '';
    try {
        let r;
        if (t) r = await postJSON('/api/360/asignar', { campanaId: e360.campanaId, modo: 'manual', tipo: 'supervisor', tecnicoId, nombre, correo, telefono });
        else {
            const q = normalizarTexto(document.getElementById('e360-buscar').value);
            const area = filtroArea('e360-area');
            const ids = tec.tecnicos.filter(x => x.activo !== false && (rol === 'TODOS' || x.rol === rol) && (area === 'TODAS' || (x.area || '') === area) && (!q || normalizarTexto(x.nombre).includes(q))).map(x => x.id);
            r = await postJSON('/api/360/asignar', { campanaId: e360.campanaId, modo: 'supervisor', nombre, correo, telefono, tecnicos: ids });
        }
        await cargar360();
        mostrarNotificacionToast('Evaluación 360°', `${r.asignadas} evaluaciones asignadas a ${nombre}.`);
    } catch (err) { alert('❌ ' + err.message); }
}
async function quitar360(token, respondida) {
    if (!confirm(respondida ? 'Esta evaluación YA fue respondida. Si la quitas se pierden sus calificaciones. ¿Quitarla?' : '¿Quitar esta asignación? El enlace dejará de funcionar.')) return;
    try { await postJSON('/api/360/quitar', { token }); await cargar360(); } catch (err) { alert('❌ ' + err.message); }
}
async function copiarEnlace360(token) {
    try { await navigator.clipboard.writeText(enlace360(token)); mostrarNotificacionToast('Enlace copiado', 'Pégalo en un correo, chat o WhatsApp.'); }
    catch (e) { prompt('Copia el enlace:', enlace360(token)); }
}
async function enviar360() {
    if (!confirm('Se enviará un correo a cada evaluador con correo registrado, con los enlaces de sus evaluaciones pendientes que aún no se han enviado.\n\n¿Enviar?')) return;
    try {
        const r = await postJSON('/api/360/enviar', { campanaId: e360.campanaId });
        alert(`📨 ${r.correos} correos en cola (${r.evaluaciones} evaluaciones). Salen desde Outlook en 1 a 5 minutos.${r.sinCorreo ? `\n\n⚠️ ${r.sinCorreo} evaluaciones no se enviaron porque el evaluador no tiene correo. Agrégalo en su perfil (o en ⬇️ Lista en Excel) y vuelve a enviar.` : ''}`);
        await cargar360();
    } catch (err) { alert('❌ ' + err.message); }
}
function exportar360() {
    if (!e360.campanaId) return alert('Primero crea una evaluación.');
    window.location.href = '/api/360/exportar?campana=' + encodeURIComponent(e360.campanaId);
}

function detalle360(id) {
    const t = tec.tecnicos.find(x => x.id === id);
    const r = e360.datos && e360.datos.resultados.find(x => x.tecnicoId === id);
    if (!t || !r) return;
    const habs = tec.habilidades.filter(h => h.rol === t.rol);
    const pesos = e360.datos.campana.pesos;
    const v = (tipo, hid) => { const n = (r.fuentes[tipo] || {})[hid]; return n ? `<td class="nivel-celda n${Math.round(n)}">${Math.round(n * 10) / 10}</td>` : '<td class="nivel-celda n0">—</td>'; };
    const dif = hid => {
        const vals = ['auto', 'par', 'supervisor', 'ingenieria'].map(k => (r.fuentes[k] || {})[hid]).filter(Boolean);
        return vals.length > 1 && Math.max(...vals) - Math.min(...vals) >= 2;
    };
    document.getElementById('analisis-titulo').textContent = `${t.nombre} · Evaluación 360°`;
    document.getElementById('analisis-contenido').innerHTML = `
        <div class="e360-resumen">${['auto', 'par', 'supervisor', 'ingenieria'].map(k => `<div><span>${pct(r.puntajes[k])}</span>${escaparHTML(e360.datos.tipos[k].corto)} · ${Math.round(pesos[k] * 100)}%</div>`).join('')}<div class="final"><span>${pct(r.puntajes.final)}</span>Final ponderado</div></div>
        <div class="tabla-desplazable" style="max-height: 55vh;"><table class="grid-tabla">
            <thead><tr><th class="col-fija">Acción</th><th>Auto</th><th>Compañero</th><th>Supervisor</th><th>Ingeniería</th><th>Final</th></tr></thead>
            <tbody>${habs.map(h => `<tr${dif(h.id) ? ' class="e360-diferencia" title="Las evaluaciones difieren 2 niveles o más: vale la pena conversarlo"' : ''}>
                <td class="col-fija" style="white-space: normal;">${dif(h.id) ? '⚠️ ' : ''}${escaparHTML(h.nombre)} <small style="color: var(--text-muted);">${Math.round(h.peso * 1000) / 10}%</small></td>
                ${v('auto', h.id)}${v('par', h.id)}${v('supervisor', h.id)}${v('ingenieria', h.id)}
                ${r.final[h.id] ? `<td class="nivel-celda n${Math.round(r.final[h.id])}"><strong>${(Math.round(r.final[h.id] * 100) / 100).toFixed(2)}</strong></td>` : '<td class="nivel-celda n0">—</td>'}
            </tr>`).join('')}</tbody>
        </table></div>
        <p style="font-size: 12px; color: var(--text-muted); margin-top: 10px;">⚠️ marca las acciones donde las miradas difieren 2 niveles o más. El final de cada acción es el promedio ponderado de las fuentes que la calificaron.</p>`;
    document.getElementById('modal-analisis').classList.add('active');
}

// =====================================================================
// ACCESO al módulo Técnicos (solo estos correos ven matriz, ranking y 360°)
// =====================================================================
let accesoAdmins = [];
async function cargarAcceso() {
    const cont = document.getElementById('acceso-tecnicos');
    if (!cont) return;
    try { accesoAdmins = (await (await fetch('/api/acceso-tecnicos')).json()).admins || []; } catch (e) { return; }
    renderAcceso();
}
function renderAcceso() {
    const cont = document.getElementById('acceso-tecnicos');
    cont.innerHTML = `
        <div class="acceso-lista">${accesoAdmins.map((c, i) => `<span class="acceso-chip">${escaparHTML(c)}${c === (usuarioActual.correo || '').toLowerCase() ? ' (tú)' : `<button title="Quitar" onclick="accesoAdmins.splice(${i}, 1); guardarAcceso();">✕</button>`}</span>`).join('')}</div>
        <div class="acceso-agregar">
            <input type="email" id="acceso-nuevo" class="form-control" placeholder="correo@kcc.com" onkeydown="if (event.key === 'Enter') agregarAcceso()">
            <button class="btn btn-primary btn-sm" onclick="agregarAcceso()">➕ Dar acceso</button>
        </div>`;
}
function agregarAcceso() {
    const c = document.getElementById('acceso-nuevo').value.trim().toLowerCase();
    if (!c) return;
    if (!accesoAdmins.includes(c)) accesoAdmins.push(c);
    guardarAcceso();
}
async function guardarAcceso() {
    try {
        const r = await postJSON('/api/acceso-tecnicos', { admins: accesoAdmins });
        accesoAdmins = r.admins;
        renderAcceso();
        mostrarNotificacionToast('Acceso', 'Lista de administradores actualizada.');
    } catch (err) { alert('❌ ' + err.message); cargarAcceso(); }
}

// =====================================================================
// PONDERADO 360° en perfil, tarjetas, matriz, ranking y calificar
// (usa la evaluación 360° más reciente)
// =====================================================================
let fuenteVista = 'final';
async function cargarResultados360() {
    try {
        const r = await fetch('/api/360' + (e360.campanaId ? '?campana=' + encodeURIComponent(e360.campanaId) : ''));
        if (!r.ok) return;
        e360.datos = await r.json();
        if (e360.datos.campana) e360.campanaId = e360.datos.campana.id;
    } catch (e) { /* sin 360 */ }
}
function r360(t) {
    const d = e360.datos;
    if (!d || !d.campana) return null;
    return d.resultados.find(x => x.tecnicoId === t.id) || null;
}
function hay360() { return !!(e360.datos && e360.datos.campana); }
function fuenteActiva() { return hay360() ? fuenteVista : 'ingenieria'; }
function nivelesVista(t) {
    if (fuenteActiva() === 'final') { const r = r360(t); return r ? r.final || {} : {}; }
    return t.niveles || {};
}
function puntajeVista(t) {
    if (fuenteActiva() === 'final') { const r = r360(t); return r ? r.puntajes.final : null; }
    return t.puntaje;
}
function cambiarFuente(v) {
    fuenteVista = v;
    document.querySelectorAll('.sel-fuente').forEach(sel => { sel.value = v; });
    renderVistaTec(vistaTecActual);
}
function chip360(t) {
    const r = r360(t);
    if (!r || r.puntajes.final == null) return '';
    const fuentes = ['auto', 'par', 'supervisor', 'ingenieria'].filter(k => r.puntajes[k] != null).length;
    return `<span class="chip-360" title="Final ponderado de la evaluación 360° (${fuentes} de 4 fuentes)">360° ${pct(r.puntajes.final)}</span>`;
}
function resumen360Html(t) {
    const r = r360(t);
    if (!r) return '';
    const d = e360.datos;
    const partes = ['auto', 'par', 'supervisor', 'ingenieria'].map(k => `<span><b>${pct(r.puntajes[k])}</b>${escaparHTML(d.tipos[k].corto)} · ${Math.round(d.campana.pesos[k] * 100)}%</span>`).join('');
    return `<div class="perfil-360">
        <div class="perfil-360-final"><strong>${pct(r.puntajes.final)}</strong><small>Final ponderado 360°<br>${escaparHTML(d.campana.nombre)}</small></div>
        <div class="perfil-360-partes">${partes}</div>
        <button type="button" class="btn btn-secondary btn-sm" onclick="detalle360('${attr(t.id)}')">🔍 Detalle por acción</button>
    </div>`;
}
document.addEventListener('DOMContentLoaded', () => document.querySelectorAll('.sel-fuente').forEach(sel => { sel.value = fuenteVista; }));

async function asignarSupervisoresPerfil360() {
    try {
        const r = await postJSON('/api/360/asignar', { campanaId: e360.campanaId, modo: 'supervisores-perfil', rol: document.getElementById('e360-rol').value, area: filtroArea('e360-area') });
        await cargar360();
        alert(`👔 ${r.asignadas} evaluaciones de supervisor asignadas según el perfil de cada técnico.${r.sinSupervisor ? `\n\n⚠️ ${r.sinSupervisor} técnicos no tienen supervisor en su perfil. Complétalo en el perfil o con ⬇️ Lista en Excel → 📥 Cargar Excel.` : ''}`);
    } catch (err) { alert('❌ ' + err.message); }
}
