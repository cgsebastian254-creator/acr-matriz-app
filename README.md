# acr-matriz-app

Matriz web en tiempo real de ACRs y compromisos diarios (DDS) para la planta Conversión.

## Cómo funciona

- **App pública (Render):** `server.js` sirve la interfaz y la API. En la nube no tiene acceso a SharePoint; recibe los ACRs por `POST /api/acrs/push`.
- **Agente de sincronización (PC corporativo):** `sync-agent.js` lee los Excel de ACR desde la carpeta de SharePoint sincronizada con OneDrive (con `excelScanner.js`) y los envía a Render cada 5 minutos.
- Los cambios de estado hechos en la web se conservan al llegar una nueva sincronización.

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

## Limitación
En el plan gratis de Render el disco no es permanente: si el servicio se reinicia, se pierden los compromisos diarios creados en la web. Los ACRs se recuperan en la siguiente sincronización.
