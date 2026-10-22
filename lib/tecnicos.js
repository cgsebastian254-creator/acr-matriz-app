// =====================================================================
// Técnicos, matriz de polivalencia y programación de turnos
//
// Escala de nivel por habilidad: 1 No sabe · 2 Básico · 3 Autónomo · 4 Experto (forma a otros)
// Puntaje ponderado = Σ (nivel / 4) × peso de la habilidad, sobre las habilidades evaluadas del rol.
// Las evaluaciones se guardan por semestre (2026-S1, 2026-S2) para ver si el técnico mejoró.
// =====================================================================
const crypto = require('crypto');
const XLSX = require('xlsx');
const { aISO, esISO, sumarDias, lunesDe, textoFecha } = require('./fechas');

const NIVELES = { 1: 'No sabe', 2: 'Básico', 3: 'Autónomo', 4: 'Experto' };

// Catálogo definido por los ingenieros (matriz de competencias de mantenimiento)
function habilidadesPorDefecto() {
    const mec = [
        ['Competencias Técnicas', 'Diagnóstico mecánico', 'Identificación de fallas mecánicas y causa raíz', 0.10, 'Capacidad'],
        ['Competencias Técnicas', 'Ajuste de sistemas de transmisión', 'Ajuste y tensionado de correas / cadenas', 0.10, 'Capacidad'],
        ['Competencias Técnicas', 'Montaje de rodamientos', 'Técnicas adecuadas de montaje y desmontaje', 0.05, 'Capacidad'],
        ['Competencias Técnicas', 'Lubricación', 'Aplicación correcta de lubricantes y frecuencias', 0.05, 'Capacidad'],
        ['Competencias Técnicas', 'Interpretación de planos mecánicos', 'Lectura de planos, ensambles y tolerancias', 0.10, 'Capacidad'],
        ['Confiabilidad del Activo', 'Reducción de averías', 'Impacto en la eliminación de fallas repetitivas', 0.10, 'Resultado'],
        ['Confiabilidad del Activo', 'Aumento de MTBF', 'Mejora en el comportamiento del activo', 0.10, 'Resultado'],
        ['Confiabilidad del Activo', 'Calidad del preventivo', 'Hallazgos y precisión en inspecciones mecánicas', 0.10, 'Resultado'],
        ['Seguridad', 'Bloqueo y aislamiento', 'Cumplimiento de procedimientos de seguridad mecánica', 0.08, 'Capacidad'],
        ['Seguridad', 'APR y estándares', 'Calidad del análisis previo', 0.06, 'Capacidad'],
        ['Seguridad', 'Orden y 5S', 'Cuidado del área y herramientas', 0.06, 'Capacidad'],
        ['Habilidades Blandas', 'Trabajo en equipo', 'Coordinación con producción y otros técnicos', 0.04, 'Capacidad'],
        ['Habilidades Blandas', 'Toma de decisiones', 'Criterio técnico y oportunidad', 0.03, 'Capacidad'],
        ['Habilidades Blandas', 'Comunicación', 'Claridad en reportes mecánicos', 0.03, 'Capacidad']
    ];
    const ele = [
        ['Competencias Técnicas', 'Diagnóstico de fallas', 'Capacidad para identificar causa raíz', 0.10, 'Capacidad'],
        ['Competencias Técnicas', 'Ejecución técnica', 'Calidad del trabajo eléctrico / electrónico', 0.10, 'Capacidad'],
        ['Competencias Técnicas', 'Interpretación de planos', 'Lectura de P&ID y diagramas', 0.05, 'Capacidad'],
        ['Competencias Técnicas', 'Uso de instrumentos', 'Multímetro, megger, termografía', 0.05, 'Capacidad'],
        ['Competencias Técnicas', 'Gestión documentaria', 'OT completas y claridad', 0.10, 'Capacidad'],
        ['Confiabilidad del Activo', 'Reducción de averías', 'Impacto en eliminar fallas repetitivas', 0.10, 'Resultado'],
        ['Confiabilidad del Activo', 'Aumento de MTBF', 'Mejora en desempeño del activo', 0.10, 'Resultado'],
        ['Confiabilidad del Activo', 'Calidad del preventivo', 'Hallazgos y precisión', 0.10, 'Resultado'],
        ['Seguridad', 'LOTOTO', 'Cumplimiento estricto', 0.08, 'Capacidad'],
        ['Seguridad', 'APR y estándares', 'Calidad del análisis previo', 0.06, 'Capacidad'],
        ['Seguridad', 'Orden y 5S', 'Cuidado de herramientas y área', 0.06, 'Capacidad'],
        ['Habilidades Blandas', 'Trabajo en equipo', 'Colaboración con producción y otros técnicos', 0.04, 'Capacidad'],
        ['Habilidades Blandas', 'Toma de decisiones', 'Actuar rápido con criterio', 0.03, 'Capacidad'],
        ['Habilidades Blandas', 'Comunicación', 'Claridad en reportes', 0.03, 'Capacidad']
    ];
    let n = 1;
    const fila = rol => ([categoria, nombre, descripcion, peso, tipo]) => ({ id: `H${String(n++).padStart(3, '0')}`, rol, categoria, nombre, descripcion, peso, tipo });
    return [...mec.map(fila('Mecánico')), ...ele.map(fila('Electricista'))];
}

