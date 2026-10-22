// =====================================================================
// TÉCNICOS, MATRIZ DE POLIVALENCIA, TURNOS Y NOTIFICACIONES (interfaz)
// =====================================================================
const tec = { tecnicos: [], habilidades: [], niveles: {}, periodoActual: '', cargado: false };
const turnos = { tipos: [], asignaciones: {}, rangos: [], semana: '' };
let diaInicioOffset = 0;

const ICONO_ROL = { 'Mecánico': '🔧', 'Electricista': '⚡', 'Instrumentista': '📟', 'Lubricador': '🛢️', 'Ingeniero': '👷' };
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
        const d = await (await fetch('/api/tecnicos')).json();
        Object.assign(tec, d, { cargado: true });
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
    const hoy = ahoraBogotaCliente().fecha;
    const semana = turnos.semana || lunesISO(hoy);
    await cargarRangoTurnos(sumarDiasISO(lunesISO(hoy), -7), sumarDiasISO(lunesISO(hoy), 20));
    if (semana) await cargarRangoTurnos(semana, sumarDiasISO(semana, 6));
    renderTodoTecnicos();
}

function renderTodoTecnicos() {
    renderTurnoHoy();
    if (document.getElementById('tab-tecnicos')?.classList.contains('active')) {
        renderBuscador(); renderPerfiles(); renderMatrizPolivalencia(); renderTurnos();
    }
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
function vistaTecnicos(vista) {
    document.querySelectorAll('#tab-tecnicos .subtab').forEach(b => b.classList.toggle('activo', b.dataset.vista === vista));
    ['buscar', 'perfiles', 'matriz', 'turnos'].forEach(v => {
        document.getElementById('tec-vista-' + v).style.display = v === vista ? '' : 'none';
    });
    if (vista === 'buscar') renderBuscador();
    if (vista === 'perfiles') renderPerfiles();
    if (vista === 'matriz') renderMatrizPolivalencia();
    if (vista === 'turnos') cargarTurnos();
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
    const disp = document.getElementById('buscar-tec-turno').value;
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
                   <button class="btn btn-primary btn-sm" onclick="asignarAPendiente('${attr(t.id)}')">📝 Asignar pendiente</button>`
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
                <small>${escaparHTML(t.rol)}${t.cargo ? ' · ' + escaparHTML(t.cargo) : ''}${t.linea ? ' · ' + escaparHTML(t.linea) : ''}</small>
            </div>
            <div class="tt-puntaje" title="Puntaje ponderado de la matriz de polivalencia">${pct(t.puntaje)}${variacion}</div>
        </div>
        <div class="tt-turno">Hoy: ${badgeTurno(cod)} ${ahora ? '<span class="badge badge-realizado">🟢 En turno ahora</span>' : ''}</div>
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
    const lista = tec.tecnicos.filter(t => (rol === 'TODOS' || t.rol === rol) &&
        (!q || normalizarTexto([t.nombre, t.linea, t.cargo, ...(t.especialidades || [])].join(' ')).includes(q)))
        .sort((a, b) => (b.activo !== false) - (a.activo !== false) || a.nombre.localeCompare(b.nombre, 'es'));
    cont.innerHTML = lista.length ? lista.map(t => tarjetaTecnico(t, {
        acciones: `<button class="btn btn-primary btn-sm" onclick="abrirPerfil('${attr(t.id)}')">✏️ Ver / editar</button>${t.activo === false ? ' <span class="badge badge-gris">Inactivo</span>' : ''}`
    })).join('') : `<div class="vacio">${tec.tecnicos.length ? 'Ningún técnico coincide.' : 'Aún no hay técnicos. Usa "➕ Nuevo técnico" o "📥 Importar matriz (Excel)" con el archivo de la matriz de competencias (hojas DimTecnico, DimHabilidad y FactEvaluacion).'}</div>`;
}

let perfilNiveles = {};
function abrirPerfil(id) {
    const t = id ? tec.tecnicos.find(x => x.id === id) : null;
    document.getElementById('perfil-titulo').textContent = t ? t.nombre : 'Nuevo técnico';
    document.getElementById('perfil-id').value = t ? t.id : '';
    document.getElementById('perfil-nombre').value = t ? t.nombre : '';
    document.getElementById('perfil-rol').value = t ? t.rol : 'Mecánico';
    document.getElementById('perfil-cargo').value = t ? t.cargo || '' : '';
    const selLinea = document.getElementById('perfil-linea');
    if (t && t.linea && ![...selLinea.options].some(o => o.value === t.linea)) selLinea.add(new Option(t.linea, t.linea));
    selLinea.value = t ? t.linea || '' : '';
    document.getElementById('perfil-telefono').value = t ? t.telefono || '' : '';
    document.getElementById('perfil-correo').value = t ? t.correo || '' : '';
    document.getElementById('perfil-especialidades').value = t ? (t.especialidades || []).join(', ') : '';
    document.getElementById('perfil-notas').value = t ? t.notas || '' : '';
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
                <div><span>${pct(t.puntaje)}</span>Puntaje ${escaparHTML(t.periodo || '')}</div>
                <div><span>${t.variacion == null ? '—' : (t.variacion >= 0 ? '▲ ' : '▼ ') + Math.abs(Math.round(t.variacion * 100)) + ' pts'}</span>vs ${escaparHTML(t.periodoAnterior || 'semestre anterior')}</div>
                <div><span>${badgeTurno(codigoTurno(t.id, hoy))}</span>Turno de hoy</div>
            </div>
            ${fuertes.length ? `<p class="perfil-linea">💪 <strong>Experto en:</strong> ${fuertes.map(escaparHTML).join(', ')}</p>` : ''}
            ${formar.length ? `<p class="perfil-linea">📚 <strong>Por formar:</strong> ${formar.map(escaparHTML).join(', ')}</p>` : ''}`;
        extra.innerHTML = `
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

async function importarMatrizExcel(input) {
    const archivo = input.files[0];
    input.value = '';
    if (!archivo) return;
    if (!confirm(`¿Importar "${archivo.name}"?\n\nSe agregan o actualizan los técnicos por nombre/código, y si el archivo trae la hoja DimHabilidad se reemplaza el catálogo de habilidades.`)) return;
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
    const editar = document.getElementById('matriz-editar').checked;
    const habs = tec.habilidades.filter(h => h.rol === rol);
    const hoy = ahoraBogotaCliente().fecha;
    const lista = tec.tecnicos.filter(t => t.rol === rol && t.activo !== false);
    if (document.getElementById('matriz-orden').value === 'nombre') lista.sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));
    else lista.sort((a, b) => (b.puntaje ?? -1) - (a.puntaje ?? -1));
    if (!lista.length) { tabla.innerHTML = `<tr><td style="padding: 20px; color: var(--text-muted);">No hay ${rol === 'Mecánico' ? 'mecánicos' : 'electricistas'} registrados.</td></tr>`; return; }
    const cats = [];
    habs.forEach(h => { const c = cats.find(x => x.nombre === h.categoria); if (c) c.n++; else cats.push({ nombre: h.categoria, n: 1 }); });
    // Fila final: promedio por habilidad (dónde está la brecha del equipo)
    const promedio = h => {
        const v = lista.map(t => Number((t.niveles || {})[h.id])).filter(Boolean);
        return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
    };
    tabla.innerHTML = `
        <thead>
            <tr><th rowspan="2" class="col-fija">#&nbsp;Técnico</th><th rowspan="2">Hoy</th>${cats.map(c => `<th colspan="${c.n}" class="cat">${escaparHTML(c.nombre)}</th>`).join('')}<th rowspan="2">Puntaje</th></tr>
            <tr>${habs.map(h => `<th class="hab" title="${attr(h.descripcion)} · peso ${Math.round(h.peso * 100)}%"><span>${escaparHTML(h.nombre)}</span></th>`).join('')}</tr>
        </thead>
        <tbody>
            ${lista.map((t, i) => `<tr>
                <td class="col-fija"><button class="link" onclick="abrirPerfil('${attr(t.id)}')">${i + 1}. ${escaparHTML(t.nombre)}</button></td>
                <td>${(() => { const tt = tipoTurno(codigoTurno(t.id, hoy)); return tt ? `<span class="cod-turno" style="background:${tt.color}">${escaparHTML(tt.codigo)}</span>` : '—'; })()}</td>
                ${habs.map(h => {
                    const n = Number((t.niveles || {})[h.id]) || 0;
                    return editar
                        ? `<td class="nivel-celda n${n}"><select onchange="cambiarNivel('${attr(t.id)}', '${h.id}', this.value)"><option value="0">—</option>${[1, 2, 3, 4].map(v => `<option value="${v}" ${v === n ? 'selected' : ''}>${v}</option>`).join('')}</select></td>`
                        : `<td class="nivel-celda n${n}" title="${attr(h.nombre)}: ${n ? tec.niveles[n] : 'Sin evaluar'}">${n || '—'}</td>`;
                }).join('')}
                <td class="puntaje-celda">${pct(t.puntaje)}${t.variacion != null ? `<small class="${t.variacion >= 0 ? 'sube' : 'baja'}">${t.variacion >= 0 ? '▲' : '▼'}${Math.abs(Math.round(t.variacion * 100))}</small>` : ''}</td>
            </tr>`).join('')}
            <tr class="fila-promedio"><td class="col-fija">Promedio del equipo</td><td></td>${habs.map(h => { const p = promedio(h); return `<td class="nivel-celda n${p ? Math.round(p) : 0}">${p ? p.toFixed(1) : '—'}</td>`; }).join('')}<td></td></tr>
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
    document.getElementById('notif-cie-activo').checked = notif.cierre.activo;
    document.getElementById('notif-cie-hora').value = notif.cierre.hora;
    document.getElementById('notif-copia').value = (notif.copia || []).join(', ');
    renderDias('notif-rec-dias', notif.recordatorio.dias);
    renderDias('notif-cie-dias', notif.cierre.dias);
    renderIngenieros();
    renderEstadoPowerAutomate();
    fetch('/api/status').then(r => r.json()).then(st => {
        const caja = document.getElementById('estado-base-datos');
        if (!caja) return;
        caja.innerHTML = st.baseDatos === 'conectada'
            ? '🟢 <strong>MongoDB Atlas conectada.</strong> ACR, pendientes, historial, técnicos, matriz y turnos se guardan en la nube y no se pierden aunque Render se reinicie.'
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
        </div>`).join('') : '<div class="vacio">Todavía no hay ingenieros. Agrega al menos uno con sus líneas para que lleguen los avisos.</div>';
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
        copia: document.getElementById('notif-copia').value,
        recordatorio: {
            activo: document.getElementById('notif-rec-activo').checked,
            hora: document.getElementById('notif-rec-hora').value,
            anticipacion: Number(document.getElementById('notif-rec-anticipacion').value),
            dias: leerDias('notif-rec-dias')
        },
        cierre: {
            activo: document.getElementById('notif-cie-activo').checked,
            hora: document.getElementById('notif-cie-hora').value,
            dias: leerDias('notif-cie-dias')
        }
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
        box.textContent = r.asunto ? `Asunto: ${r.asunto}\n(vista previa con todas las líneas; cada ingeniero recibe solo las suyas)` : 'Nada que enviar ahora mismo.';
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
        <div>Último recordatorio automático: <strong>${escaparHTML(st.ultimoRecordatorio ? fechaTxt(st.ultimoRecordatorio) : 'aún no')}</strong> · Último cierre del día: <strong>${escaparHTML(st.ultimoCierre ? fechaTxt(st.ultimoCierre) : 'aún no')}</strong></div>
        ${(pa.ultimosEnvios || []).length ? `<div style="margin-top: 8px;">Últimos correos en cola:</div><ul style="margin: 4px 0 0 18px;">${pa.ultimosEnvios.map(e => `<li>${escaparHTML(fecha(e.fecha))} → ${escaparHTML((e.para || []).join(', '))}: ${escaparHTML(e.asunto)}</li>`).join('')}</ul>` : ''}`;
}
