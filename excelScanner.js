const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');

// Auto-detect candidate directories (SharePoint synced, OneDrive, Network share S:\, or local)
const CANDIDATE_DIRS = [
    path.join(process.env.USERPROFILE || '', 'Kimberly-Clark', 'Mantenimiento y Proyectos Cauca - General', 'ACRs 2026'),
    path.join(process.env.USERPROFILE || '', 'Kimberly-Clark', 'Mantenimiento y Proyectos Cauca - Documentos', 'General', 'ACRs 2026'),
    path.join(process.env.USERPROFILE || '', 'Kimberly-Clark', 'B636 - Documentos', 'General', 'ACRs 2026'),
    path.join(process.env.USERPROFILE || '', 'OneDrive - Kimberly-Clark', 'ACRs 2026'),
    "S:\\OP_01_Produccion_Conversion1\\03_Mejora_Continua\\14_IG_Solución_Problemas_Kaizen_N2\\12_IG_Solución_Problemas_Tiempo_Real\\ACRs 2026 Conversiones",
    path.join(__dirname, 'data', 'excels')
];

function getActiveScanDir() {
    for (const dir of CANDIDATE_DIRS) {
        if (dir && fs.existsSync(dir)) {
            return dir;
        }
    }
    return CANDIDATE_DIRS[CANDIDATE_DIRS.length - 1]; // fallback local
}

const TARGET_DIR = getActiveScanDir();
const LOCAL_DATA_FILE = path.join(__dirname, 'data', 'acrs.json');

function scanDirectoryForExcelFiles(dirPath) {
    let results = [];
    if (!fs.existsSync(dirPath)) return results;

    const list = fs.readdirSync(dirPath);
    for (const file of list) {
        const fullPath = path.join(dirPath, file);
        const stat = fs.statSync(fullPath);

        if (stat && stat.isDirectory()) {
            if (['node_modules', 'public', 'scratch', 'bin', '.git'].includes(file)) continue;
            results = results.concat(scanDirectoryForExcelFiles(fullPath));
        } else {
            const ext = path.extname(file).toLowerCase();
            if ((ext === '.xlsx' || ext === '.xls' || ext === '.xlsm') && !file.startsWith('~$')) {
                results.push(fullPath);
            }
        }
    }
    return results;
}

function formatDateValue(val) {
    if (!val) return '';
    if (val instanceof Date) {
        const d = String(val.getDate()).padStart(2, '0');
        const m = String(val.getMonth() + 1).padStart(2, '0');
        const y = val.getFullYear();
        return `${d}/${m}/${y}`;
    }
    const str = String(val).trim();
    if (str.includes('GMT') || str.includes('T')) {
        const dt = new Date(str);
        if (!isNaN(dt.getTime())) {
            const d = String(dt.getDate()).padStart(2, '0');
            const m = String(dt.getMonth() + 1).padStart(2, '0');
            const y = dt.getFullYear();
            return `${d}/${m}/${y}`;
        }
    }
    return str;
}

