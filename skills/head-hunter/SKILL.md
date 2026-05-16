---
name: head-hunter
description: "Recruitment automation for LinkedIn. Search for candidates, extract profile details, and send outreach messages. Uses the browser-cdp proxy for automation."
metadata:
  {
    "openclaw":
      {
        "emoji": "🕵️",
        "requires": { "skills": ["browser-cdp", "smart-linkedin-inbox", "post-job"] },
      },
  }
---

# Head Hunter Skill

Nghiệp vụ tuyển dụng tự động trên LinkedIn. Kỹ năng này cho phép Agent tìm kiếm ứng viên, phân tích hồ sơ và thực hiện tiếp cận (outreach) thông qua trình duyệt.

## Các công cụ chính (Tools)

### `linkedin_search(query)`

Tìm kiếm ứng viên trên LinkedIn theo từ khóa.
Ví dụ: `linkedin_search("Senior React Developer Hanoi")`

### `linkedin_get_profile(url)`

Trích xuất thông tin chi tiết từ profile ứng viên: Tên, Headline, Giới thiệu, Kinh nghiệm, Kỹ năng, Học vấn.

### `linkedin_send_message(profile_url, message)`

Gửi tin nhắn cho ứng viên.
_Lưu ý: Cần đăng nhập LinkedIn trên trình duyệt và có quyền gửi tin nhắn (Connection message hoặc InMail)._

## Triển khai kỹ thuật

Kỹ năng này dùng script Node.js `scripts/linkedin-manager.mjs` (playwright-core + Chrome CDP), cùng stack với OpenClaw Zero Token — không cần Python.

Cách gọi từ Agent (trong thư mục skill `head-hunter`):

```bash
node scripts/linkedin-manager.mjs search --query "React Developer"
```

Tuỳ chọn: `LINKEDIN_CDP_URL` (mặc định `http://127.0.0.1:9222`).

## Hướng dẫn vận hành

Kỹ năng này phụ thuộc vào `browser-cdp`. Agent sẽ điều phối trình duyệt để thực hiện các thao tác trên giao diện Web của LinkedIn.

## Phối hợp với các Kỹ năng khác

Để đạt hiệu quả tối đa, Recruiter Agent nên phối hợp các công cụ sau:

1. **Head Hunter (Browser)**: Dùng để tìm kiếm ứng viên mới và quét thông tin profile chi tiết.
2. **Smart LinkedIn Inbox (API)**: Dùng để quản lý hộp thư, phân tích sắc thái (sentiment) và nhãn (labels) của ứng viên khi họ phản hồi.
3. **Post Job (API)**: Dùng để đăng tin tuyển dụng đồng thời lên nhiều nền tảng (LinkedIn, Indeed...) để thu hút hồ sơ thụ động.

### Quy trình đề xuất:

1. **Thu hút**: Dùng `post_job` để đăng tin tuyển dụng.
2. **Tìm kiếm**: Dùng `linkedin_search` để chủ động săn ứng viên.
3. **Phân tích**: Dùng `linkedin_get_profile` để đánh giá ứng viên tiềm năng.
4. **Theo dõi & Chăm sóc**: Dùng `smart-linkedin-inbox` để quản lý các cuộc hội thoại và cập nhật trạng thái ứng viên dựa trên phản hồi của họ.
