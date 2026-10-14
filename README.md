# acr-matriz-app

Matriz web en tiempo real de ACRs y compromisos diarios (DDS) para la planta Conversión.

## Cómo funciona

- **App pública (Render):** `server.js` sirve la interfaz y la API. En la nube no tiene acceso a SharePoint; recibe los ACRs por `POST /api/acrs/push`.
- **Agente de sincronización (PC corporativo):** `sync-agent.js` lee los Excel de ACR desde la carpeta de SharePoint sincronizada con OneDrive (con `excelScanner.js`) y los envía a Render cada 5 minutos.
- Los cambios de estado hechos en la web se conservan al llegar una nueva sincronización.
- **Respaldo:** cada 30 s el agente guarda en el PC corporativo (`data/`) todo lo cambiado en la web. Si Render se reinicia y pierde datos, el agente los restaura solo.
- **Correo de alertas:** el botón de la web deja la solicitud en cola; el agente la toma y la envía con el Outlook del PC corporativo (`scripts/Send-ACRAlerts.ps1`). La copia (CC) solo se permite a correos corporativos (variable `ALERT_ALLOWED_DOMAINS`, por defecto `kcc.com,kimberly-clark.com`).

## Configuración

### Render
1. Environment → agregar `SYNC_TOKEN` con una clave secreta.
2. Build command: `npm install` · Start command: `npm start`.

### PC corporativo
1. Sincronizar la carpeta "ACRs 2026" de SharePoint con OneDrive.
2. Crear `iniciar-sincronizacion.bat` (no se sube a GitHub) con la misma `SYNC_TOKEN`.
3. Ejecutar `npm install` una vez y luego abrir el `.bat`.

### Ejecución local
```
npm install
npm start
```
Abrir http://localhost:3000

### Arranque automático del agente
Para que el agente arranque solo al prender el PC: `Win + R` → `shell:startup` → crear ahí un acceso directo a `iniciar-sincronizacion.bat`.

## Limitaciones
- El agente debe estar abierto en el PC corporativo para traer Excel nuevos, respaldar cambios y enviar correos.
- En el plan gratis de Render el disco no es permanente. Si Render se reinicia mientras el agente está apagado, los cambios hechos en ese intervalo y no respaldados se pierden. Para eliminar este riesgo, usar una base de datos (por ejemplo Supabase o MongoDB Atlas, gratis).

## Actualización automática por correo (sin Power Automate Premium)

Power Automate (conectores estándar) envía cada Excel de ACR como adjunto a un buzón dedicado; la app lo revisa por IMAP.

Variables en Render: `IMAP_USER`, `IMAP_PASS` (contraseña de aplicación de Gmail), opcionales `IMAP_HOST` (imap.gmail.com), `MAIL_TOKEN` (por defecto `SYNC_TOKEN`), `MAIL_ALLOWED_DOMAINS` (kcc.com,kimberly-clark.com,arbex.com), `MAIL_INTERVAL_SEC` (60).

Asuntos que envía el flujo:
- `ACR-SYNC <clave> | <ruta de la carpeta>` con el Excel adjunto: crea o actualiza el ACR.
- `ACR-DELETE <clave> | <nombre del archivo>`: quita el ACR.

Si Render está dormido, los correos esperan en el buzón y se procesan apenas alguien abre la app.