function parseSingleACRExcel(filePath, index) {
    try {
        const workbook = XLSX.readFile(filePath, { cellDates: true, cellText: true });
        const sheetName = workbook.SheetNames[0];
        const sheet = workbook.Sheets[sheetName];
        
        const grid = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
        const fileName = path.basename(filePath, path.extname(filePath));
        const parentFolder = path.basename(path.dirname(filePath));

        // LINEA is strict folder name (FORTE, FUTURA, SINCRO 1, SINCRO 2, HINNLI, POCKET)
        let linea = parentFolder !== 'ACRs 2026 Conversiones' ? parentFolder : 'Conversión 1';
        let equipo = 'Equipo General';
        let fecha = new Date().toISOString().split('T')[0];
        let responsableAcr = 'No Hay Responsable';
        let causaRaiz = 'Sin causa raíz especificada en el formato';

        // Header Extraction
        for (let r = 0; r < Math.min(grid.length, 45); r++) {
            const row = grid[r] || [];
            for (let c = 0; c < row.length; c++) {
                const val = String(row[c] || '').trim();

                if (val.toUpperCase().includes('MÁQUINA:') || val.toUpperCase().includes('MAQUINA:')) {
                    let parsed = val.replace(/MÁQUINA:|MAQUINA:/gi, '').trim();
                    if (!parsed && row[c + 1]) parsed = String(row[c + 1]).trim();
                    if (parsed) equipo = parsed;
                }

                if (val.toUpperCase().includes('FECHA:')) {
                    let parsed = val.replace(/FECHA:/gi, '').trim();
                    if (!parsed && row[c + 1]) parsed = String(row[c + 1]).trim();
                    if (parsed) fecha = formatDateValue(parsed);
                }

                if (val.toUpperCase().includes('RESPONSABLE:')) {
                    let parsed = val.replace(/RESPONSABLE:/gi, '').trim();
                    if (!parsed && row[c + 1]) parsed = String(row[c + 1]).trim();
                    if (parsed) responsableAcr = parsed;
                }

                if (val.includes('6. Causa Raíz') || val.includes('6. Causa Raiz')) {
                    if (grid[r + 1] && grid[r + 1][c] && String(grid[r + 1][c]).length > 10) {
                        causaRaiz = String(grid[r + 1][c]).trim();
                    } else if (row[c + 1] && String(row[c + 1]).length > 10) {
                        causaRaiz = String(row[c + 1]).trim();
                    }
                }
            }
        }

        // Clean up multi-line Responsable
        if (responsableAcr) {
            responsableAcr = responsableAcr.replace(/\r?\n|\r/g, ' / ').trim();
        }
        if (!responsableAcr || responsableAcr.trim() === '') {
            responsableAcr = 'No Hay Responsable';
        }

        // Parse Action Rows starting around row 45
        let tareas = [];
        let tIndex = 1;

        let inmedHeaderCol = 0;
        let prevHeaderCol = 6;
        let foundActionSection = false;

        for (let r = 35; r < grid.length; r++) {
            const row = grid[r] || [];
            const rowStr = row.join(' ');
            if (rowStr.includes('Acciones Inmediatas') || rowStr.includes('Acciones Preventivas')) {
                foundActionSection = true;

                // Determine column split between Inmediatas & Preventivas
                for (let c = 0; c < row.length; c++) {
                    const cVal = String(row[c] || '');
                    if (cVal.includes('Acciones Inmediatas')) inmedHeaderCol = c;
                    if (cVal.includes('Acciones Preventivas')) prevHeaderCol = c;
                }

                // Process rows below header
                for (let ar = r + 1; ar < Math.min(r + 30, grid.length); ar++) {
                    const aRow = grid[ar] || [];
                    if (aRow.every(v => v === '')) continue;

                    // Acciones Inmediatas (left side cols: inmedHeaderCol to prevHeaderCol - 1)
                    const inmedDesc = String(aRow[inmedHeaderCol] || '').trim();
                    let inmedDate = formatDateValue(aRow[inmedHeaderCol + 1] || aRow[inmedHeaderCol + 4] || '');
                    let inmedResp = String(aRow[inmedHeaderCol + 2] || aRow[inmedHeaderCol + 5] || '').trim();

                    if (inmedDesc && !inmedDesc.includes('Acciones Inmediatas') && inmedDesc.length > 3) {
                        if (!inmedResp || inmedResp.trim() === '') inmedResp = 'No Hay Responsable';
                        inmedResp = inmedResp.replace(/\r?\n|\r/g, ' / ').trim();

                        tareas.push({
                            idTarea: `T-${String(tIndex++).padStart(2, '0')}`,
                            descripcion: inmedDesc,
                            tipo: 'Accion Inmediata',
                            tipoBadge: '⚡ Accion Inmediata',
                            responsable: inmedResp,
                            fechaCompromiso: inmedDate || fecha,
                            estado: 'Pendiente',
                            observaciones: 'Acción inmediata del formato ACR',
                            historial: [
                                {
                                    fecha: new Date().toLocaleString('es-ES'),
                                    usuario: 'Sistema Auto-Sync Excel',
                                    responsableTarea: inmedResp,
                                    accion: 'Extraído automáticamente desde formato Excel de red'
                                }
                            ]
                        });
                    }

                    // Acciones Preventivas (right side cols: prevHeaderCol onwards)
                    const prevDesc = String(aRow[prevHeaderCol] || aRow[prevHeaderCol + 1] || '').trim();
                    let prevDate = formatDateValue(aRow[prevHeaderCol + 1] || aRow[prevHeaderCol + 4] || '');
                    let prevResp = String(aRow[prevHeaderCol + 2] || aRow[prevHeaderCol + 5] || '').trim();

                    if (prevDesc && !prevDesc.includes('Acciones Preventivas') && prevDesc.length > 3) {
                        if (!prevResp || prevResp.trim() === '') prevResp = 'No Hay Responsable';
                        prevResp = prevResp.replace(/\r?\n|\r/g, ' / ').trim();

                        tareas.push({
                            idTarea: `T-${String(tIndex++).padStart(2, '0')}`,
                            descripcion: prevDesc,
                            tipo: 'Accion Preventiva',
                            tipoBadge: '🛡️ Accion Preventiva',
                            responsable: prevResp,
                            fechaCompromiso: prevDate || fecha,
                            estado: 'Pendiente',
                            observaciones: 'Acción preventiva del formato ACR',
                            historial: [
                                {
                                    fecha: new Date().toLocaleString('es-ES'),
                                    usuario: 'Sistema Auto-Sync Excel',
                                    responsableTarea: prevResp,
                                    accion: 'Extraído automáticamente desde formato Excel de red'
                                }
                            ]
                        });
                    }
                }
                break;
            }
        }

        const acrId = `ACR-2026-${String(index).padStart(3, '0')}`;

        return {
            id: acrId,
            codigoACR: fileName,
            linea: linea,
            equipo: equipo,
            falla: fileName,
            causaRaiz: causaRaiz,
            responsableAcr: responsableAcr,
            archivoOrigen: fileName + path.extname(filePath),
            rutaCompleta: filePath,
            tareas: tareas
        };
    } catch (e) {
        console.error(`Error parsing Excel file ${filePath}:`, e.message);
        return null;
    }
}

