// =====================================================================
// Almacenamiento permanente
// Si existe la variable MONGODB_URI, los datos se guardan en MongoDB Atlas
// y sobreviven a cualquier reinicio de Render. Los archivos de data/ se
// mantienen como copia de trabajo rápida.
// Sin MONGODB_URI (por ejemplo, ejecutando en local) solo se usan los archivos.
// =====================================================================
const URI = process.env.MONGODB_URI || '';
const DB_NAME = process.env.MONGODB_DB || 'acr_matriz';

let collection = null;
let client = null;
let estado = URI ? 'conectando' : 'no configurada';
let ultimoError = '';
const colas = new Map();   // una cola de escritura por documento, para guardar en orden

async function init(clientFactory) {
    if (!URI && !clientFactory) return false;
    try {
        if (clientFactory) {
            client = await clientFactory();
        } else {
            const { MongoClient } = require('mongodb');
            client = new MongoClient(URI, { serverSelectionTimeoutMS: 15000 });
            await client.connect();
        }
        collection = client.db(DB_NAME).collection('estado');
        estado = 'conectada';
        return true;
    } catch (e) {
        estado = 'error';
        ultimoError = e.message;
        console.error('❌ No se pudo conectar a la base de datos:', e.message);
        return false;
    }
}

async function load(nombre) {
    if (!collection) return null;
    const doc = await collection.findOne({ _id: nombre });
    return doc ? doc.data : null;
}

function save(nombre, data) {
    if (!collection) return Promise.resolve();
    const anterior = colas.get(nombre) || Promise.resolve();
    const siguiente = anterior.then(async () => {
        try {
            await collection.updateOne(
                { _id: nombre },
                { $set: { data, actualizado: new Date() } },
                { upsert: true }
            );
            if (estado !== 'conectada') { estado = 'conectada'; ultimoError = ''; }
        } catch (e) {
            estado = 'error';
            ultimoError = e.message;
            console.error(`❌ Error guardando "${nombre}" en la base de datos:`, e.message);
        }
    });
    colas.set(nombre, siguiente);
    return siguiente;
}

function status() {
    return { baseDatos: estado, error: ultimoError || undefined };
}

module.exports = { init, load, save, status };
