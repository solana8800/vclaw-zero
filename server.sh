#!/bin/bash
# Script khởi chạy dịch vụ OpenClaw Gateway
# Tương thích macOS / Linux (bao gồm Deepin) / Windows (Git Bash / WSL)

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
STATE_DIR="$SCRIPT_DIR/.openclaw-upstream-state"
CONFIG_FILE="$STATE_DIR/openclaw.json"
PID_FILE="$SCRIPT_DIR/.gateway.pid"
PORT=3001

# Tiền tố tên file log (để phân biệt các instance khác nhau)
LOG_PREFIX="openclaw-upstream"

# ─── Kiểm tra môi trường ──────────────────────────────────────
detect_os() {
  case "$OSTYPE" in
    darwin*)  echo "mac" ;;
    msys*|cygwin*|mingw*) echo "win" ;;
    *)
      if grep -qi microsoft /proc/version 2>/dev/null; then
        echo "wsl"
      else
        echo "linux"
      fi
      ;;
  esac
}

detect_node() {
  if command -v node >/dev/null 2>&1; then
    echo "$(command -v node)"
    return
  fi
  for p in \
    "$PROGRAMFILES/nodejs/node.exe" \
    "$LOCALAPPDATA/Programs/nodejs/node.exe"; do
    [ -f "$p" ] && echo "$p" && return
  done
  echo ""
}

# Truy vấn PID đang chiếm dụng cổng chỉ định (đa nền tảng)
port_pid() {
  local port=$1
  if command -v lsof >/dev/null 2>&1; then
    lsof -ti:"$port" 2>/dev/null
  elif command -v ss >/dev/null 2>&1; then
    ss -tlnp 2>/dev/null | awk -v p="$port" '$4 ~ ":"p"$" {match($6,/pid=([0-9]+)/,a); if(a[1]) print a[1]}'
  elif command -v netstat >/dev/null 2>&1; then
    # Git Bash / Windows netstat
    netstat -ano 2>/dev/null | awk -v p="$port" '$2 ~ ":"p"$" && $4=="LISTENING" {print $5; exit}'
  fi
}

# Mở trình duyệt (đa nền tảng)
open_browser() {
  local url=$1
  case "$OS" in
    mac) open "$url" ;;
    win) start "" "$url" 2>/dev/null || cmd.exe /c start "" "$url" 2>/dev/null ;;
    wsl) cmd.exe /c start "" "$url" 2>/dev/null ;;
    linux)
      if command -v xdg-open >/dev/null 2>&1; then
        xdg-open "$url" 2>/dev/null &
      else
        echo "Vui lòng mở địa chỉ này thủ công trong trình duyệt: $url"
      fi
      ;;
  esac
}

# Đường dẫn log tạm thời (Windows không nhất thiết có /tmp)
tmp_log() {
  if [ -d /tmp ]; then
    echo "/tmp/openclaw-upstream-gateway.log"
  else
    echo "$SCRIPT_DIR/logs/openclaw-upstream-gateway.log"
  fi
}

OS=$(detect_os)
NODE=$(detect_node)
LOG_FILE="$SCRIPT_DIR/logs/openclaw-upstream.log"
TMP_LOG=$(tmp_log)

if [ -z "$NODE" ]; then
  echo "✗ Không tìm thấy node, vui lòng cài đặt Node.js trước: https://nodejs.org"
  exit 1
fi

# ─── Khởi tạo ──────────────────────────────────────────────────
mkdir -p "$STATE_DIR"
mkdir -p "$SCRIPT_DIR/logs"

EXAMPLE_CONFIG="$SCRIPT_DIR/.openclaw-state.example/openclaw.json"
if [ ! -f "$CONFIG_FILE" ]; then
  if [ -f "$EXAMPLE_CONFIG" ]; then
    cp "$EXAMPLE_CONFIG" "$CONFIG_FILE"
    echo "Đã sao chép file cấu hình từ ví dụ: $EXAMPLE_CONFIG -> $CONFIG_FILE"
  else
    echo '{}' > "$CONFIG_FILE"
    echo "Đã tạo file cấu hình trống: $CONFIG_FILE (Khuyên dùng: sao chép cấu hình đầy đủ từ .openclaw-state.example/openclaw.json)"
  fi
