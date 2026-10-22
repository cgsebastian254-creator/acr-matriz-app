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

## Ingreso con correo corporativo

Con `LOGIN_MODE=correo` la app pide el correo de la empresa y envía un código de 6 dígitos (desde la cuenta `IMAP_USER`/`IMAP_PASS` por SMTP de Gmail). La sesión dura `SESSION_DAYS` (30) días.
- `LOGIN_DOMAINS`: dominios permitidos (por defecto kcc.com,kimberly-clark.com,arbex.com).
- `LOGIN_EMAILS`: opcional, lista exacta de correos autorizados (si se define, solo ellos entran).
- El historial de cambios guarda el correo de quien hizo cada cambio.

## Correo de alertas (desde la app)

El reporte (vencidas, próximas a vencer y compromisos diarios) sale desde la cuenta de la app (`IMAP_USER`/`IMAP_PASS`, SMTP de Gmail). Solo a correos de `LOGIN_DOMAINS`.
- Envío manual: pestaña "Correo de alertas".
- Envío automático: `ALERTAS_AUTO_HORA` (HH:MM, hora Colombia), `ALERTAS_AUTO_DIAS` (1=lunes … 7=domingo, por defecto 1,2,3,4,5), `ALERTAS_DESTINATARIOS`, `ALERTAS_CC`. Si el servidor estaba dormido, sale apenas despierte ese día.
- `/healthz` responde sin sesión: sirve para un monitor externo que mantenga despierta la app.

`LOGIN_MODE` ahora es `correo` por defecto cuando hay cuenta de envío configurada (usa `LOGIN_MODE=clave` para volver a la contraseña única).

## Envío de correos (Brevo)

El plan gratis de Render bloquea el SMTP, así que los correos (códigos de ingreso y alertas) salen por la API HTTPS de Brevo:
- `BREVO_API_KEY`: clave de API de Brevo (gratis, 300 correos/día).
- `MAIL_FROM`: remitente verificado en Brevo (por defecto `IMAP_USER`).
Sin `BREVO_API_KEY` se intenta SMTP (`SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`), que solo sirve fuera de Render.

## Ingreso enviando un correo (predeterminado)

Como los filtros de la empresa pueden retener correos externos, el ingreso por defecto (`LOGIN_METODO=enviar`) funciona al revés: la persona envía desde su correo corporativo un mensaje con asunto `ACR-LOGIN 123456` al buzón de la app (`IMAP_USER`). La app lo lee y abre la sesión solo si Gmail verificó que el correo viene de ese dominio (DMARC o DKIM aprobados). `LOGIN_METODO=codigo` vuelve al código enviado por correo.

## Correos de alerta por Power Automate (predeterminado)

Los filtros de la empresa retienen los correos externos, así que las alertas salen desde Outlook corporativo con Power Automate, leyendo la app con el conector RSS (estándar):
- `/feeds/envios.xml?token=<SYNC_TOKEN>`: un ítem por cada "Enviar correo ahora" (título = asunto, resumen = HTML, categorías = destinatarios). Flujo: desencadenador RSS "Cuando se publica un elemento de fuente" → Outlook "Enviar un correo electrónico (V2)".
- `/feeds/alertas.xml?token=<SYNC_TOKEN>&para=correo1,correo2`: reporte del día para un flujo programado (Periodicidad → RSS "Enumerar todos los elementos de fuente RSS" → Outlook).
- `FEED_TOKEN` opcional (por defecto `SYNC_TOKEN`); `ALERTAS_VIA=brevo` vuelve al envío directo.

## Técnicos, matriz de polivalencia y turnos
- **Inicio**: además del panel de ACR, muestra quién está en turno el día elegido (y quién está trabajando en este momento) y un buscador rápido de técnicos.
- **Técnicos y Turnos**:
  - *Buscar técnico*: escribe lo que necesitas ("cambiar un rodillo", "eléctrico", "rodamientos") y ordena a los técnicos por especialidades y nivel en la matriz; se puede filtrar por quienes laboran hoy o están en turno ahora.
  - *Perfiles*: datos, especialidades (lo que encuentra el buscador), notas, matriz del semestre y turnos de la semana. Se pueden importar desde el Excel de la matriz de competencias (hojas `DimTecnico`, `DimHabilidad`, `DimPeriodo`, `FactEvaluacion`).
  - *Matriz de polivalencia*: escala 1–4, puntaje ponderado = Σ (nivel ÷ 4) × peso; las evaluaciones se guardan por semestre para ver la variación.
  - *Programación de turnos*: cuadrícula semanal (se guarda al instante), copiar la semana anterior, plantilla Excel para cargar la semana y tipos de turno editables.

## Reunión diaria
- Cada pendiente tiene **fecha de compromiso** y **máquina**. La vista del día muestra los del día y los atrasados que siguen abiertos (marcados "No realizado").
- **Eliminar** pide un motivo y deja el pendiente en el historial (se puede restaurar).
- **Historial por máquina y fecha**: rango de fechas, filtros por máquina, línea y estado, resumen por máquina y exportación a CSV.
- Abajo se listan las **acciones inmediatas de ACR** abiertas.
- Los pendientes cerrados hace más de 60 días pasan a un archivo mensual en la base de datos (`daily_archivo_AAAA-MM`) y siguen apareciendo en el historial.

## Notificaciones automáticas (pestaña Notificaciones)
- **Recordatorio diario** (6:30 a. m., lunes a sábado por defecto) a cada ingeniero con lo de sus líneas: pendientes no realizados, pendientes del día, acciones de ACR vencidas y las que vencen en N días.
- **Aviso de pendiente no realizado** (6:00 p. m. por defecto): una sola vez por pendiente.
- Los correos salen por el mismo flujo de Power Automate de `/feeds/envios.xml` (no hace falta otro flujo). El flujo, al revisar la app cada pocos minutos, también la mantiene despierta en Render.
- Respaldo completo de todos los datos en JSON: botón en Notificaciones (`/api/respaldo`).
