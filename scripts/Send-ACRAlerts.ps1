<#
    Send-ACRAlerts.ps1
    Envía UN correo consolidado (HTML) con las tareas de ACR vencidas y próximas a vencer,
    más los compromisos de reunión diaria pendientes. Usa el Outlook instalado en este PC.

    Lee los datos de ..\data\acrs.json y ..\data\daily_tasks.json
    (el agente de sincronización los mantiene al día con lo que hay en la web).

    Parámetros:
      -LiderAreaCc     Correo que va en copia (CC). Opcional.
      -ModoSimulacion  "true" = solo muestra el resumen, no envía.  "false" = envía el correo.
      -DiasProximos    Días hacia adelante para "próximas a vencer" (por defecto 7).
#>
param(
    [string]$LiderAreaCc = "",
    [string]$ModoSimulacion = "true",
    [int]$DiasProximos = 7
)

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}

$raiz = Split-Path -Parent $PSScriptRoot
$acrsPath = Join-Path (Join-Path $raiz 'data') 'acrs.json'
$dailyPath = Join-Path (Join-Path $raiz 'data') 'daily_tasks.json'

$acrs = @()
if (Test-Path $acrsPath) {
    $texto = Get-Content -Path $acrsPath -Raw -Encoding UTF8
    if ($texto -and $texto.Trim()) { $acrs = ConvertFrom-Json -InputObject $texto }
}
$daily = @()
if (Test-Path $dailyPath) {
    $texto = Get-Content -Path $dailyPath -Raw -Encoding UTF8
    if ($texto -and $texto.Trim()) { $daily = ConvertFrom-Json -InputObject $texto }
}

$cultura = [System.Globalization.CultureInfo]::InvariantCulture
$formatos = [string[]]@('dd/MM/yyyy', 'd/M/yyyy', 'yyyy-MM-dd', 'dd-MM-yyyy', 'd-M-yyyy', 'dd/MM/yy', 'd/M/yy')

function Convertir-Fecha([string]$texto) {
    if ([string]::IsNullOrWhiteSpace($texto)) { return $null }
    $t = $texto.Trim().Split(' ')[0].Split('T')[0]
    $d = [datetime]::MinValue
    if ([datetime]::TryParseExact($t, $formatos, $cultura, [System.Globalization.DateTimeStyles]::None, [ref]$d)) {
        return $d.Date
    }
    return $null
}

function Esc-Html([object]$valor) {
    return [System.Net.WebUtility]::HtmlEncode([string]$valor)
}

$hoy = (Get-Date).Date
$limite = $hoy.AddDays($DiasProximos)
$vencidas = New-Object System.Collections.Generic.List[object]
$proximas = New-Object System.Collections.Generic.List[object]

foreach ($acr in $acrs) {
    if ($null -eq $acr) { continue }
    foreach ($t in @($acr.tareas)) {
        if ($null -eq $t) { continue }
        if ($t.estado -eq 'Realizado') { continue }
        $fecha = Convertir-Fecha ([string]$t.fechaCompromiso)
        $dias = $null
        if ($fecha) { $dias = ($hoy - $fecha).Days }
        $fila = [pscustomobject]@{
            Linea       = [string]$acr.linea
            Equipo      = [string]$acr.equipo
            ACR         = [string]$acr.codigoACR
            Tarea       = [string]$t.descripcion
            Tipo        = [string]$t.tipo
            Responsable = [string]$t.responsable
            Fecha       = [string]$t.fechaCompromiso
            Estado      = [string]$t.estado
            Dias        = $dias
        }
        if ($t.estado -eq 'Vencido' -or ($fecha -and $fecha -lt $hoy)) {
            $vencidas.Add($fila)
        } elseif ($fecha -and $fecha -le $limite) {
            $proximas.Add($fila)
        }
    }
}

$compromisos = @($daily | Where-Object { $_ -and $_.estado -ne 'Realizado' })

