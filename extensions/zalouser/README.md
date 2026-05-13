# @openclaw/zalouser

OpenClaw extension for Zalo Personal Account messaging via native `zca-js` integration.

> **Warning:** Using Zalo automation may result in account suspension or ban. Use at your own risk. This is an unofficial integration.

## Features

- Channel plugin integration with setup wizard + QR login
- In-process listener/sender via `zca-js` (no external CLI)
- Multi-account support
- Agent tool integration (`zalouser`)
- DM/group policy support

## Prerequisites

- OpenClaw Gateway
- Zalo mobile app (for QR login)

No external `zca`, `openzca`, or `zca-cli` binary is required.

## Nhận tin từ OA / kênh (Techcombank, ngân hàng…)

Plugin hỗ trợ nhận tin từ Zalo OA/Page/kênh (type ≠ User/Group) theo hai cơ chế song song, **luôn bật**, không cần cấu hình thêm:

| Cơ chế                | Mô tả                                                                                                                                                                          |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **WS frame tap**      | Tap thẳng vào socket raw của `zca-js`, decode frame OA (cmd=501/510…) realtime. Bắt được tin ngay khi gửi đến.                                                                 |
| **old_messages poll** | Gọi `requestOldMessages` mỗi 15 giây sau khi WebSocket `connected`. Bắt được tin bị rơi vào lịch sử (offline, missed). Batch đầu tiên khi start luôn được replay vào pipeline. |

Thời gian chỉnh poll interval: `OPENCLAW_ZALOUSER_OLD_MESSAGES_SYNC_MS` (ms, mặc định 15000; đặt `0` để tắt polling).

## Debug OA / kênh

Raw log **mặc định tắt**. Bật khi cần chẩn đoán:

```bash
OPENCLAW_ZALOUSER_LOG_RAW_INBOUND=1 ./server.sh start
```

Khi bật, trên **stderr** của gateway sẽ thấy:

- `[zalouser][diag]` — xác nhận listener đã start và debug đang bật.
- `[zalouser][raw-inbound]` — payload `message.data` mỗi khi socket nhận tin.
- `[zalouser][ws-frame]` / `[zalouser][ws-frame-decoded]` — frame WebSocket thô và nội dung sau decode.
- `[zalouser][inbound-normalized]` — tin đã parse xong, kèm `conversationKind`: `friend` / `group` / `channel_candidate`.
- `[zalouser][skip-self]` — tin bị coi là `isSelf`, bỏ qua.
- `[zalouser][drop-null]` — tin không parse được (thiếu `threadId`/`senderId`); kèm JSON gợi ý field thô.
- `[zalouser][old-messages-item]` — từng tin lịch sử, kèm `senderName`, `msgType`, `msgId`, `preview`.

Grep nhanh để tìm tin kênh/OA:

```bash
grep 'channel_candidate' /tmp/openclaw-upstream-gateway.log
```

**Sau khi sửa mã trong `extensions/zalouser/src`:** phải chạy `pnpm build` ở thư mục gốc `openclaw-zero-token`, rồi `./server.sh restart` để gateway chạy từ bản build mới.

## Install

### Option A: npm

```bash
openclaw plugins install @openclaw/zalouser
```

### Option B: local source checkout

```bash
openclaw plugins install ./extensions/zalouser
cd ./extensions/zalouser && pnpm install
```

Restart the Gateway after install.

## Quick start

### Login (QR)

```bash
openclaw channels login --channel zalouser
```

Scan the QR code with the Zalo app on your phone.

### Enable channel

```yaml
channels:
  zalouser:
    enabled: true
    dmPolicy: pairing # pairing | allowlist | open | disabled
```

### Send a message

```bash
openclaw message send --channel zalouser --target <threadId> --message "Hello from OpenClaw"
```

## Configuration

Basic:

```yaml
channels:
  zalouser:
    enabled: true
    dmPolicy: pairing
```

Multi-account:

```yaml
channels:
  zalouser:
    enabled: true
    defaultAccount: default
    accounts:
      default:
        enabled: true
        profile: default
      work:
        enabled: true
        profile: work
```

## Useful commands

```bash
openclaw channels login --channel zalouser
openclaw channels login --channel zalouser --account work
openclaw channels status --probe
openclaw channels logout --channel zalouser

openclaw directory self --channel zalouser
openclaw directory peers list --channel zalouser --query "name"
openclaw directory groups list --channel zalouser --query "work"
openclaw directory groups members --channel zalouser --group-id <id>
```

## Agent tool

The extension registers a `zalouser` tool for AI agents.

Available actions: `send`, `image`, `link`, `friends`, `groups`, `me`, `status`

## Troubleshooting

- Login not persisted: `openclaw channels logout --channel zalouser && openclaw channels login --channel zalouser`
- Probe status: `openclaw channels status --probe`
- Name resolution issues (allowlist/groups): use numeric IDs or exact Zalo names

## Credits

Built on [zca-js](https://github.com/RFS-ADRENO/zca-js).
