#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

LABEL="com.mypi"
DOMAIN="gui/$(id -u)"
TARGET="$DOMAIN/$LABEL"

STATE_DIR="$HOME/.my-pi"
LAUNCH_AGENTS_DIR="$HOME/Library/LaunchAgents"
PLIST_PATH="$LAUNCH_AGENTS_DIR/$LABEL.plist"
BIN_PATH="$PROJECT_DIR/dist/my-pi"
LOG_PATH="$STATE_DIR/service.log"

usage() {
  cat <<'EOF'
Usage: ./scripts/my-pi-service.sh <command>

Commands:
  start     Start the macOS launchd service
  stop      Stop the macOS launchd service
  restart   Restart the macOS launchd service
  status    Show service status
  logs      Tail the service log
EOF
}

say() {
  printf '%s\n' "$*"
}

merged_path() {
  local values=(
    "/opt/homebrew/bin"
    "/usr/local/bin"
    "/usr/bin"
    "/bin"
    "/usr/sbin"
    "/sbin"
  )
  local env_parts=()
  local seen=":"
  local merged=()
  local value

  IFS=':' read -r -a env_parts <<< "${PATH:-}"
  values+=("${env_parts[@]}")

  for value in "${values[@]}"; do
    [[ -z "$value" ]] && continue
    [[ "$seen" == *":$value:"* ]] && continue
    seen+="$value:"
    merged+=("$value")
  done

  local IFS=':'
  printf '%s\n' "${merged[*]}"
}

ensure_binary() {
  if [[ -x "$BIN_PATH" ]]; then
    return
  fi

  say "🔨 Compiled binary not found. Building dist/my-pi ..."
  (
    cd "$PROJECT_DIR"
    npm run build
  )
}

write_plist() {
  mkdir -p "$STATE_DIR" "$LAUNCH_AGENTS_DIR"

  local path_value
  path_value="$(merged_path)"

  cat > "$PLIST_PATH" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$BIN_PATH</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$PROJECT_DIR</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key>
    <string>$HOME</string>
    <key>PATH</key>
    <string>$path_value</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>$LOG_PATH</string>
  <key>StandardErrorPath</key>
  <string>$LOG_PATH</string>
</dict>
</plist>
EOF
}

is_loaded() {
  launchctl print "$TARGET" >/dev/null 2>&1
}

service_pids() {
  /bin/ps -axo pid=,command= | while IFS= read -r line; do
    line="${line#"${line%%[![:space:]]*}"}"
    [[ -z "$line" ]] && continue

    local pid="${line%%[[:space:]]*}"
    local command="${line#"$pid"}"
    command="${command#"${command%%[![:space:]]*}"}"

    if [[ "$command" == "$BIN_PATH" || "$command" == "$BIN_PATH "* ]]; then
      printf '%s\n' "$pid"
    fi
  done
}

start_service() {
  ensure_binary
  write_plist

  if is_loaded; then
    if [[ -n "$(service_pids)" ]]; then
      say "✅ MyPi service is already running."
      say "   Log: $LOG_PATH"
      return
    fi

    say "▶️  Starting MyPi service ..."
    launchctl kickstart -k "$TARGET"
  else
    say "▶️  Starting MyPi service ..."
    launchctl bootstrap "$DOMAIN" "$PLIST_PATH"
  fi

  say "✅ MyPi service started."
  say "   Plist: $PLIST_PATH"
  say "   Log:   $LOG_PATH"
}

stop_service() {
  if ! is_loaded; then
    say "ℹ️  MyPi service is not running."
    return
  fi

  say "⏹️  Stopping MyPi service ..."
  launchctl bootout "$DOMAIN" "$PLIST_PATH" 2>/dev/null || launchctl bootout "$TARGET"
  say "✅ MyPi service stopped."
}

restart_service() {
  ensure_binary
  write_plist

  say "🔁 Restarting MyPi service ..."
  if is_loaded; then
    launchctl kickstart -k "$TARGET"
  else
    launchctl bootstrap "$DOMAIN" "$PLIST_PATH"
  fi

  say "✅ MyPi service restarted."
  say "   Log: $LOG_PATH"
}

status_service() {
  if is_loaded; then
    say "✅ MyPi service is loaded."
    local pids
    pids="$(service_pids || true)"
    if [[ -n "$pids" ]]; then
      say "   PID(s): $(printf '%s' "$pids" | paste -sd ',' -)"
    else
      say "   Process: loaded, waiting to start"
    fi
    say "   Plist:   $PLIST_PATH"
    say "   Log:     $LOG_PATH"
    return 0
  fi

  say "⏹️  MyPi service is stopped."
  say "   Plist: $PLIST_PATH"
  return 1
}

logs_service() {
  mkdir -p "$STATE_DIR"
  touch "$LOG_PATH"
  exec tail -n 50 -f "$LOG_PATH"
}

command="${1:-}"
case "$command" in
  start)
    start_service
    ;;
  stop)
    stop_service
    ;;
  restart)
    restart_service
    ;;
  status)
    status_service
    ;;
  logs)
    logs_service
    ;;
  -h|--help|help)
    usage
    ;;
  *)
    usage
    exit 1
    ;;
esac
