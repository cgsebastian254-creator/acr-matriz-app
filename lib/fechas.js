// Fechas en hora de Colombia (Bogotá), siempre como texto ISO "AAAA-MM-DD"
const DIAS = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

function ahoraBogota(d = new Date()) {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
        timeZone: 'America/Bogota', year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short'
    }).formatToParts(d).map(x => [x.type, x.value]));
    return {
        fecha: `${p.year}-${p.month}-${p.day}`,
        minutos: Number(p.hour) * 60 + Number(p.minute),
        diaSemana: DIAS[p.weekday]
    };
}

function hoyISO() { return ahoraBogota().fecha; }

function sumarDias(iso, n) {
    const d = new Date(iso + 'T12:00:00Z');
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
}

function lunesDe(iso) {
    const d = new Date(iso + 'T12:00:00Z');
    return sumarDias(iso, -((d.getUTCDay() + 6) % 7));
}

function esISO(v) { return !!fechaValida(String(v || '')); }

function fechaValida(iso) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return '';
    const d = new Date(iso + 'T12:00:00Z');
    return !isNaN(d) && d.toISOString().slice(0, 10) === iso ? iso : '';
}

// Convierte "22/10/2026", "2026-10-22", fechas de Excel (número) u objetos Date a "AAAA-MM-DD"
function aISO(v) { return fechaValida(aISOSinValidar(v)); }
function aISOSinValidar(v) {
    if (v == null || v === '') return '';
    if (v instanceof Date && !isNaN(v)) {
        return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`;
    }
    if (typeof v === 'number' && v > 20000 && v < 80000) {
        const d = new Date(Math.round((v - 25569) * 86400000));
        return d.toISOString().slice(0, 10);
    }
    const t = String(v).trim();
    let m = t.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
    m = t.match(/(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{2,4})/);
    if (m) {
        const anio = m[3].length === 2 ? '20' + m[3] : m[3];
        return `${anio}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
    }
    return '';
}

function textoFecha(iso) {
    if (!esISO(iso)) return iso || '';
    const [a, m, d] = iso.split('-');
    return `${d}/${m}/${a}`;
}

function minutosDe(hhmm) {
    const m = String(hhmm || '').match(/^(\d{1,2}):(\d{2})$/);
    return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

module.exports = { ahoraBogota, hoyISO, sumarDias, lunesDe, esISO, aISO, textoFecha, minutosDe };