fi

# Đọc token động từ file cấu hình, nếu không có thì dùng biến môi trường
GATEWAY_TOKEN=$(jq -r '.gateway.auth.token // empty' "$CONFIG_FILE" 2>/dev/null)
if [ -z "$GATEWAY_TOKEN" ]; then
  GATEWAY_TOKEN="${OPENCLAW_GATEWAY_TOKEN:-}"
fi

# ─── Các hàm chức năng ────────────────────────────────────────
stop_gateway() {
  if [ -f "$PID_FILE" ]; then
    OLD_PID=$(cat "$PID_FILE")
    if kill -0 "$OLD_PID" 2>/dev/null; then
      echo "Đang dừng tiến trình cũ (PID: $OLD_PID)..."
      kill "$OLD_PID" 2>/dev/null
      sleep 1
      if kill -0 "$OLD_PID" 2>/dev/null; then
        kill -9 "$OLD_PID" 2>/dev/null
      fi
    fi
    rm -f "$PID_FILE"
  fi

  PORT_PID=$(port_pid "$PORT")
  if [ -n "$PORT_PID" ]; then
    echo "Đang dừng tiến trình chiếm dụng cổng $PORT (PID: $PORT_PID)..."
    kill "$PORT_PID" 2>/dev/null
    sleep 1
  fi
}

start_gateway() {
  export OPENCLAW_CONFIG_PATH="$CONFIG_FILE"
  export OPENCLAW_STATE_DIR="$STATE_DIR"
  export OPENCLAW_GATEWAY_PORT="$PORT"

  echo "Hệ điều hành: $OS  |  Node: $($NODE --version 2>/dev/null)"
  echo "Đang khởi động dịch vụ Gateway..."
  echo "File cấu hình: $OPENCLAW_CONFIG_PATH"
  echo "Thư mục trạng thái: $OPENCLAW_STATE_DIR"
  echo "File log tạm: $TMP_LOG"
  echo "Cổng: $PORT"
  echo ""

  nohup "$NODE" "$SCRIPT_DIR/openclaw.mjs" gateway --port "$PORT" > "$TMP_LOG" 2>&1 &
  GATEWAY_PID=$!
  echo "$GATEWAY_PID" > "$PID_FILE"

  echo "Đang chờ Gateway sẵn sàng..."
  WEBUI_READY=0
  i=0
  while [ $i -lt 30 ]; do
    i=$((i + 1))
    if curl -s -o /dev/null --connect-timeout 1 "http://127.0.0.1:$PORT/" 2>/dev/null; then
      echo "Gateway đã sẵn sàng (${i}s)"
      WEBUI_READY=1
      break
    fi
    if ! kill -0 $GATEWAY_PID 2>/dev/null; then
      echo "Tiến trình Gateway đã thoát, khởi động thất bại"
      cat "$TMP_LOG"
      rm -f "$PID_FILE"
      exit 1
    fi
    sleep 1
  done

  if kill -0 $GATEWAY_PID 2>/dev/null; then
    if [ "$WEBUI_READY" -eq 0 ]; then
      echo "⚠ Kiểm tra bằng curl không thành công, Gateway có thể chưa sẵn sàng, vui lòng mở Web UI thủ công sau giây lát"
    fi
    WEBUI_URL="http://127.0.0.1:$PORT/#token=${GATEWAY_TOKEN}"
    echo "Dịch vụ Gateway đã khởi động (PID: $GATEWAY_PID)"
    echo "Web UI: $WEBUI_URL"
    if [ "$WEBUI_READY" -eq 1 ]; then
      echo "Đang mở trình duyệt..."
      open_browser "$WEBUI_URL"
    else
      echo "Vui lòng mở địa chỉ trên thủ công trong trình duyệt"
    fi
  else
    echo "Khởi động dịch vụ Gateway thất bại, vui lòng kiểm tra log:"
    cat "$TMP_LOG"
    rm -f "$PID_FILE"
    exit 1
  fi
}

