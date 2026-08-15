#!/usr/bin/env bash
set -Eeuo pipefail

PUID="${PUID:-1000}"
PGID="${PGID:-1000}"
DATA_DIR="${DATA_DIR:-/data}"
UI_MODE="${UI_MODE:-headless}"

validate_positive_integer() {
  local name="$1"
  local value="$2"
  if [[ ! "$value" =~ ^[0-9]+$ ]] || (( value < 1 )); then
    echo "$name must be a positive integer" >&2
    exit 64
  fi
}

validate_positive_integer PUID "$PUID"
validate_positive_integer PGID "$PGID"

start_virtual_display() {
  export DISPLAY="${DISPLAY:-:99}"
  gosu pwuser Xvfb "$DISPLAY" -screen 0 1440x900x24 -nolisten tcp >"$DATA_DIR/logs/xvfb.log" 2>&1 &
  local xvfb_pid=$!
  local ready=0
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
}

current_gid="$(id -g pwuser)"
current_uid="$(id -u pwuser)"
if [[ "$current_gid" != "$PGID" ]]; then
  groupmod -o -g "$PGID" pwuser
fi
if [[ "$current_uid" != "$PUID" ]]; then
  usermod -o -u "$PUID" -g "$PGID" pwuser
else
  usermod -g "$PGID" pwuser
fi

export HOME=/home/pwuser
chown "$PUID:$PGID" "$HOME"

mkdir -p \
  "$DATA_DIR" \
  "$DATA_DIR/browser-profile" \
  "$DATA_DIR/files" \
  "$DATA_DIR/generated" \
  "$DATA_DIR/temp" \
  "$DATA_DIR/logs"

chown "$PUID:$PGID" "$DATA_DIR"
for directory in browser-profile files generated temp logs; do
  chown -R "$PUID:$PGID" "$DATA_DIR/$directory"
done
if [[ -e "$DATA_DIR/gateway.db" ]]; then
  chown "$PUID:$PGID" "$DATA_DIR/gateway.db"
fi

case "$UI_MODE" in
  headless)
    start_virtual_display
    ;;
  novnc)
    if [[ -z "${NOVNC_PASSWORD:-}" ]]; then
      echo 'NOVNC_PASSWORD is required when UI_MODE=novnc' >&2
      exit 64
    fi
    export DISPLAY="${DISPLAY:-:99}"
    gosu pwuser /usr/local/bin/start-novnc.sh
    ;;
  *)
    echo 'UI_MODE must be either headless or novnc' >&2
    exit 64
    ;;
esac

exec gosu pwuser "$@"
