@echo off
cd /d "%~dp0"
if not exist "node_modules\electron\dist\electron.exe" (
  echo Dependency missing. Run: npm install
  pause
  exit /b 1
)
start "" "node_modules\electron\dist\electron.exe" .