function syncAllExcelFiles() {
    console.log(`🔍 Escaneando directorio de Excel en red: ${TARGET_DIR}`);
    const excelFiles = scanDirectoryForExcelFiles(TARGET_DIR);
    console.log(`📁 Encontrados ${excelFiles.length} archivos Excel de ACR.`);

    let parsedACRs = [];
    let count = 1;

    for (const filePath of excelFiles) {
        const acrObj = parseSingleACRExcel(filePath, count++);
        if (acrObj) {
            parsedACRs.push(acrObj);
        }
    }

    if (parsedACRs.length > 0) {
        let existingACRs = [];
        if (fs.existsSync(LOCAL_DATA_FILE)) {
            try {
                existingACRs = JSON.parse(fs.readFileSync(LOCAL_DATA_FILE, 'utf8'));
            } catch (e) {}
        }

        // Merge status & observations if task description matches
        for (const newAcr of parsedACRs) {
            const matchOldAcr = existingACRs.find(a => a.falla === newAcr.falla || a.archivoOrigen === newAcr.archivoOrigen);
            if (matchOldAcr) {
                for (const newT of newAcr.tareas) {
                    const matchOldT = matchOldAcr.tareas.find(ot => ot.descripcion === newT.descripcion);
                    if (matchOldT) {
                        newT.estado = matchOldT.estado;
                        newT.observaciones = matchOldT.observaciones;
                        if (matchOldT.historial) newT.historial = matchOldT.historial;
                    }
                }
            }
        }

        fs.mkdirSync(path.dirname(LOCAL_DATA_FILE), { recursive: true });
        fs.writeFileSync(LOCAL_DATA_FILE, JSON.stringify(parsedACRs, null, 2), 'utf8');
        console.log(`✅ Base de datos acrs.json actualizada con ${parsedACRs.length} ACRs de Excel.`);
    }

    return parsedACRs;
}

module.exports = {
    syncAllExcelFiles,
    parseSingleACRExcel,
    TARGET_DIR
};
