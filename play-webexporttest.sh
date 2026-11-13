#!/bin/sh
# Plays WebExportTest in the default browser: serves the Wasm folder next to this file on local port 8929 and opens
# the page. The server stops about 10 seconds after the game's tab is closed. Needs Python 3.8 or newer (on PATH, else the Python
# of an Unreal Engine installed on this computer). Run it with 'sh play-webexporttest.sh' (an archive
# made on Windows cannot mark it executable).
case "$0" in */*) cd "${0%/*}" || exit 1;; esac
# each candidate must actually run Python 3.8 or newer, like the .bat launcher's check
ok() { "$1" -c 'import sys; sys.exit(sys.version_info < (3, 8))' >/dev/null 2>&1; }
PY=
for N in python3 python; do P=$(command -v "$N") && ok "$P" && { PY=$P; break; }; done
if [ -z "$PY" ]; then
  case "$(uname -s)" in Darwin) H=Mac; C="$HOME/Library/Application Support/Epic";; *) H=Linux; C="${XDG_CONFIG_HOME:-$HOME/.config}/Epic";; esac
  PY=$( { sed -n 's/^[^=;[]*=//p' "$C/UnrealEngine/Install.ini" 2>/dev/null; sed -n 's/.*"InstallLocation"[^"]*"\([^"]*\)".*/\1/p' "$C/UnrealEngineLauncher/LauncherInstalled.dat" 2>/dev/null; } |
    while IFS= read -r E; do P="${E%/}/Engine/Binaries/ThirdParty/Python3/$H/bin/python3"; if [ -x "$P" ] && ok "$P"; then echo "$P"; break; fi; done )
fi
if [ -z "$PY" ]; then echo "Python 3.8 or newer is needed to serve the game on this computer: https://www.python.org/downloads/"; exit 1; fi
exec "$PY" -I -B serve.py --root "Wasm" --port 8929 --port-tries 10 --open "index.html?ue-session=1" --exit-after-session 10
