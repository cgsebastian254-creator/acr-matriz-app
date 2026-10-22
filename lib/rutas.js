// =====================================================================
// Rutas nuevas: técnicos y polivalencia, turnos, pendientes diarios
// (eliminar, historial por máquina y fecha) y notificaciones automáticas.
// =====================================================================
const docs = require('./docs');
const T = require('./tecnicos');
const { hoyISO, sumarDias, lunesDe, esISO, aISO, textoFecha } = require('./fechas');
const { limpiarConfig, LINEAS, fechaCompromiso } = require('./notificaciones');

function datosTecnicos() {
    return docs.obtener('tecnicos', () => ({ tecnicos: [], habilidades: T.habilidadesPorDefecto() }));
}
function datosTurnos() {
    const t = docs.obtener('turnos', () => ({ tipos: T.tiposTurnoPorDefecto(), asignaciones: {} }));
    if (!Array.isArray(t.tipos) || !t.tipos.length) t.tipos = T.tiposTurnoPorDefecto();
    if (!t.asignaciones) t.asignaciones = {};
    return t;
}

function leerCuerpoBinario(req, max, cb) {
    const partes = [];
    let tam = 0, grande = false;
    req.on('data', c => { tam += c.length; if (tam > max) { grande = true; return; } partes.push(c); });
    req.on('end', () => cb(grande ? null : Buffer.concat(partes)));
}

function nombreUsuario(sesion, payload) {
    return String((payload && payload.usuario) || (sesion && sesion.nombre) || (sesion && sesion.correo) || 'Usuario').slice(0, 80);
}

// Normaliza los pendientes viejos (antes no tenían fecha ISO ni fecha de compromiso)
function migrarPendientes(tasks) {
    let cambio = false;
    for (const d of tasks) {
        if (!d.fechaISO) { d.fechaISO = aISO(d.fecha) || hoyISO(); cambio = true; }
        if (!d.fechaCompromiso) { d.fechaCompromiso = d.fechaISO; cambio = true; }
    }
    return cambio;
}

function ultimaActividad(d) {
    const ts = (d.historial || []).map(h => h.ts || 0);
    return Math.max(0, ...ts);
}

// Los pendientes cerrados o eliminados hace más de 60 días pasan a un archivo por mes,
// así el documento principal no crece sin límite (MongoDB admite 16 MB por documento).
async function archivarPendientes(ctx) {
    const tasks = ctx.leerDaily();
    const limite = Date.now() - 60 * 86400000;
    const quedan = [], porMes = {};
    for (const d of tasks) {
        const cerrado = d.eliminado || d.estado === 'Realizado';
        if (cerrado && ultimaActividad(d) && ultimaActividad(d) < limite) {
            const mes = (fechaCompromiso(d) || d.fechaISO || hoyISO()).slice(0, 7);
            (porMes[mes] = porMes[mes] || []).push(d);
        } else quedan.push(d);
    }
    const meses = Object.keys(porMes);
    if (!meses.length) return 0;
    const indice = new Set(docs.obtener('daily_archivo_indice', []));
    for (const mes of meses) {
        const nombre = `daily_archivo_${mes}`;
        const previo = (await docs.leerUnaVez(nombre)) || [];
        const ids = new Set(previo.map(x => x.id));
        await docs.guardar(nombre, [...previo, ...porMes[mes].filter(x => !ids.has(x.id))]);
        indice.add(mes);
    }
    await docs.guardar('daily_archivo_indice', [...indice].sort());
    ctx.escribirDaily(quedan);
    return tasks.length - quedan.length;
}

async function historialPendientes(desde, hasta, ctx) {
    const lista = ctx.leerDaily().slice();
    const meses = docs.obtener('daily_archivo_indice', []).filter(m => m >= desde.slice(0, 7) && m <= hasta.slice(0, 7));
    for (const m of meses) lista.push(...((await docs.leerUnaVez(`daily_archivo_${m}`)) || []));
    return lista.filter(d => {
        const f = fechaCompromiso(d), r = d.fechaISO || f;
        return (f >= desde && f <= hasta) || (r >= desde && r <= hasta);
    });
}