update_cookie() {
  echo "Đang cập nhật Claude Web Cookie..."

  if [ -z "$2" ]; then
    echo "Lỗi: Vui lòng cung cấp chuỗi cookie đầy đủ"
    echo "Cách dùng: $0 update-cookie \"chuỗi_cookie_đầy_đủ\""
    echo ""
    echo "Cách lấy cookie từ trình duyệt:"
    echo "1. Truy cập https://claude.ai"
    echo "2. Nhấn F12 để mở công cụ nhà phát triển"
    echo "3. Chuyển sang tab Network"
    echo "4. Gửi một tin nhắn bất kỳ"
    echo "5. Tìm yêu cầu (request) 'completion'"
    echo "6. Sao chép giá trị 'cookie' đầy đủ trong phần Request Headers"
    exit 1
  fi

  COOKIE_STRING="$2"
  AUTH_FILE="$STATE_DIR/agents/main/agent/auth-profiles.json"

  # Sử dụng grep để trích xuất sessionKey
  SESSION_KEY=$(echo "$COOKIE_STRING" | grep -o 'sessionKey=[^;]*' | cut -d'=' -f2 || echo "")

  if [ -z "$SESSION_KEY" ]; then
    echo "Lỗi: Không tìm thấy sessionKey trong cookie"
    exit 1
  fi

  JSON_DATA=$(cat <<EOF
{
  "sessionKey": "$SESSION_KEY",
  "cookie": "$COOKIE_STRING",
  "userAgent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
}
EOF
)

  if [ -f "$AUTH_FILE" ]; then
    jq --arg key "$JSON_DATA" '.profiles["claude-web:default"].key = $key' "$AUTH_FILE" > "$AUTH_FILE.tmp" && mv "$AUTH_FILE.tmp" "$AUTH_FILE"
    echo "✓ Đã cập nhật Claude Web cookie"
    echo "✓ SessionKey: ${SESSION_KEY:0:50}..."
    echo ""
    echo "Bây giờ hãy khởi động lại dịch vụ:"
    echo "  $0 restart"
  else
    echo "Lỗi: File auth-profiles.json không tồn tại, vui lòng chạy ./onboard.sh trước"
    exit 1
  fi
}

# ─── Điểm vào (Entrypoint) ───────────────────────────────────
case "${1:-start}" in
  start)
    stop_gateway
    start_gateway
    ;;
  stop)
    stop_gateway
    echo "Dịch vụ Gateway đã dừng"
    ;;
  restart)
    stop_gateway
    start_gateway
    ;;
  status)
    if [ -f "$PID_FILE" ]; then
      PID=$(cat "$PID_FILE")
      if kill -0 "$PID" 2>/dev/null; then
        echo "Dịch vụ Gateway đang chạy (PID: $PID)"
        echo "Web UI: http://127.0.0.1:$PORT/#token=${GATEWAY_TOKEN}"
      else
        echo "Dịch vụ Gateway không chạy (File PID tồn tại nhưng tiến trình đã thoát)"
      fi
    else
      PORT_PID=$(port_pid "$PORT")
      if [ -n "$PORT_PID" ]; then
        echo "Cổng $PORT đang bị chiếm dụng bởi tiến trình $PORT_PID, nhưng không phải do Gateway này khởi động"
      else
        echo "Dịch vụ Gateway hiện không chạy"
      fi
    fi
    ;;
  update-cookie)
    update_cookie "$@"
    ;;
  *)
    echo "Cách dùng: $0 {start|stop|restart|status|update-cookie}"
    echo ""
    echo "Giải thích các lệnh:"
    echo "  start         - Khởi động dịch vụ Gateway"
    echo "  stop          - Dừng dịch vụ Gateway"
    echo "  restart       - Khởi động lại dịch vụ Gateway"
    echo "  status        - Kiểm tra trạng thái dịch vụ"
    echo "  update-cookie - Cập nhật Claude Web cookie"
    echo ""
    echo "Ví dụ:"
    echo "  $0 update-cookie \"sessionKey=sk-ant-...; anthropic-device-id=...\""
    exit 1
    ;;
esac