function tiposTurnoPorDefecto() {
    return [
        { codigo: 'M', nombre: 'Mañana', inicio: '06:00', fin: '14:00', color: '#f59e0b', labora: true },
        { codigo: 'T', nombre: 'Tarde', inicio: '14:00', fin: '22:00', color: '#3b82f6', labora: true },
        { codigo: 'N', nombre: 'Noche', inicio: '22:00', fin: '06:00', color: '#8b5cf6', labora: true },
        { codigo: 'ADM', nombre: 'Administrativo', inicio: '07:00', fin: '17:00', color: '#14b8a6', labora: true },
        { codigo: 'D', nombre: 'Descanso', inicio: '', fin: '', color: '#64748b', labora: false },
        { codigo: 'V', nombre: 'Vacaciones', inicio: '', fin: '', color: '#10b981', labora: false },
        { codigo: 'P', nombre: 'Permiso / Ausente', inicio: '', fin: '', color: '#ef4444', labora: false },
        { codigo: 'C', nombre: 'Capacitación', inicio: '07:00', fin: '17:00', color: '#ec4899', labora: false }
    ];
}

function normalizar(t) {
    return String(t || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function normalizarRol(r) {
    const t = normalizar(r);
    if (/electr/.test(t)) return 'Electricista';
    if (/mec/.test(t)) return 'Mecánico';
    if (/instrum/.test(t)) return 'Instrumentista';
    if (/lubric/.test(t)) return 'Lubricador';
    if (/ingen/.test(t)) return 'Ingeniero';
    return r ? String(r).trim() : 'Mecánico';
}

function nuevoId(prefijo) { return `${prefijo}-${Date.now().toString(36)}${crypto.randomBytes(2).toString('hex')}`; }

function periodoDe(iso) {
    const f = esISO(iso) ? iso : new Date().toISOString().slice(0, 10);
    return `${f.slice(0, 4)}-S${Number(f.slice(5, 7)) <= 6 ? 1 : 2}`;
}

function ordenarEvaluaciones(evs) {
    return (evs || []).slice().sort((a, b) => String(a.periodo).localeCompare(String(b.periodo)));
}

function nivelesActuales(tec) {
    const evs = ordenarEvaluaciones(tec.evaluaciones);
    return evs.length ? evs[evs.length - 1].niveles || {} : {};
}

// Puntaje ponderado (0 a 1) de un juego de niveles para un rol
function puntaje(niveles, rol, habilidades, tipo) {
    const del = habilidades.filter(h => h.rol === rol && (!tipo || h.tipo === tipo));
    let suma = 0, pesos = 0;
    for (const h of del) {
        const n = Number(niveles && niveles[h.id]);
        if (!n) continue;
        suma += (n / 4) * h.peso;
        pesos += h.peso;
    }
    if (!pesos) return null;
    // Si se evaluaron todas, los pesos suman 1; si faltan, se escala sobre lo evaluado
    return suma / pesos;
}

function resumenTecnico(tec, habilidades) {
    const evs = ordenarEvaluaciones(tec.evaluaciones);
    const actual = evs.length ? evs[evs.length - 1] : null;
    const anterior = evs.length > 1 ? evs[evs.length - 2] : null;
    const p = actual ? puntaje(actual.niveles, tec.rol, habilidades) : null;
    const pa = anterior ? puntaje(anterior.niveles, tec.rol, habilidades) : null;
    return {
        puntaje: p,
        periodo: actual ? actual.periodo : null,
        variacion: p != null && pa != null ? p - pa : null,
        periodoAnterior: anterior ? anterior.periodo : null
    };
}

function limpiarTecnico(entrada, existente) {
    const t = existente ? { ...existente } : { id: nuevoId('T'), evaluaciones: [], creado: new Date().toISOString() };
    const texto = (v, max = 120) => String(v == null ? '' : v).trim().slice(0, max);
    if (entrada.nombre !== undefined) t.nombre = texto(entrada.nombre, 100);
    if (entrada.rol !== undefined) t.rol = normalizarRol(entrada.rol);
    for (const c of ['cargo', 'linea', 'telefono', 'codigo', 'turnoHabitual']) if (entrada[c] !== undefined) t[c] = texto(entrada[c], 80);
    if (entrada.correo !== undefined) t.correo = texto(entrada.correo, 120).toLowerCase();
    if (entrada.notas !== undefined) t.notas = texto(entrada.notas, 2000);
    if (entrada.activo !== undefined) t.activo = entrada.activo !== false && entrada.activo !== 'false';
    if (entrada.especialidades !== undefined) {
        const lista = Array.isArray(entrada.especialidades) ? entrada.especialidades : String(entrada.especialidades).split(/[,;\n]/);
        t.especialidades = [...new Set(lista.map(x => texto(x, 60)).filter(Boolean))].slice(0, 40);
    }
    if (!t.rol) t.rol = 'Mecánico';
    if (t.activo === undefined) t.activo = true;
    t.actualizado = new Date().toISOString();
    return t;
}

// Guarda niveles en la evaluación del semestre actual (se crea copiando la anterior si no existe)
function evaluar(tec, niveles, por, fechaISO) {
    const periodo = periodoDe(fechaISO);
    const evs = ordenarEvaluaciones(tec.evaluaciones);
    let ev = evs.find(e => e.periodo === periodo);
    if (!ev) {
        const previa = evs.length ? evs[evs.length - 1].niveles : {};
        ev = { periodo, niveles: { ...previa } };
        evs.push(ev);
    }
    for (const [h, n] of Object.entries(niveles || {})) {
        const v = Number(n);
        if (v >= 1 && v <= 4) ev.niveles[h] = v; else delete ev.niveles[h];
    }
    ev.fecha = fechaISO;
    ev.por = por || '';
    tec.evaluaciones = ordenarEvaluaciones(evs);
    tec.actualizado = new Date().toISOString();
    return tec;
}

// ---------------------------------------------------------------
// Importar la matriz de competencias en Excel (hojas DimTecnico, DimHabilidad,
// DimPeriodo, FactEvaluacion) o una hoja simple "Técnicos" con Nombre / Rol / Línea / Especialidades
// ---------------------------------------------------------------
function hojaComoFilas(wb, ...nombres) {
    const nombre = wb.SheetNames.find(s => nombres.some(n => normalizar(s) === normalizar(n)))
        || wb.SheetNames.find(s => nombres.some(n => normalizar(s).includes(normalizar(n))));
    if (!nombre) return null;
    return XLSX.utils.sheet_to_json(wb.Sheets[nombre], { defval: '', raw: true }).map(fila => {
        const o = {};
        for (const [k, v] of Object.entries(fila)) o[normalizar(k).replace(/[^a-z0-9]/g, '')] = v;
        return o;
    });
}

function importarMatriz(buffer, datos, por) {
    const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true });
    const resumen = { tecnicosNuevos: 0, tecnicosActualizados: 0, habilidades: 0, evaluaciones: 0, avisos: [] };
    let habilidades = datos.habilidades;

    const filasHab = hojaComoFilas(wb, 'DimHabilidad', 'Habilidades');
    const mapaHab = {};   // id del Excel -> id en la app
    if (filasHab && filasHab.length) {
        const nuevas = [];
        for (const f of filasHab) {
            const id = String(f.habilidadid || f.id || '').trim();
            const nombre = String(f.subcategoria || f.habilidad || f.nombre || '').trim();
            if (!id || !nombre) continue;
            const peso = Number(String(f.peso).replace('%', '').replace(',', '.'));
            nuevas.push({
                id, rol: normalizarRol(f.rol), categoria: String(f.categoria || '').trim(), nombre,
                descripcion: String(f.descripcion || '').trim(),
                peso: peso > 1 ? peso / 100 : (peso || 0),
                tipo: /result/i.test(f.tipoindicador || f.tipo) ? 'Resultado' : 'Capacidad'
            });
            mapaHab[id] = id;
        }
        if (nuevas.length) { habilidades = nuevas; resumen.habilidades = nuevas.length; }
    }

    const filasTec = hojaComoFilas(wb, 'DimTecnico', 'Tecnicos', 'Técnicos', 'Personal');
    if (!filasTec || !filasTec.length) {
        throw new Error('No encontré una hoja de técnicos (DimTecnico o Técnicos) con la columna Nombre.');
    }
    const tecnicos = datos.tecnicos.slice();
    const porCodigo = {};
    for (const f of filasTec) {
        const nombre = String(f.nombre || f.tecnico || f.nombrecompleto || '').trim();
        if (!nombre) continue;
        const codigo = String(f.tecnicoid || f.codigo || f.id || '').trim();
        let t = tecnicos.find(x => (codigo && x.codigo === codigo) || normalizar(x.nombre) === normalizar(nombre));
        const entrada = {
            nombre, codigo, rol: f.rol || (t && t.rol) || 'Mecánico',
            linea: f.area || f.linea || (t && t.linea) || '',
            activo: f.activo === '' ? true : !/^(no|n|false|0|inactivo)$/i.test(String(f.activo).trim())
        };
        if (f.especialidades || f.especialidad) entrada.especialidades = f.especialidades || f.especialidad;
        if (f.correo || f.email) entrada.correo = f.correo || f.email;
        if (f.telefono || f.celular) entrada.telefono = f.telefono || f.celular;
        if (f.cargo) entrada.cargo = f.cargo;
        if (t) {
            Object.assign(t, limpiarTecnico(entrada, t));
            resumen.tecnicosActualizados++;
        } else {
            t = limpiarTecnico(entrada);
            tecnicos.push(t);
            resumen.tecnicosNuevos++;
        }
        if (codigo) porCodigo[codigo] = t;
    }

    const filasPer = hojaComoFilas(wb, 'DimPeriodo', 'Periodos') || [];
    const periodos = {};
    for (const f of filasPer) {
        const id = String(f.periodoid || f.id || '').trim();
        const etiqueta = String(f.etiqueta || '').trim();
        const fecha = aISO(f.fechaevaluacion || f.fecha);
        periodos[id] = { periodo: /^\d{4}-S[12]$/.test(etiqueta) ? etiqueta : periodoDe(fecha), fecha };
    }

    const filasEv = hojaComoFilas(wb, 'FactEvaluacion', 'Evaluaciones', 'Evaluacion') || [];
    for (const f of filasEv) {
        const t = porCodigo[String(f.tecnicoid || '').trim()];
        const h = String(f.habilidadid || '').trim();
        const nivel = Number(f.nivel);
        if (!t || !h || !(nivel >= 1 && nivel <= 4)) continue;
        const per = periodos[String(f.periodoid || '').trim()] || { periodo: periodoDe(), fecha: '' };
        t.evaluaciones = t.evaluaciones || [];
        let ev = t.evaluaciones.find(e => e.periodo === per.periodo);
        if (!ev) { ev = { periodo: per.periodo, fecha: per.fecha, niveles: {}, por: por || 'Importado de Excel' }; t.evaluaciones.push(ev); }
        ev.niveles[mapaHab[h] || h] = nivel;
        resumen.evaluaciones++;
    }
    tecnicos.forEach(t => { t.evaluaciones = ordenarEvaluaciones(t.evaluaciones); });
    if (filasEv.length && !resumen.evaluaciones) resumen.avisos.push('La hoja de evaluaciones no coincidió con los TecnicoID de la hoja de técnicos.');
    return { tecnicos, habilidades, resumen };
}