# ------------------ HTML del correo ------------------
$estiloTh = 'background:#1e3a8a;color:#ffffff;padding:8px;border:1px solid #cbd5e1;font-size:12px;text-align:left;'
$estiloTd = 'padding:7px;border:1px solid #cbd5e1;font-size:12px;vertical-align:top;'

function Tabla-Tareas($filas, [string]$colorDias, [string]$textoDias) {
    if ($filas.Count -eq 0) { return '<p style="font-size:13px;color:#16a34a;">Sin tareas en esta categoría.</p>' }
    $html = "<table style='border-collapse:collapse;width:100%;font-family:Segoe UI,Arial,sans-serif;'><tr>"
    foreach ($c in @('Línea', 'Equipo', 'ACR', 'Tarea', 'Responsable', 'Fecha compromiso', 'Estado', $textoDias)) {
        $html += "<th style='$estiloTh'>$(Esc-Html $c)</th>"
    }
    $html += '</tr>'
    foreach ($f in $filas) {
        $diasTxt = ''
        if ($null -ne $f.Dias) { $diasTxt = [string][math]::Abs($f.Dias) }
        $html += "<tr><td style='$estiloTd'>$(Esc-Html $f.Linea)</td><td style='$estiloTd'>$(Esc-Html $f.Equipo)</td><td style='$estiloTd'>$(Esc-Html $f.ACR)</td>" +
                 "<td style='$estiloTd'>$(Esc-Html $f.Tarea)</td><td style='$estiloTd'>$(Esc-Html $f.Responsable)</td><td style='$estiloTd'>$(Esc-Html $f.Fecha)</td>" +
                 "<td style='$estiloTd'>$(Esc-Html $f.Estado)</td><td style='$estiloTd;color:$colorDias;font-weight:bold;'>$(Esc-Html $diasTxt)</td></tr>"
    }
    return $html + '</table>'
}

$vencidasOrdenadas = @($vencidas | Sort-Object -Property @{ Expression = { if ($null -eq $_.Dias) { -1 } else { $_.Dias } } } -Descending)
$proximasOrdenadas = @($proximas | Sort-Object -Property @{ Expression = { $_.Dias } } -Descending)

$htmlCompromisos = '<p style="font-size:13px;color:#16a34a;">Sin compromisos pendientes.</p>'
if ($compromisos.Count -gt 0) {
    $htmlCompromisos = "<table style='border-collapse:collapse;width:100%;font-family:Segoe UI,Arial,sans-serif;'><tr>"
    foreach ($c in @('Fecha', 'Línea', 'Equipo', 'Compromiso', 'Responsable', 'Prioridad', 'Estado')) {
        $htmlCompromisos += "<th style='$estiloTh'>$(Esc-Html $c)</th>"
    }
    $htmlCompromisos += '</tr>'
    foreach ($d in $compromisos) {
        $htmlCompromisos += "<tr><td style='$estiloTd'>$(Esc-Html $d.fecha)</td><td style='$estiloTd'>$(Esc-Html $d.linea)</td><td style='$estiloTd'>$(Esc-Html $d.equipo)</td>" +
                            "<td style='$estiloTd'>$(Esc-Html $d.compromiso)</td><td style='$estiloTd'>$(Esc-Html $d.responsable)</td><td style='$estiloTd'>$(Esc-Html $d.prioridad)</td><td style='$estiloTd'>$(Esc-Html $d.estado)</td></tr>"
    }
    $htmlCompromisos += '</table>'
}

$fechaHoy = $hoy.ToString('dd/MM/yyyy')
$asunto = "Alertas ACR Planta Conversión - $fechaHoy - $($vencidas.Count) vencidas, $($proximas.Count) próximas a vencer"

