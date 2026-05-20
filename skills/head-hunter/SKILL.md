---
name: head-hunter
description: "Recruitment automation for LinkedIn. Search for candidates, extract profile details, and send outreach messages. Uses the browser-cdp proxy for automation."
metadata: { "openclaw": { "emoji": "🕵️", "requires": { "skills": ["browser-cdp"] } } }
---

# Head Hunter Skill

Nghiệp vụ tuyển dụng và marketing tự động trên LinkedIn. Kỹ năng này cho phép Agent tìm kiếm ứng viên, trích xuất hồ sơ chi tiết, gửi tin nhắn tiếp cận, kết nối, quản lý hộp thư và tự động đăng bài quảng bá lên trang cá nhân hoặc Company Page thông qua Chrome CDP.

## Tích hợp Gateway (Plugin recruitment-bridge)

Kỹ năng này được đăng ký trong hệ thống Gateway dưới dạng một công cụ (Tool) duy nhất là `head-hunter`. Agent sẽ gọi công cụ này bằng cách truyền tham số `action` tương ứng với nghiệp vụ cần thực hiện.

### Cấu trúc gọi Tool qua Gateway:

- **Tên công cụ**: `head-hunter`
- **Tham số bắt buộc**: `action` (dạng chuỗi)

---

## Các hành động (Actions) hỗ trợ

Dưới đây là danh sách chi tiết các giá trị của tham số `action` và các tham số đi kèm tương ứng:

### 1. `search`

Tìm kiếm ứng viên trên LinkedIn theo từ khóa.

- **Tham số đi kèm**: `query` (Chuỗi từ khóa tìm kiếm, ví dụ: `"Senior React Developer Hanoi"`)
- **Kết quả trả về**: Danh sách ứng viên gồm tên, headline, link profile và địa điểm.

### 2. `get_profile`

Trích xuất thông tin chi tiết từ profile ứng viên.

- **Tham số đi kèm**: `url` (Link profile LinkedIn cần quét. Nếu để trống, hệ thống sẽ mặc định quét thông tin của tài khoản đang đăng nhập).
- **Kết quả trả về**: Tên, Headline, Giới thiệu (About), Kinh nghiệm, Học vấn, Kỹ năng, Dự án, Ngôn ngữ, Thư giới thiệu và trạng thái kết nối hiện tại.

### 3. `send_message`

Gửi tin nhắn trực tiếp cho ứng viên trong hội thoại hiện tại hoặc qua thread.

- **Tham số đi kèm**:
  - `profile_url` (Link profile ứng viên nhận tin nhắn)
  - `message` (Nội dung tin nhắn cần gửi)
  - `threadId` (Tùy chọn: ID cuộc hội thoại cụ thể nếu đã biết để nhắn nhanh hơn qua Voyager API)

### 4. `send_connect`

Gửi lời mời kết nối kèm lời nhắn ngắn (note).

- **Tham số đi kèm**:
  - `profile_url` hoặc `url` (Link profile ứng viên muốn kết nối)
  - `note` hoặc `message` (Tùy chọn: Lời nhắn kèm theo lời mời kết nối, tối đa 300 ký tự)

### 5. `create_feed_post`

Tự động đăng bài viết marketing hoặc tuyển dụng lên feed cá nhân hoặc Company Page.

- **Tham số đi kèm**:
  - `title` (Tùy chọn: Tiêu đề hoặc dòng giật tít của bài đăng)
  - `description` (Nội dung bài viết)
  - `target` (`"personal"` - đăng lên trang cá nhân hoặc `"company"` - đăng lên Company Page)
  - `companyUrl` (Bắt buộc nếu chọn `target` là `"company"`. Ví dụ: `https://www.linkedin.com/company/abc/`)
  - `imagePath` (Tùy chọn: Đường dẫn file ảnh cục bộ trên máy nếu muốn đăng kèm ảnh)
  - `jobPositionId` (Tùy chọn: ID vị trí tuyển dụng trong DB VClaw để đồng bộ trạng thái đăng bài thành công về hệ thống)

### 6. `open_browser`

Điều hướng trình duyệt mở một trang web bất kỳ.

- **Tham số đi kèm**: `url` (URL cần mở)

### 7. `get_session`

Lấy thông tin phiên đăng nhập LinkedIn hiện tại (gồm Cookie `li_at` và User-Agent).

### 8. `save_session`

Lưu thông tin phiên làm việc thủ công vào tệp cấu hình của hệ thống.

- **Tham số đi kèm**: `message` (Chuỗi dữ liệu session dạng JSON)

### 9. `sync_inbox`

Đòng bộ danh sách các cuộc hội thoại gần đây trong hộp thư LinkedIn về Gateway.

### 10. `sync_thread`

Đồng bộ toàn bộ nội dung tin nhắn của một cuộc hội thoại cụ thể.

- **Tham số đi kèm**: `threadId` hoặc `url` (ID cuộc hội thoại LinkedIn cần đồng bộ)

---

## Triển khai kỹ thuật & Chạy CLI trực tiếp

Kỹ năng này hoạt động dựa trên script Node.js `scripts/linkedin-manager.mjs` (sử dụng `playwright-core` kết nối tới Chrome qua giao thức CDP), nằm cùng trong bộ mã nguồn của OpenClaw Zero Token.

Nếu muốn chạy trực tiếp bằng dòng lệnh từ thư mục của skill `head-hunter`:

```bash
# Tìm kiếm ứng viên
node scripts/linkedin-manager.mjs search --query "React Developer"

# Quét thông tin profile
node scripts/linkedin-manager.mjs get_profile --url "https://www.linkedin.com/in/example-username/"

# Gửi tin nhắn
node scripts/linkedin-manager.mjs send_message --url "https://www.linkedin.com/in/example-username/" --message "Xin chào ứng viên"

# Đăng bài marketing lên Company Page kèm ảnh
node scripts/linkedin-manager.mjs create_feed_post --title "Tuyển dụng React Native" --description "Chi tiết công việc..." --target company --company-url "https://www.linkedin.com/company/my-company" --image-path "/path/to/poster.png"
```

**Biến môi trường cần lưu ý**:

- `LINKEDIN_CDP_URL`: Địa chỉ cổng remote debugging của Chrome (mặc định là `http://127.0.0.1:9222`).

---

## Phối hợp hoạt động

Để quy trình tuyển dụng tự động đạt hiệu quả cao nhất, Agent nên kết hợp linh hoạt công cụ `head-hunter` với các hệ thống khác của VClaw:

1. **Đăng bài & Thu hút**: Sử dụng `head-hunter` với action `create_feed_post` để quảng bá tin tuyển dụng miễn phí lên trang cá nhân/Company Page.
2. **Tìm kiếm & Phân tích**: Sử dụng action `search` để tìm ứng viên tiềm năng và `get_profile` để phân tích sâu kỹ năng, kinh nghiệm của họ.
3. **Tiếp cận**: Sử dụng `send_connect` để kết nối và `send_message` để gửi lời mời làm việc ban đầu.
4. **Chăm sóc hội thoại**: Định kỳ dùng `sync_inbox` và `sync_thread` để kiểm tra tin nhắn phản hồi của ứng viên, phân tích thái độ của họ để đưa ra câu trả lời phù hợp.
