@echo off
rem Plays WebExportTest in the default browser: serves the Wasm folder next to this file on local port 8929 and opens
rem the page. The server stops about 10 seconds after the game's tab is closed. Needs Python 3 (py or python on PATH,
rem else the Python of an Unreal Engine installed on this computer).
setlocal
cd /d "%~dp0"
rem each candidate must actually run: without Python installed, Windows' python.exe is a store stub that does not run Python
set "PY=py -3"
%PY% -c "import sys; sys.exit(sys.version_info < (3, 8))" >nul 2>nul
if not errorlevel 1 goto run
set "PY=python"
%PY% -c "import sys; sys.exit(sys.version_info < (3, 8))" >nul 2>nul
if not errorlevel 1 goto run
set "PY=python3"
%PY% -c "import sys; sys.exit(sys.version_info < (3, 8))" >nul 2>nul
if not errorlevel 1 goto run
set "ENGPY="
for /f "tokens=2,*" %%a in ('reg query "HKCU\SOFTWARE\Epic Games\Unreal Engine\Builds" 2^>nul ^| findstr /c:"REG_SZ"') do call :engine "%%b"
for /f "tokens=2,*" %%a in ('reg query "HKLM\SOFTWARE\EpicGames\Unreal Engine" /s /v InstalledDirectory 2^>nul ^| findstr /c:"REG_SZ"') do call :engine "%%b"
if not defined ENGPY goto nopython
set PY=%ENGPY%
%PY% -c "import sys; sys.exit(sys.version_info < (3, 8))" >nul 2>nul
if not errorlevel 1 goto run
:nopython
echo Python 3.8 or newer is needed to serve the game on this computer: https://www.python.org/downloads/
pause
exit /b 1
:run
%PY% -I -B serve.py --root "Wasm" --port 8929 --port-tries 10 --open "index.html?ue-session=1" --exit-after-session 10
if errorlevel 1 pause
exit /b
:engine
if defined ENGPY exit /b 0
set "E=%~1"
set "E=%E:/=\%"
if exist "%E%\Engine\Binaries\ThirdParty\Python3\Win64\python.exe" set ENGPY="%E%\Engine\Binaries\ThirdParty\Python3\Win64\python.exe"
exit /b 0
