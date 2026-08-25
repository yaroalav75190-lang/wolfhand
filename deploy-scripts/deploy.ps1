# Деплой «Рука волка» на VPS с Windows.
# Использует встроенный OpenSSH (есть в Windows 10/11 из коробки).
#
# Запуск:
#   ./deploy-scripts/deploy.ps1 -ServerIp <IP сервера> -SshUser root -Domain wolf.example.ru
#   ./deploy-scripts/deploy.ps1 -ServerIp <IP сервера> -SshUser root -SkipInstall
#
# Что делает:
#   - Первый запуск: копирует install.sh на сервер и запускает (ставит Node/nginx/certbot)
#   - Каждый запуск: rsync файлов проекта в /opt/wolfhand, npm install, restart wolfhand.service

[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)] [string]$ServerIp,
    [Parameter(Mandatory=$true)] [string]$SshUser,
    [string]$SshKey,
    [string]$RemoteDir = "/opt/wolfhand",
    [string]$RemoteUser = "wolfhand",
    [string]$Domain,
    [switch]$SkipInstall,
    [switch]$DryRun
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot

Write-Host "→ Проект: $projectRoot" -ForegroundColor Cyan
Write-Host "→ Сервер: $SshUser@$ServerIp -> $RemoteDir" -ForegroundColor Cyan

# Команда SSH (опционально с ключом)
$sshArgs = @("-o", "StrictHostKeyChecking=no", "-o", "ServerAliveInterval=30")
if ($SshKey) { $sshArgs += @("-i", $SshKey) }

function Invoke-Ssh {
    param([string]$Command)
    $allArgs = $sshArgs + @("$SshUser@$ServerIp", $Command)
    Write-Host "  ssh $($allArgs -join ' ')" -ForegroundColor DarkGray
    if (-not $DryRun) {
        & ssh @allArgs
        if ($LASTEXITCODE -ne 0) { throw "SSH command failed: $Command" }
    }
}

function Invoke-Scp {
    param([string]$Source, [string]$Dest)
    $allArgs = $sshArgs + @($Source, "${SshUser}@${ServerIp}:${Dest}")
    Write-Host "  scp $($allArgs -join ' ')" -ForegroundColor DarkGray
    if (-not $DryRun) {
        & scp @allArgs
        if ($LASTEXITCODE -ne 0) { throw "SCP failed: $Source → $Dest" }
    }
}

# ============ Шаг 1: первичная установка (если нужна) ============
if (-not $SkipInstall) {
    Write-Host "`n→ [1/4] Копирую install.sh и запускаю первичную установку..." -ForegroundColor Yellow
    $installSh = Join-Path $projectRoot "deploy-scripts/install.sh"
    Invoke-Scp $installSh "/root/wolfhand-install.sh"
    Write-Host "  Сейчас будет запрошен домен (или Enter для IP-доступа без HTTPS)..."
    Invoke-Ssh "bash /root/wolfhand-install.sh"
} else {
    Write-Host "`n→ [1/4] Пропускаю установку (-SkipInstall)" -ForegroundColor Yellow
}

# ============ Шаг 2: создание архива и загрузка ============
Write-Host "`n→ [2/4] Пакую проект (без node_modules)..." -ForegroundColor Yellow
$tmpDir = Join-Path $env:TEMP "wolfhand-deploy-$(Get-Random)"
New-Item -ItemType Directory -Path $tmpDir -Force | Out-Null

# Список файлов и папок для деплоя.
# ВАЖНО: admin/ — служебные страницы (staff.html, marketer.html, partner.html, print.html).
# Без неё /admin/* возвращает 404. package-lock.json нужен для воспроизводимой сборки better-sqlite3.
$include = @(
    "index.html",
    "server.js",
    "package.json",
    "package-lock.json",
    "api",
    "admin",
    "docs",
    "img",
    "tools"
)
$archive = Join-Path $tmpDir "wolfhand-deploy.tar.gz"

# Создаём tar.gz через tar (встроен в Windows 10 1803+)
Push-Location $projectRoot
try {
    $tarArgs = @("-czf", $archive)
    foreach ($item in $include) {
        if (Test-Path $item) { $tarArgs += $item }
    }
    & tar @tarArgs
    if ($LASTEXITCODE -ne 0) { throw "tar failed" }
} finally {
    Pop-Location
}

$size = (Get-Item $archive).Length / 1KB
Write-Host "  Архив: $archive ($([math]::Round($size, 1)) KB)"

Write-Host "`n→ [3/4] Загружаю на сервер..." -ForegroundColor Yellow
Invoke-Scp $archive "/tmp/wolfhand-deploy.tar.gz"

# ============ Шаг 4: распаковка, npm install, restart ============
Write-Host "`n→ [4/4] Распаковка, npm install, restart..." -ForegroundColor Yellow
$remoteCmd = @"
set -euo pipefail
sudo mkdir -p $RemoteDir
sudo tar -xzf /tmp/wolfhand-deploy.tar.gz -C $RemoteDir
sudo chown -R ${RemoteUser}:${RemoteUser} $RemoteDir
cd $RemoteDir
sudo -u $RemoteUser npm install --omit=dev --silent
sudo systemctl restart wolfhand || sudo systemctl start wolfhand
sleep 2
sudo systemctl status wolfhand --no-pager -l | head -20
sudo journalctl -u wolfhand --no-pager -n 20
rm /tmp/wolfhand-deploy.tar.gz
"@
Invoke-Ssh $remoteCmd

# Cleanup
Remove-Item -Recurse -Force $tmpDir -ErrorAction SilentlyContinue

Write-Host "`n✅ Деплой завершён." -ForegroundColor Green
Write-Host ""
Write-Host "Проверка:" -ForegroundColor Cyan
if ($Domain) {
    Write-Host "  https://$Domain/?demo=1                       # клиентская игра (демо)"
    Write-Host "  https://$Domain/admin/                        # вход для персонала"
    Write-Host "  ls /opt/wolfhand/admin/ на сервере             # должно быть 4 html"
} else {
    Write-Host "  http://${ServerIp}/?demo=1                    # клиентская игра (демо)"
    Write-Host "  http://${ServerIp}/admin/                     # вход для персонала"
    Write-Host "  ls /opt/wolfhand/admin/ на сервере             # должно быть 4 html"
}
Write-Host ""
Write-Host "Не забудьте заполнить $RemoteDir/.env.production через ssh:"
Write-Host "  ssh $SshUser@$ServerIp"
Write-Host "  sudo nano $RemoteDir/.env.production"
Write-Host "  # обязательные ключи: WOLF_SESSION_SECRET (>=32 hex), MANAGER_PASSWORD, MARKETING_PASSWORD"
Write-Host "  sudo systemctl restart wolfhand"
