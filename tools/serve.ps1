# =============================================================
#  Local Image Studio launcher  (stable-diffusion.cpp sd-server)
#  Usage:
#     serve.cmd                 -> Z-Image Turbo (default, best quality)
#     serve.cmd sd15            -> SD 1.5 (fast, 512px)
#     serve.cmd z 1234          -> Z-Image on a custom port
#  ASCII only on purpose: PowerShell 5.1 reads scripts as ANSI.
# =============================================================
param(
    [string]$Model = "z",
    [int]$Port = 1234
)

$ErrorActionPreference = "Stop"
# ---- path layout -------------------------------------------------------
#   <root>\tools\serve.ps1      <- this script
#   <root>\app\runtime\         <- sd-server.exe + its dlls (must sit together)
#   <root>\app\models\          <- gguf / safetensors
#   <root>\app\ui\index.html    <- the single-file UI
#   <root>\config-service\      <- serve-config.mjs (Node)
# Everything is derived from this script's own location, so the whole
# project can be moved or renamed without editing any path.
$ToolsDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Base     = Split-Path -Parent $ToolsDir
$AppDir   = Join-Path $Base "app"
$RunDir   = Join-Path $AppDir "runtime"
$ModelDir = Join-Path $AppDir "models"
Set-Location $RunDir

$Exe = Join-Path $RunDir "sd-server.exe"
if (-not (Test-Path $Exe)) { Write-Host "[ERROR] sd-server.exe not found in $RunDir"; exit 1 }

# ---- stop anything already listening on the port ----
$old = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if ($old) {
    Write-Host "[..] Port $Port is busy (PID $($old.OwningProcess -join ',')). Stopping it..."
    $old.OwningProcess | Select-Object -Unique | ForEach-Object {
        try { Stop-Process -Id $_ -Force -ErrorAction Stop; Write-Host "     killed PID $_" } catch {}
    }
    Start-Sleep -Seconds 2
}
Get-Process sd-server -ErrorAction SilentlyContinue | ForEach-Object {
    try { Stop-Process -Id $_.Id -Force; Write-Host "     killed leftover sd-server PID $($_.Id)" } catch {}
}
Start-Sleep -Milliseconds 500

# ---- model selection ----
$D = Join-Path $ModelDir "zimage"
switch ($Model.ToLower()) {
    "sd15" {
        $Args = @(
            "-m", (Join-Path $ModelDir "sd15.safetensors"),
            "--vae-tiling"
        )
        $Label = "SD 1.5"
        $Hint  = "512x512 / 20 steps / CFG 7.0"
    }
    default {
        $Args = @(
            "--diffusion-model", (Join-Path $D "z_image_turbo-Q4_K.gguf"),
            "--vae",             (Join-Path $D "ae.safetensors"),
            "--llm",             (Join-Path $D "qwen3-4b-Q4_K_M.gguf"),
            "--offload-to-cpu",
            "--diffusion-fa"
        )
        $Label = "Z-Image Turbo"
        $Hint  = "768x768 / 8 steps / CFG 1.0"
    }
}

$Html = Join-Path $AppDir "ui\index.html"
if (-not (Test-Path $Html)) { Write-Host "[ERROR] app\ui\index.html not found"; exit 1 }

$Full = @() + $Args + @(
    "--listen-ip", "127.0.0.1",
    "--listen-port", "$Port",
    "--serve-html-path", $Html
)

# ---- config service (batch-generation settings persistence) ----
# sd-server has no file read/write route and no static-dir option, so the
# batch module's config.json needs a second process. Optional: if node or the
# script is missing, the UI still works and only warns in the batch tab.
$CfgScript = Join-Path $Base "config-service\serve-config.mjs"
$CfgPort = 1235
$CfgProc = $null
$NodeExe = (Get-Command node -ErrorAction SilentlyContinue).Source
if ((Test-Path $CfgScript) -and $NodeExe) {
    $busy = Get-NetTCPConnection -LocalPort $CfgPort -State Listen -ErrorAction SilentlyContinue
    if ($busy) {
        Write-Host "[..] Config port $CfgPort busy (PID $($busy.OwningProcess -join ',')). Stopping it..."
        $busy.OwningProcess | Select-Object -Unique | ForEach-Object {
            try { Stop-Process -Id $_ -Force -ErrorAction Stop; Write-Host "     killed PID $_" } catch {}
        }
        Start-Sleep -Seconds 1
    }

    # "Open in Explorer" needs no whitelist now: the service is localhost-only
    # and rejects cross-site requests instead of restricting paths, so any
    # existing folder can be opened without extra startup arguments.
    try {
        $CfgProc = Start-Process $NodeExe -ArgumentList @($CfgScript, "$CfgPort") -PassThru -WindowStyle Hidden
        $CfgLabel = "http://127.0.0.1:$CfgPort"
    } catch {
        $CfgProc = $null
        $CfgLabel = "(failed to start)"
    }
} else {
    $CfgLabel = "(node or serve-config.mjs missing - settings will not persist)"
}

Write-Host ""
Write-Host "=============================================="
Write-Host "  Local Image Studio"
Write-Host "  Model : $Label   ($Hint)"
Write-Host "  URL   : http://127.0.0.1:$Port"
Write-Host "  Config: $CfgLabel"
Write-Host "  Close this window or press Ctrl+C to stop."
Write-Host "=============================================="
Write-Host ""

# ---- open the browser once the port answers ----
$job = Start-Job -ScriptBlock {
    param($p)
    for ($i = 0; $i -lt 180; $i++) {
        Start-Sleep -Milliseconds 1000
        try {
            $c = New-Object Net.Sockets.TcpClient
            $c.Connect("127.0.0.1", $p); $c.Close()
            Start-Process "http://127.0.0.1:$p"
            return
        } catch {}
    }
} -ArgumentList $Port

try {
    & $Exe @Full
} finally {
    if ($CfgProc -and -not $CfgProc.HasExited) {
        try { Stop-Process -Id $CfgProc.Id -Force; Write-Host "     stopped config service PID $($CfgProc.Id)" } catch {}
    }
    Stop-Job $job -ErrorAction SilentlyContinue
    Remove-Job $job -Force -ErrorAction SilentlyContinue
}