// ---------------------------------------------------------------
// Turnos
// asignaciones: { "2026-10-26": { "T-abc": "M", ... }, ... }
// ---------------------------------------------------------------
function asignacionesRango(turnos, desde, hasta) {
    const r = {};
    for (const [f, v] of Object.entries(turnos.asignaciones || {})) if (f >= desde && f <= hasta) r[f] = v;
    return r;
}

function aplicarCambios(turnos, cambios, tecnicosValidos) {
    const codigos = new Set(turnos.tipos.map(t => t.codigo));
    let n = 0;
    for (const c of cambios || []) {
        if (!esISO(c.fecha) || !tecnicosValidos.has(c.tecnicoId)) continue;
        const codigo = String(c.codigo || '').trim().toUpperCase();
        turnos.asignaciones[c.fecha] = turnos.asignaciones[c.fecha] || {};
        if (!codigo) delete turnos.asignaciones[c.fecha][c.tecnicoId];
        else if (codigos.has(codigo)) turnos.asignaciones[c.fecha][c.tecnicoId] = codigo;
        else continue;
        if (!Object.keys(turnos.asignaciones[c.fecha]).length) delete turnos.asignaciones[c.fecha];
        n++;
    }
    return n;
}

function copiarSemana(turnos, lunesOrigen, lunesDestino, sobrescribir) {
    let n = 0;
    for (let i = 0; i < 7; i++) {
        const o = turnos.asignaciones[sumarDias(lunesOrigen, i)] || {};
        const dKey = sumarDias(lunesDestino, i);
        const d = turnos.asignaciones[dKey] || {};
        for (const [tec, cod] of Object.entries(o)) {
            if (d[tec] && !sobrescribir) continue;
            d[tec] = cod; n++;
        }
        if (Object.keys(d).length) turnos.asignaciones[dKey] = d;
    }
    return n;
}

