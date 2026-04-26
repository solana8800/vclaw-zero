#!/bin/bash
# Khởi động Chrome ở chế độ gỡ lỗi từ xa (CDP) để OpenClaw Zero Token kết nối.
# Hỗ trợ macOS / Linux (kể Deepin) / Windows (Git Bash / WSL).
# Một phiên duy nhất: nếu đã có Chrome debug trên cổng 9222 thì đóng rồi mở lại.
#
# Phiên / thư mục hồ sơ (quan trọng với người dùng VClaw.app):
# - Chrome này dùng user-data-dir RIÊNG (xem detect_user_data_dir), KHÔNG phải
#   shell Electron trong VClaw.app (~/Library/Application Support/VClaw/ShellElectron).
# - Provider web của OpenClaw (browser.attachOnly + CDP) chỉ thấy cookie trong
#   hồ sơ Chrome này. Hãy đăng nhập DeepSeek/ChatGPT/Claude… trong các tab mở sẵn,
#   sau đó chạy: openclaw onboard webauth
OPENCLAW_CHROME_USER_DATA_DIR="${HOME}/Library/Application Support/VClaw/ShellElectron"

echo "=========================================="
echo "  Khởi động Chrome (chế độ debug CDP)"
echo "=========================================="
echo ""

# ─── Phát hiện môi trường ─────────────────────────────────────
detect_os() {
  case "$(uname -s)" in
    Darwin*)  echo "mac" ;;
    MINGW*|MSYS*|CYGWIN*) echo "win" ;;
    *)
      if grep -qi microsoft /proc/version 2>/dev/null; then
        echo "wsl"
      else
        echo "linux"
      fi
      ;;
  esac
}

detect_chrome() {
  local linux_paths=(
    "/opt/apps/cn.google.chrome-pre/files/google/chrome/google-chrome"  # Deepin
    "/opt/google/chrome/google-chrome"
    "/usr/bin/google-chrome"
    "/usr/bin/google-chrome-stable"
    "/usr/bin/chromium"
    "/usr/bin/chromium-browser"
    "/snap/bin/chromium"
  )
  local win_paths=(
    "$PROGRAMFILES/Google/Chrome/Application/chrome.exe"
    "$PROGRAMFILES (x86)/Google/Chrome/Application/chrome.exe"
    "$LOCALAPPDATA/Google/Chrome/Application/chrome.exe"
    "$PROGRAMFILES/Chromium/Application/chrome.exe"
  )

  case "$OS" in
    mac)
      if [ -d "/Applications/Google Chrome.app" ]; then
        echo "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
        return
      fi
      if [ -d "/Applications/Chromium.app" ]; then
        echo "/Applications/Chromium.app/Contents/MacOS/Chromium"
        return
      fi
      command -v google-chrome >/dev/null 2>&1 && echo "google-chrome" && return
      ;;
    win)
      for p in "${win_paths[@]}"; do
        [ -f "$p" ] && echo "$p" && return
      done
      ;;
    wsl|linux)
      for p in "${linux_paths[@]}"; do
        [ -f "$p" ] && echo "$p" && return
      done
      for cmd in google-chrome google-chrome-stable chromium chromium-browser; do
        command -v "$cmd" >/dev/null 2>&1 && echo "$cmd" && return
      done
      ;;
  esac
  echo ""
}

detect_user_data_dir() {
  if [ -n "${OPENCLAW_CHROME_USER_DATA_DIR:-}" ]; then
    echo "$OPENCLAW_CHROME_USER_DATA_DIR"
    return
  fi
  case "$OS" in
    mac)  echo "$HOME/Library/Application Support/Chrome-OpenClaw-Debug" ;;
    win)  echo "$LOCALAPPDATA/Chrome-OpenClaw-Debug" ;;
    wsl)  echo "$HOME/.config/chrome-openclaw-debug" ;;
    *)    echo "$HOME/.config/chrome-openclaw-debug" ;;
  esac
}

OS=$(detect_os)
CHROME_PATH=$(detect_chrome)
USER_DATA_DIR=$(detect_user_data_dir)

echo "Hệ điều hành: $OS"

if [ -z "$CHROME_PATH" ]; then
  echo "✗ Không tìm thấy Chrome hoặc Chromium. Hãy cài đặt rồi chạy lại."
  echo ""
  case "$OS" in
    linux) echo "  Ubuntu/Debian: sudo apt install google-chrome-stable" ;;
    mac)   echo "  Tải về: https://www.google.com/chrome/" ;;
    win)   echo "  Tải về: https://www.google.com/chrome/" ;;
  esac
  exit 1
fi

echo "Chrome: $CHROME_PATH"
echo "Thư mục dữ liệu người dùng: $USER_DATA_DIR"
echo ""

