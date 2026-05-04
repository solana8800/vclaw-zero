#!/bin/bash
# Script hỗ trợ chạy OpenClaw onboard từ thư mục gốc của repo (fork zero-token).
# Hỗ trợ onboard chính thức và webauth (ủy quyền mô hình web).
# Tương thích macOS / Linux (kể Deepin) / Windows (Git Bash / WSL).

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
STATE_DIR="$SCRIPT_DIR/.openclaw-upstream-state"
CONFIG_FILE="$STATE_DIR/openclaw.json"

# ─── Phát hiện môi trường ─────────────────────────────────────
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
  # Windows common paths
  for p in \
    "$PROGRAMFILES/nodejs/node.exe" \
    "$LOCALAPPDATA/Programs/nodejs/node.exe"; do
    [ -f "$p" ] && echo "$p" && return
  done
  echo ""
}

OS=$(detect_os)
NODE=$(detect_node)

if [ -z "$NODE" ]; then
  echo "✗ Không tìm thấy Node.js. Hãy cài Node rồi chạy lại: https://nodejs.org"
  exit 1
fi

echo "Hệ điều hành: $OS  |  Node: $($NODE --version 2>/dev/null)"

# ─── Khởi tạo thư mục và cấu hình ─────────────────────────────
mkdir -p "$STATE_DIR"

EXAMPLE_CONFIG="$SCRIPT_DIR/.openclaw-state.example/openclaw.json"
if [ ! -f "$CONFIG_FILE" ]; then
  if [ -f "$EXAMPLE_CONFIG" ]; then
    cp "$EXAMPLE_CONFIG" "$CONFIG_FILE"
    echo "Đã sao chép cấu hình mẫu: $EXAMPLE_CONFIG -> $CONFIG_FILE"
  else
    echo '{}' > "$CONFIG_FILE"
    echo "Đã tạo file cấu hình rỗng: $CONFIG_FILE (nên sao chép đầy đủ từ .openclaw-state.example/openclaw.json nếu có)"
  fi
fi

export OPENCLAW_CONFIG_PATH="$CONFIG_FILE"
export OPENCLAW_STATE_DIR="$STATE_DIR"
export OPENCLAW_GATEWAY_PORT=3001

echo "File cấu hình: $OPENCLAW_CONFIG_PATH"
echo "Thư mục trạng thái: $OPENCLAW_STATE_DIR"
echo "Cổng gateway: $OPENCLAW_GATEWAY_PORT"
echo ""

# ─── Trợ giúp ──────────────────────────────────────────────────
show_help() {
  echo "Cách dùng: $0 [lệnh] [tuỳ chọn]"
  echo ""
  echo "Lệnh:"
  echo "  onboard         Trình hướng dẫn onboard chính thức (cổng, token, API key, …)"
  echo "  webauth         Trình ủy quyền mô hình web (Claude, ChatGPT, DeepSeek, …)"
  echo "  configure       Trình cấu hình tương tác"
  echo "  gateway         Khởi động dịch vụ Gateway"
  echo ""
  echo "Tuỳ chọn:"
  echo "  -h, --help      Hiển thị trợ giúp này"
  echo ""
  echo "Ví dụ:"
  echo "  $0                  # Hiển thị trợ giúp"
  echo "  $0 onboard          # Onboard chính thức"
  echo "  $0 webauth          # Ủy quyền mô hình web"
  echo "  $0 configure       # Cấu hình tương tác"
}

# ─── Chạy lệnh ─────────────────────────────────────────────────
case "${1:-}" in
  -h|--help)
    show_help
    ;;
  webauth)
    echo "Đang mở trình ủy quyền mô hình web..."
    echo ""
    echo "⚠️  Nhớ bật Chrome debug trước (./start-chrome-debug.sh — cổng 9222)."
    echo ""
    "$NODE" "$SCRIPT_DIR/openclaw.mjs" onboard webauth "${@:2}"
    ;;
  onboard)
    echo "Đang mở trình onboard chính thức..."
    "$NODE" "$SCRIPT_DIR/openclaw.mjs" onboard "${@:2}"
    ;;
  configure)
    echo "Đang mở trình cấu hình..."
    "$NODE" "$SCRIPT_DIR/openclaw.mjs" configure "${@:2}"
    ;;
  gateway)
    echo "Đang khởi động Gateway..."
    "$NODE" "$SCRIPT_DIR/openclaw.mjs" gateway "${@:2}"
    ;;
  "")
    show_help
    ;;
  *)
    "$NODE" "$SCRIPT_DIR/openclaw.mjs" "$@"
    ;;
esac