$html = @"
<html><body style="font-family:Segoe UI,Arial,sans-serif;color:#0f172a;">
<h2 style="color:#1e3a8a;margin-bottom:4px;">Matriz de ACRs - Planta Conversión</h2>
<p style="font-size:13px;margin-top:0;">Reporte consolidado generado el $fechaHoy.</p>
<table style="border-collapse:collapse;margin:12px 0;"><tr>
<td style="padding:10px 18px;background:#fee2e2;border-radius:6px;font-size:14px;"><b>$($vencidas.Count)</b> tareas vencidas</td>
<td style="width:10px;"></td>
<td style="padding:10px 18px;background:#fef3c7;border-radius:6px;font-size:14px;"><b>$($proximas.Count)</b> vencen en los próximos $DiasProximos días</td>
<td style="width:10px;"></td>
<td style="padding:10px 18px;background:#dbeafe;border-radius:6px;font-size:14px;"><b>$($compromisos.Count)</b> compromisos diarios pendientes</td>
</tr></table>
<h3 style="color:#b91c1c;">Tareas vencidas</h3>
$(Tabla-Tareas $vencidasOrdenadas '#b91c1c' 'Días de atraso')
<h3 style="color:#b45309;">Próximas a vencer</h3>
$(Tabla-Tareas $proximasOrdenadas '#b45309' 'Días restantes')
<h3 style="color:#1e3a8a;">Compromisos de reunión diaria pendientes</h3>
$htmlCompromisos
<p style="font-size:12px;color:#64748b;margin-top:18px;">Consulta y actualiza el estado en https://acr-matriz-app.onrender.com</p>
</body></html>
"@

# ------------------ Resumen en consola ------------------
Write-Output "Resumen al $fechaHoy"
Write-Output "  Vencidas: $($vencidas.Count)"
Write-Output "  Próximas a vencer ($DiasProximos días): $($proximas.Count)"
Write-Output "  Compromisos diarios pendientes: $($compromisos.Count)"
foreach ($f in ($vencidasOrdenadas | Select-Object -First 15)) {
    Write-Output "  [VENCIDA] $($f.Linea) | $($f.Tarea) | $($f.Responsable) | $($f.Fecha)"
}
if ($vencidas.Count -gt 15) { Write-Output "  ... y $($vencidas.Count - 15) más" }

if ($ModoSimulacion -ne 'false') {
    Write-Output ""
    $vistaPrevia = Join-Path (Join-Path $raiz 'data') 'vista_previa_alerta.html'
    [System.IO.File]::WriteAllText($vistaPrevia, $html, (New-Object System.Text.UTF8Encoding($true)))
    Write-Output "MODO SIMULACIÓN: no se envió ningún correo."
    Write-Output "Vista previa del correo guardada en este PC: $vistaPrevia"
    Write-Output "Asunto que se usaría: $asunto"
    if ($LiderAreaCc) { Write-Output "CC: $LiderAreaCc" }
    exit 0
}

# ------------------ Envío con Outlook ------------------
try {
    $outlook = New-Object -ComObject Outlook.Application
} catch {
    Write-Error "No se pudo abrir Outlook en este PC. Verifica que Outlook esté instalado y con tu cuenta configurada."
    exit 1
}

$destinatario = ''
try { $destinatario = $outlook.Session.CurrentUser.AddressEntry.GetExchangeUser().PrimarySmtpAddress } catch {}
if ([string]::IsNullOrWhiteSpace($destinatario)) {
    try { $destinatario = $outlook.Session.CurrentUser.Address } catch {}
}
if ([string]::IsNullOrWhiteSpace($destinatario)) {
    Write-Error "No se pudo identificar tu correo en Outlook."
    exit 1
}

$correo = $outlook.CreateItem(0)
$correo.To = $destinatario
if ($LiderAreaCc) { $correo.CC = $LiderAreaCc }
$correo.Subject = $asunto
$correo.HTMLBody = $html
$correo.Send()

Write-Output ""
Write-Output "CORREO ENVIADO a $destinatario$(if ($LiderAreaCc) { " (CC: $LiderAreaCc)" })"
Write-Output "Asunto: $asunto"
