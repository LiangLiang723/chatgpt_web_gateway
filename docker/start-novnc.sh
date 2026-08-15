#!/usr/bin/env bash
set -Eeuo pipefail

: "${NOVNC_PASSWORD:?NOVNC_PASSWORD is required}"

DISPLAY="${DISPLAY:-:99}"
NOVNC_PORT="${NOVNC_PORT:-6080}"
DATA_DIR="${DATA_DIR:-/data}"
export DISPLAY

if [[ ! "$NOVNC_PORT" =~ ^[0-9]+$ ]] || (( NOVNC_PORT < 1 || NOVNC_PORT > 65535 )); then
  echo 'NOVNC_PORT must be an integer between 1 and 65535' >&2
  exit 64
fi

umask 077
password_file="/tmp/x11vnc.pass"
x11vnc -storepasswd "$NOVNC_PASSWORD" "$password_file" >/dev/null

Xvfb "$DISPLAY" -screen 0 1440x900x24 -nolisten tcp >"$DATA_DIR/logs/xvfb.log" 2>&1 &
xvfb_pid=$!

ready=0
for _ in $(seq 1 50); do
  if [[ -S "/tmp/.X11-unix/X${DISPLAY#:}" ]]; then
    ready=1
    break
  fi
  if ! kill -0 "$xvfb_pid" 2>/dev/null; then
    echo 'Xvfb exited before the display became ready' >&2
    exit 70
  fi
  sleep 0.1
done
if [[ "$ready" != 1 ]]; then
  echo 'Timed out waiting for Xvfb display readiness' >&2
  exit 70
fi

fluxbox >"$DATA_DIR/logs/fluxbox.log" 2>&1 &
fluxbox_pid=$!
x11vnc \
  -display "$DISPLAY" \
  -forever \
  -shared \
  -localhost \
  -rfbport 5900 \
  -rfbauth "$password_file" \
  >"$DATA_DIR/logs/x11vnc.log" 2>&1 &
x11vnc_pid=$!
websockify \
  --web=/usr/share/novnc \
  "$NOVNC_PORT" \
  localhost:5900 \
  >"$DATA_DIR/logs/websockify.log" 2>&1 &
websockify_pid=$!
rm -f /tmp/maintenance-browser.pid /tmp/maintenance-browser.ready
node /app/docker/maintenance-browser.mjs >"$DATA_DIR/logs/maintenance-browser.log" 2>&1 &
browser_pid=$!
printf '%s\n' "$browser_pid" > /tmp/maintenance-browser.pid

for pid in "$fluxbox_pid" "$x11vnc_pid" "$websockify_pid" "$browser_pid"; do
  if ! kill -0 "$pid" 2>/dev/null; then
    echo 'Failed to start the noVNC maintenance stack' >&2
    exit 70
  fi
done

browser_ready=0
for _ in $(seq 1 100); do
  if [[ -f /tmp/maintenance-browser.ready ]]; then
    browser_ready=1
    break
  fi
  if ! kill -0 "$browser_pid" 2>/dev/null; then
    echo 'Maintenance browser exited before PersistentContext became ready' >&2
    exit 70
  fi
  sleep 0.1
done
if [[ "$browser_ready" != 1 ]]; then
  echo 'Timed out waiting for maintenance browser readiness' >&2
  exit 70
fi

printf 'noVNC maintenance stack started on container port %s\n' "$NOVNC_PORT"
