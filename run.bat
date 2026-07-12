@echo off
setlocal

cd /d "%~dp0"
set "BUILD_STAMP=node_modules\.chat-context-rag-build-stamp"

call :require_command node.exe "Node.js 20 nebo novejsi"
if errorlevel 1 goto :failed
call :require_command npm.cmd "npm"
if errorlevel 1 goto :failed
call :require_command py.exe "Python 3.9 pres Windows py launcher"
if errorlevel 1 goto :failed
call :require_command docker.exe "Docker Desktop"
if errorlevel 1 goto :failed
call :require_command powershell.exe "Windows PowerShell"
if errorlevel 1 goto :failed
call :validate_runtime_versions
if errorlevel 1 goto :failed

if not exist ".env" (
  echo [CHYBA] Chybi soubor .env. Zkopirujte .env.example na .env a doplnte hodnoty.
  goto :failed
)

call :needs_rebuild
if errorlevel 2 goto :failed
if errorlevel 1 goto :start_infrastructure
call :rebuild
if errorlevel 1 goto :failed

:start_infrastructure
echo [ChatContextRAG] Spoustim PostgreSQL...
docker compose up -d --wait --wait-timeout 60
if errorlevel 1 goto :failed

echo [ChatContextRAG] Spoustim aplikaci...
call npm.cmd start
set "APP_EXIT_CODE=%ERRORLEVEL%"
if not "%APP_EXIT_CODE%"=="0" (
  echo [CHYBA] Aplikace skoncila s kodem %APP_EXIT_CODE%.
  pause
)
exit /b %APP_EXIT_CODE%

:needs_rebuild
if not exist "node_modules\.bin\electron.cmd" exit /b 0
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command ^
  "$ErrorActionPreference = 'Stop'; try { $stamp = '%BUILD_STAMP%'; if (-not (Test-Path -LiteralPath $stamp)) { exit 0 }; $stampTime = (Get-Item -LiteralPath $stamp).LastWriteTimeUtc; $files = @(Get-Item package.json, backend\requirements.txt, docker-compose.yml, run.bat) + @(Get-ChildItem backend, electron, renderer -Recurse -File -Include *.py, *.js, *.html, *.css); if ($files.Where({ $_.LastWriteTimeUtc -gt $stampTime }).Count -gt 0) { exit 0 }; exit 1 } catch { Write-Error $_; exit 2 }"
exit /b %ERRORLEVEL%

:rebuild
echo [ChatContextRAG] Soubory se zmenily, obnovuji zavislosti...
call npm.cmd install --no-package-lock
if errorlevel 1 exit /b 1
py.exe -3.9 -m pip install -r backend\requirements.txt
if errorlevel 1 exit /b 1
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command ^
  "Set-Content -LiteralPath '%BUILD_STAMP%' -Value ([DateTime]::UtcNow.ToString('O'))"
if errorlevel 1 exit /b 1
echo [ChatContextRAG] Obnova byla dokoncena.
exit /b 0

:require_command
where %~1 >nul 2>nul
if not errorlevel 1 exit /b 0
echo [CHYBA] Neni dostupny %~2. Nainstalujte jej a zkuste to znovu.
exit /b 1

:validate_runtime_versions
node.exe -e "process.exit(Number(process.versions.node.split('.')[0]) >= 20 ? 0 : 1)"
if errorlevel 1 (
  echo [CHYBA] ChatContextRAG vyzaduje Node.js 20 nebo novejsi.
  exit /b 1
)
py.exe -3.9 -c "import sys; raise SystemExit(0 if sys.version_info[:2] == (3, 9) else 1)"
if errorlevel 1 (
  echo [CHYBA] ChatContextRAG vyzaduje Python 3.9 dostupny pres py launcher.
  exit /b 1
)
exit /b 0

:failed
echo [CHYBA] ChatContextRAG se nepodarilo spustit.
pause
exit /b 1