const DIAS_CORTOS = ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'];

function plantillaTurnos(turnos, tecnicos, lunes) {
    const dias = [...Array(7)].map((_, i) => sumarDias(lunes, i));
    const encabezado = ['Técnico', 'Rol', 'Código', ...dias.map((d, i) => `${DIAS_CORTOS[i]} ${textoFecha(d)}`)];
    const filas = tecnicos.filter(t => t.activo !== false)
        .sort((a, b) => (a.rol || '').localeCompare(b.rol || '') || a.nombre.localeCompare(b.nombre))
        .map(t => [t.nombre, t.rol, t.id, ...dias.map(d => (turnos.asignaciones[d] || {})[t.id] || '')]);
    const ws = XLSX.utils.aoa_to_sheet([encabezado, ...filas]);
    ws['!cols'] = [{ wch: 30 }, { wch: 14 }, { wch: 14 }, ...dias.map(() => ({ wch: 14 }))];
    const ayuda = XLSX.utils.aoa_to_sheet([
        ['Código', 'Turno', 'Horario', '¿Labora?'],
        ...turnos.tipos.map(t => [t.codigo, t.nombre, t.inicio ? `${t.inicio} - ${t.fin}` : '', t.labora ? 'Sí' : 'No']),
        [],
        ['Instrucciones: escribe el código del turno en cada día. Deja la celda vacía si no está programado.'],
        ['No cambies la columna "Código" (identifica al técnico). Puedes agregar técnicos nuevos escribiendo su nombre exacto como aparece en la app.']
    ]);
    ayuda['!cols'] = [{ wch: 10 }, { wch: 22 }, { wch: 16 }, { wch: 10 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Programación');
    XLSX.utils.book_append_sheet(wb, ayuda, 'Códigos de turno');
    return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

function importarTurnos(buffer, turnos, tecnicos) {
    const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const filas = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', raw: true });
    if (filas.length < 2) throw new Error('La hoja está vacía.');
    const enc = filas[0];
    const columnasFecha = [];
    enc.forEach((v, i) => { const f = aISO(v); if (f) columnasFecha.push([i, f]); });
    if (!columnasFecha.length) throw new Error('No encontré fechas en la primera fila (por ejemplo "Lun 27/10/2026").');
    const iNombre = enc.findIndex(v => /t[eé]cnico|nombre/i.test(String(v)));
    const iCodigo = enc.findIndex(v => /^c[oó]digo$|^id$/i.test(String(v).trim()));
    const porNombreTipo = Object.fromEntries(turnos.tipos.map(t => [normalizar(t.nombre), t.codigo]));
    const codigos = new Set(turnos.tipos.map(t => t.codigo));
    const cambios = [];
    const noEncontrados = [];
    const codigosRaros = new Set();
    for (const fila of filas.slice(1)) {
        const nombre = String(fila[iNombre >= 0 ? iNombre : 0] || '').trim();
        const id = iCodigo >= 0 ? String(fila[iCodigo] || '').trim() : '';
        if (!nombre && !id) continue;
        const t = tecnicos.find(x => (id && x.id === id) || normalizar(x.nombre) === normalizar(nombre));
        if (!t) { noEncontrados.push(nombre || id); continue; }
        for (const [i, fecha] of columnasFecha) {
            let v = String(fila[i] == null ? '' : fila[i]).trim();
            let codigo = v.toUpperCase();
            if (v && !codigos.has(codigo)) codigo = porNombreTipo[normalizar(v)] || '';
            if (v && !codigo) { codigosRaros.add(v); continue; }
            cambios.push({ fecha, tecnicoId: t.id, codigo });
        }
    }
    const n = aplicarCambios(turnos, cambios, new Set(tecnicos.map(t => t.id)));
    return {
        celdas: n,
        desde: columnasFecha[0][1],
        hasta: columnasFecha[columnasFecha.length - 1][1],
        noEncontrados,
        codigosDesconocidos: [...codigosRaros]
    };
}

function limpiarTipos(lista) {
    const vistos = new Set();
    const r = [];
    for (const t of lista || []) {
        const codigo = String(t.codigo || '').trim().toUpperCase().slice(0, 4);
        if (!codigo || vistos.has(codigo)) continue;
        vistos.add(codigo);
        const hora = h => /^\d{1,2}:\d{2}$/.test(String(h || '').trim()) ? String(h).trim().padStart(5, '0') : '';
        r.push({
            codigo,
            nombre: String(t.nombre || codigo).trim().slice(0, 40),
            inicio: hora(t.inicio), fin: hora(t.fin),
            color: /^#[0-9a-f]{6}$/i.test(t.color) ? t.color : '#64748b',
            labora: t.labora === true || t.labora === 'true'
        });
    }
    return r;
}

module.exports = {
    NIVELES, habilidadesPorDefecto, tiposTurnoPorDefecto, normalizar, normalizarRol, periodoDe,
    nivelesActuales, puntaje, resumenTecnico, limpiarTecnico, evaluar, importarMatriz,
    asignacionesRango, aplicarCambios, copiarSemana, plantillaTurnos, importarTurnos, limpiarTipos, lunesDe
};