# ─── Một phiên: đóng Chrome debug cũ (cổng 9222) ───────────────
if pgrep -f "chrome.*remote-debugging-port=9222" > /dev/null 2>&1; then
  echo "Phát hiện Chrome debug đang chạy, đang đóng..."
  pkill -f "chrome.*remote-debugging-port=9222" 2>/dev/null
  sleep 2

  if pgrep -f "chrome.*remote-debugging-port=9222" > /dev/null 2>&1; then
    echo "Đóng thường không được, thử buộc dừng..."
    pkill -9 -f "chrome.*remote-debugging-port=9222" 2>/dev/null
    sleep 1
  fi

  if pgrep -f "chrome.*remote-debugging-port=9222" > /dev/null 2>&1; then
    echo "✗ Không đóng được Chrome. Hãy chạy thủ công: pkill -9 -f 'chrome.*remote-debugging-port=9222'"
    exit 1
  fi
  echo "✓ Đã đóng phiên cũ."
  echo ""
fi

# ─── Khởi động Chrome ─────────────────────────────────────────
TMP_LOG="/tmp/chrome-debug.log"
[ ! -d /tmp ] && TMP_LOG="$HOME/chrome-debug.log"

WEB_URLS=(
  "https://gemini.google.com/app"
  "https://chat.deepseek.com/"
  "https://chatgpt.com"
  "https://www.kimi.com"
)

echo "Đang khởi động Chrome (debug, cổng 9222)..."
echo "Cổng: 9222"
echo ""

"$CHROME_PATH" \
  "${WEB_URLS[0]}" \
  --remote-debugging-port=9222 \
  --user-data-dir="$USER_DATA_DIR" \
  --no-first-run \
  --no-default-browser-check \
  --disable-background-networking \
  --disable-sync \
  --disable-translate \
  --disable-features=TranslateUI \
  --remote-allow-origins=* \
  > "$TMP_LOG" 2>&1 &

CHROME_PID=$!
echo "Nhật ký Chrome: $TMP_LOG"

# ─── Đợi Chrome sẵn sàng ───────────────────────────────────────
echo "Đang đợi Chrome khởi động..."
for i in {1..15}; do
  if curl -s http://127.0.0.1:9222/json/version > /dev/null 2>&1; then
    break
  fi
  echo -n "."
  sleep 1
done
echo ""
echo ""

# ─── Kiểm tra kết quả ────────────────────────────────────────
if curl -s http://127.0.0.1:9222/json/version > /dev/null 2>&1; then
  VERSION_INFO=$(curl -s http://127.0.0.1:9222/json/version | jq -r '.Browser' 2>/dev/null || echo "không đọc được phiên bản")

  echo "✓ Chrome debug đã chạy thành công."
  echo ""
  echo "PID Chrome: $CHROME_PID"
  echo "Phiên bản: $VERSION_INFO"
  echo "Cổng debug: http://127.0.0.1:9222"
  echo "Thư mục dữ liệu: $USER_DATA_DIR"
  echo ""
  echo "Đang mở sẵn một số trang đăng nhập web (tiện ủy quyền)..."

  for i in "${!WEB_URLS[@]}"; do
    if [ "$i" -eq 0 ]; then continue; fi
    url="${WEB_URLS[$i]}"
    "$CHROME_PATH" --remote-debugging-port=9222 --user-data-dir="$USER_DATA_DIR" "$url" > /dev/null 2>&1 &
    sleep 0.5
  done

  echo "✓ Đã mở một số trang thường dùng (danh sách trong biến WEB_URLS); nền khác có thể mở thủ công."
  echo ""
  echo "=========================================="
  echo "Bước tiếp theo"
  echo "=========================================="
  echo "1. Đăng nhập các nền tảng cần dùng trong từng thẻ."
  echo "2. Trong openclaw.json: browser.attachOnly=true và cdpUrl trỏ tới http://127.0.0.1:9222 (profile openclaw)."
  echo "3. Chạy: openclaw onboard webauth (hoặc script onboard của bạn) để hoàn tất ủy quyền — vẫn dùng Chrome này."
  echo ""
  echo "Dừng Chrome debug:"
  echo "  pkill -f 'chrome.*remote-debugging-port=9222'"
  echo "=========================================="
else
  echo "✗ Chrome không khởi động được hoặc CDP không phản hồi."
  echo ""
  echo "Hãy kiểm tra:"
  echo "  1. Đường dẫn Chrome: $CHROME_PATH"
  echo "  2. Cổng 9222 có bị chiếm không: lsof -i:9222"
  echo "  3. Quyền thư mục dữ liệu: $USER_DATA_DIR"
  echo "  4. Nhật ký lỗi: $TMP_LOG"
  echo ""
  echo "Thử chạy tay một lệnh:"
  echo "  \"$CHROME_PATH\" --remote-debugging-port=9222 --user-data-dir=\"$USER_DATA_DIR\""
  exit 1
fi
