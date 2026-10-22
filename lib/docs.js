// Documentos guardados en MongoDB Atlas (si hay MONGODB_URI) con copia en data/*.json.
// Se cargan una vez al arrancar y quedan en memoria; cada cambio se guarda en ambos lados.
const fs = require('fs');
const path = require('path');
const storage = require('../storage');

const cache = new Map();
let dataDir = path.join(__dirname, '..', 'data');

function configurar(dir) { dataDir = dir; }

function archivo(nombre) { return path.join(dataDir, `${nombre}.json`); }

function leerArchivo(nombre) {
    try { return JSON.parse(fs.readFileSync(archivo(nombre), 'utf8')); } catch (e) { return null; }
}

async function cargar(nombre, porDefecto) {
    let valor = null;
    try { valor = await storage.load(nombre); } catch (e) { valor = null; }
    if (valor == null) valor = leerArchivo(nombre);
    if (valor == null) valor = typeof porDefecto === 'function' ? porDefecto() : JSON.parse(JSON.stringify(porDefecto));
    cache.set(nombre, valor);
    return valor;
}

function obtener(nombre, porDefecto) {
    if (!cache.has(nombre)) {
        const v = leerArchivo(nombre);
        cache.set(nombre, v == null ? (typeof porDefecto === 'function' ? porDefecto() : JSON.parse(JSON.stringify(porDefecto ?? null))) : v);
    }
    return cache.get(nombre);
}

function guardar(nombre, valor) {
    cache.set(nombre, valor);
    try {
        fs.mkdirSync(dataDir, { recursive: true });
        fs.writeFileSync(archivo(nombre), JSON.stringify(valor), 'utf8');
    } catch (e) { /* la copia local es solo de apoyo */ }
    return storage.save(nombre, valor);
}

// Para documentos que no se necesitan siempre (por ejemplo, el archivo histórico de un mes)
async function leerUnaVez(nombre) {
    if (cache.has(nombre)) return cache.get(nombre);
    let v = null;
    try { v = await storage.load(nombre); } catch (e) { v = null; }
    if (v == null) v = leerArchivo(nombre);
    if (v != null) cache.set(nombre, v);
    return v;
}

module.exports = { configurar, cargar, obtener, guardar, leerUnaVez };