function manejar(req, res, pathname, url, sesion, ctx) {
    const { sendJson, readBody, broadcastEvent } = ctx;
    const json = (fn, max = 1024 * 1024) => readBody(req, max, async body => {
        let p;
        try { p = body ? JSON.parse(body) : {}; } catch (e) { return sendJson(res, 400, { error: 'Datos inválidos.' }); }
        try { await fn(p); } catch (e) { sendJson(res, 400, { error: e.message }); }
    });
    const avisarTecnicos = (usuario, mensaje) => broadcastEvent({ type: 'tecnicos_updated', user: usuario, message: mensaje });

    // ------------------ Técnicos y matriz de polivalencia ------------------
    if (pathname === '/api/tecnicos' && req.method === 'GET') {
        const d = datosTecnicos();
        const tecnicos = d.tecnicos.map(t => ({ ...t, ...T.resumenTecnico(t, d.habilidades), niveles: T.nivelesActuales(t) }));
        sendJson(res, 200, { tecnicos, habilidades: d.habilidades, niveles: T.NIVELES, periodoActual: T.periodoDe(hoyISO()) });
        return true;
    }
    if (pathname === '/api/tecnicos/guardar' && req.method === 'POST') {
        json(async p => {
            const d = datosTecnicos();
            if (!String(p.nombre || '').trim()) throw new Error('Escribe el nombre del técnico.');
            const i = p.id ? d.tecnicos.findIndex(t => t.id === p.id) : -1;
            const tec = T.limpiarTecnico(p, i >= 0 ? d.tecnicos[i] : null);
            const repetido = d.tecnicos.find(t => t.id !== tec.id && T.normalizar(t.nombre) === T.normalizar(tec.nombre));
            if (repetido) throw new Error(`Ya existe un técnico llamado ${repetido.nombre}.`);
            if (p.niveles) T.evaluar(tec, p.niveles, nombreUsuario(sesion, p), hoyISO());
            if (i >= 0) d.tecnicos[i] = tec; else d.tecnicos.push(tec);
            await docs.guardar('tecnicos', d);
            avisarTecnicos(nombreUsuario(sesion, p), `${i >= 0 ? 'Actualizó' : 'Agregó'} el perfil de ${tec.nombre}`);
            sendJson(res, 200, { success: true, tecnico: tec });
        });
        return true;
    }
    if (pathname === '/api/tecnicos/evaluar' && req.method === 'POST') {
        json(async p => {
            const d = datosTecnicos();
            const tec = d.tecnicos.find(t => t.id === p.id);
            if (!tec) throw new Error('Ese técnico ya no existe.');
            T.evaluar(tec, p.niveles || {}, nombreUsuario(sesion, p), hoyISO());
            await docs.guardar('tecnicos', d);
            avisarTecnicos(nombreUsuario(sesion, p), `Actualizó la matriz de ${tec.nombre}`);
            sendJson(res, 200, { success: true, ...T.resumenTecnico(tec, d.habilidades) });
        });
        return true;
    }
    if (pathname === '/api/tecnicos/eliminar' && req.method === 'POST') {
        json(async p => {
            const d = datosTecnicos();
            const tec = d.tecnicos.find(t => t.id === p.id);
            if (!tec) throw new Error('Ese técnico ya no existe.');
            d.tecnicos = d.tecnicos.filter(t => t.id !== p.id);
            await docs.guardar('tecnicos', d);
            const tr = datosTurnos();
            for (const f of Object.keys(tr.asignaciones)) {
                delete tr.asignaciones[f][p.id];
                if (!Object.keys(tr.asignaciones[f]).length) delete tr.asignaciones[f];
            }
            await docs.guardar('turnos', tr);
            avisarTecnicos(nombreUsuario(sesion, p), `Eliminó el perfil de ${tec.nombre}`);
            sendJson(res, 200, { success: true });
        });
        return true;
    }
    if (pathname === '/api/tecnicos/importar' && req.method === 'POST') {
        leerCuerpoBinario(req, 15 * 1024 * 1024, async buf => {
            if (!buf) return sendJson(res, 413, { error: 'El archivo supera 15 MB.' });
            try {
                const d = datosTecnicos();
                const r = T.importarMatriz(buf, d, nombreUsuario(sesion));
                await docs.guardar('tecnicos', { tecnicos: r.tecnicos, habilidades: r.habilidades });
                avisarTecnicos(nombreUsuario(sesion), `Importó la matriz de polivalencia (${r.resumen.tecnicosNuevos + r.resumen.tecnicosActualizados} técnicos)`);
                sendJson(res, 200, { success: true, ...r.resumen });
            } catch (e) {
                sendJson(res, 400, { error: 'No se pudo leer el Excel: ' + e.message });
            }
        });
        return true;
    }

    // ------------------ Turnos ------------------
    if (pathname === '/api/turnos' && req.method === 'GET') {
        const desde = esISO(url.searchParams.get('desde')) ? url.searchParams.get('desde') : sumarDias(lunesDe(hoyISO()), -7);
        const hasta = esISO(url.searchParams.get('hasta')) ? url.searchParams.get('hasta') : sumarDias(desde, 27);
        const t = datosTurnos();
        sendJson(res, 200, { tipos: t.tipos, desde, hasta, asignaciones: T.asignacionesRango(t, desde, hasta), hoy: hoyISO() });
        return true;
    }
    if (pathname === '/api/turnos/asignar' && req.method === 'POST') {
        json(async p => {
            const t = datosTurnos();
            const validos = new Set(datosTecnicos().tecnicos.map(x => x.id));
            const n = T.aplicarCambios(t, p.cambios, validos);
            await docs.guardar('turnos', t);
            broadcastEvent({ type: 'turnos_updated', user: nombreUsuario(sesion, p), message: `Actualizó la programación de turnos (${n} cambios)` });
            sendJson(res, 200, { success: true, cambios: n });
        });
        return true;
    }
    if (pathname === '/api/turnos/copiar-semana' && req.method === 'POST') {
        json(async p => {
            if (!esISO(p.destino)) throw new Error('Semana de destino inválida.');
            const destino = lunesDe(p.destino);
            const origen = esISO(p.origen) ? lunesDe(p.origen) : sumarDias(destino, -7);
            const t = datosTurnos();
            const n = T.copiarSemana(t, origen, destino, !!p.sobrescribir);
            await docs.guardar('turnos', t);
            broadcastEvent({ type: 'turnos_updated', user: nombreUsuario(sesion, p), message: `Copió la programación de la semana del ${textoFecha(origen)}` });
            sendJson(res, 200, { success: true, cambios: n });
        });
        return true;
    }
    if (pathname === '/api/turnos/tipos' && req.method === 'POST') {
        json(async p => {
            const tipos = T.limpiarTipos(p.tipos);
            if (!tipos.length) throw new Error('Debe quedar al menos un tipo de turno.');
            const t = datosTurnos();
            t.tipos = tipos;
            await docs.guardar('turnos', t);
            broadcastEvent({ type: 'turnos_updated', user: nombreUsuario(sesion, p), message: 'Actualizó los tipos de turno' });
            sendJson(res, 200, { success: true, tipos });
        });
        return true;
    }
    if (pathname === '/api/turnos/plantilla' && req.method === 'GET') {
        const lunes = lunesDe(esISO(url.searchParams.get('semana')) ? url.searchParams.get('semana') : hoyISO());
        const buf = T.plantillaTurnos(datosTurnos(), datosTecnicos().tecnicos, lunes);
        res.writeHead(200, {
            'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            'Content-Disposition': `attachment; filename="Turnos_semana_${lunes}.xlsx"`,
            'Cache-Control': 'no-store'
        });
        res.end(buf);
        return true;
    }
    if (pathname === '/api/turnos/importar' && req.method === 'POST') {
        leerCuerpoBinario(req, 10 * 1024 * 1024, async buf => {
            if (!buf) return sendJson(res, 413, { error: 'El archivo supera 10 MB.' });
            try {
                const t = datosTurnos();
                const r = T.importarTurnos(buf, t, datosTecnicos().tecnicos);
                await docs.guardar('turnos', t);
                broadcastEvent({ type: 'turnos_updated', user: nombreUsuario(sesion), message: `Cargó la programación del ${textoFecha(r.desde)} al ${textoFecha(r.hasta)}` });
                sendJson(res, 200, { success: true, ...r });
            } catch (e) {
                sendJson(res, 400, { error: 'No se pudo leer el Excel: ' + e.message });
            }
        });
        return true;
    }

    // ------------------ Pendientes diarios: eliminar, editar, historial ------------------
    if (pathname === '/api/daily-tasks/delete' && req.method === 'POST') {
        json(async p => {
            const tasks = ctx.leerDaily();
            const d = tasks.find(x => x.id === p.id);
            if (!d) throw new Error('Ese pendiente ya no existe. Recarga la página.');
            const usuario = nombreUsuario(sesion, p);
            d.eliminado = { por: usuario, correo: sesion && sesion.correo, fecha: new Date().toISOString(), motivo: String(p.motivo || '').slice(0, 300) };
            d.historial = d.historial || [];
            d.historial.unshift({ fecha: ctx.ahoraTexto(), ts: Date.now(), usuario, correo: sesion && sesion.correo, accion: `Pendiente eliminado${p.motivo ? '. Motivo: ' + String(p.motivo).slice(0, 300) : ''}` });
            ctx.escribirDaily(tasks);
            broadcastEvent({ type: 'daily_updated', dailyTasks: tasks, user: usuario, message: `Eliminó el pendiente '${d.compromiso}'` });
            sendJson(res, 200, { success: true });
        });
        return true;
    }
    if (pathname === '/api/daily-tasks/restaurar' && req.method === 'POST') {
        json(async p => {
            const tasks = ctx.leerDaily();
            const d = tasks.find(x => x.id === p.id);
            if (!d) throw new Error('Ese pendiente ya está en el archivo histórico y no se puede restaurar.');
            delete d.eliminado;
            const usuario = nombreUsuario(sesion, p);
            d.historial = d.historial || [];
            d.historial.unshift({ fecha: ctx.ahoraTexto(), ts: Date.now(), usuario, correo: sesion && sesion.correo, accion: 'Pendiente restaurado' });
            ctx.escribirDaily(tasks);
            broadcastEvent({ type: 'daily_updated', dailyTasks: tasks, user: usuario, message: `Restauró el pendiente '${d.compromiso}'` });
            sendJson(res, 200, { success: true });
        });
        return true;
    }
    if (pathname === '/api/daily-tasks/historial' && req.method === 'GET') {
        const hasta = esISO(url.searchParams.get('hasta')) ? url.searchParams.get('hasta') : hoyISO();
        const desde = esISO(url.searchParams.get('desde')) ? url.searchParams.get('desde') : sumarDias(hasta, -30);
        historialPendientes(desde, hasta, ctx)
            .then(lista => sendJson(res, 200, { desde, hasta, pendientes: lista }))
            .catch(e => sendJson(res, 500, { error: e.message }));
        return true;
    }

    // ------------------ Notificaciones ------------------
    if (pathname === '/api/notificaciones' && req.method === 'GET') {
        const c = ctx.notificador.config();
        sendJson(res, 200, { ...c, lineas: LINEAS, via: ctx.via, powerAutomate: ctx.estadoPowerAutomate() });
        return true;
    }
    if (pathname === '/api/notificaciones' && req.method === 'POST') {
        json(async p => {
            const actual = ctx.notificador.config();
            const nueva = limpiarConfig(p, actual);
            const malos = [...nueva.ingenieros.map(i => i.correo), ...nueva.copia].filter(c => !ctx.correoCorporativo(c));
            if (malos.length) throw new Error(`Solo se permiten correos corporativos. Revisa: ${malos.join(', ')}`);
            nueva.estado = actual.estado || {};
            await docs.guardar('notificaciones', nueva);
            sendJson(res, 200, { success: true });
        });
        return true;
    }
    if (pathname === '/api/notificaciones/vista-previa' && req.method === 'GET') {
        const tipo = url.searchParams.get('tipo') === 'cierre' ? 'cierre' : 'recordatorio';
        const correo = String(url.searchParams.get('correo') || '').toLowerCase();
        const ing = ctx.notificador.config().ingenieros.find(i => i.correo === correo);
        const m = ctx.notificador.vistaPrevia(tipo, ing);
        sendJson(res, 200, m ? { asunto: m.asunto, html: m.html } : { asunto: '', html: '<p style="color:#16a34a;font-family:Segoe UI,Arial">No hay nada pendiente para este correo en este momento: no se enviaría nada.</p>' });
        return true;
    }
    if (pathname === '/api/notificaciones/probar' && req.method === 'POST') {
        json(async p => {
            const correo = sesion && sesion.correo;
            if (!correo) throw new Error('Necesitas haber ingresado con tu correo corporativo.');
            const tipo = p.tipo === 'cierre' ? 'cierre' : 'recordatorio';
            const m = ctx.notificador.vistaPrevia(tipo, { nombre: nombreUsuario(sesion), correo, lineas: Array.isArray(p.lineas) && p.lineas.length ? p.lineas : ['Todas'] });
            if (!m) return sendJson(res, 200, { success: true, enviado: false, output: 'No hay pendientes que notificar en este momento, así que no se envió nada.' });
            await ctx.enviarNotificacion({ para: [correo], cc: [], asunto: '[PRUEBA] ' + m.asunto, html: m.html, motivo: 'prueba' });
            ctx.notificador.registrar('prueba', `Prueba de ${tipo} a ${correo}`);
            sendJson(res, 200, { success: true, enviado: true, output: ctx.via === 'powerautomate' ? `📨 Prueba en camino a ${correo}. Sale desde Outlook con Power Automate en 1 a 5 minutos.` : `✅ Prueba enviada a ${correo}.` });
        });
        return true;
    }

    // ------------------ Respaldo completo ------------------
    if (pathname === '/api/respaldo' && req.method === 'GET') {
        const contenido = {
            generado: new Date().toISOString(),
            acrs: ctx.leerACRs(),
            pendientesDiarios: ctx.leerDaily(),
            tecnicos: datosTecnicos(),
            turnos: datosTurnos(),
            notificaciones: (({ estado, ...resto }) => resto)(ctx.notificador.config())
        };
        res.writeHead(200, {
            'Content-Type': 'application/json; charset=utf-8',
            'Content-Disposition': `attachment; filename="respaldo_matriz_acr_${hoyISO()}.json"`,
            'Cache-Control': 'no-store'
        });
        res.end(JSON.stringify(contenido, null, 1));
        return true;
    }
    return false;
}

module.exports = { manejar, migrarPendientes, archivarPendientes, datosTecnicos, datosTurnos };
