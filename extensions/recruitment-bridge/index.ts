import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/**
 * recruitment-bridge — Plugin Gateway
 *
 * Cầu nối trung tâm giữa VClaw UI và các kỹ năng (skills) chạy trong Gateway:
 *   1. head-hunter  → Playwright / CDP (Tìm kiếm ứng viên, gửi tin nhắn, đăng bài qua trình duyệt thật)
 *   2. smart-linkedin-inbox → Linxa API (Quản lý hộp thư LinkedIn qua AI)
 */

// URL VClaw để đồng bộ kết quả tìm kiếm về DB
const VCLAW_URL = process.env.VCLAW_API_URL || "http://127.0.0.1:12687";
const VCLAW_SECRET =
  process.env.VCLAW_AGENT_TOOLS_SECRET ||
  "67859bd51900be1751e4b6db3da02f2c2ca81fc3175742e2e0c341e9b56c4570";

async function pushToVClaw(action: string, data: Record<string, unknown>) {
  try {
    await fetch(`${VCLAW_URL}/api/recruitment`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-vclaw-secret": VCLAW_SECRET,
      },
      body: JSON.stringify({ action, ...data }),
    });
  } catch (err) {
    console.error("[recruitment-bridge] Không đẩy được về VClaw:", err);
  }
}

function runScript(params: { cwd: string; command: string; args: string[] }) {
  const result = spawnSync(params.command, params.args, {
    cwd: params.cwd,
    env: process.env,
    encoding: "utf-8",
  });

  if (result.error) throw result.error;

  if (result.status !== 0) {
    return { success: false, error: result.stderr || result.stdout || "Unknown error" };
  }

  try {
    return { success: true, data: JSON.parse(result.stdout) };
  } catch {
    return { success: true, data: result.stdout };
  }
}

const SKILLS_DIR = path.join(process.cwd(), "skills");

export default {
  id: "recruitment-bridge",
  name: "Recruitment Bridge",
  description: "Cầu nối các công cụ tuyển dụng (head-hunter, Linxa) vào Gateway.",

  register(api: any) {
    // =========================================================
    // 1. head-hunter — BẮT BUỘC ở Gateway (Playwright / CDP)
    //    Lý do: cần browser thật chạy lâu dài, Next.js không hỗ trợ
    // =========================================================
    api.registerTool(() => ({
      name: "head-hunter",
      description:
        "Tìm kiếm ứng viên và đăng việc làm trên LinkedIn bằng trình duyệt thật (CDP/Playwright). " +
        "Kết quả tự động lưu vào VClaw DB.",
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: [
              "search",
              "get_profile",
              "send_message",
              "create_job_post",
              "open_browser",
              "get_session",
              "save_session",
            ],
          },
          query: { type: "string", description: "Từ khóa tìm kiếm ứng viên" },
          url: { type: "string", description: "URL profile LinkedIn" },
          profile_url: { type: "string", description: "URL profile để gửi tin nhắn" },
          message: { type: "string", description: "Nội dung tin nhắn" },
          jobPositionId: { type: "string", description: "ID vị trí trong VClaw DB" },
          // --- Dùng cho create_job_post ---
          title: { type: "string", description: "Tiêu đề vị trí tuyển dụng" },
          description: { type: "string", description: "Mô tả công việc" },
          location: { type: "string", description: "Địa điểm (vd: Ho Chi Minh, Vietnam)" },
          companyUrl: {
            type: "string",
            description: "URL Company Page LinkedIn (nếu đăng cho công ty)",
          },
        },
        required: ["action"],
      },

      async execute(_toolCallId: string, params: any) {
        const { action, jobPositionId, ...args } = params;
        const scriptPath = path.join(SKILLS_DIR, "head-hunter", "scripts", "linkedin-manager.mjs");

        if (!fs.existsSync(scriptPath)) {
          throw new Error("Script linkedin-manager.mjs không tìm thấy.");
        }

        const scriptArgs = [scriptPath];
        switch (action) {
          case "search":
          case "linkedin_search":
            scriptArgs.push("search", "--query", args.query);
            break;
          case "open_browser":
            scriptArgs.push("open_browser", "--url", args.url);
            break;
          case "get_profile":
          case "linkedin_get_profile":
            scriptArgs.push("get_profile", ...(args.url ? ["--url", args.url] : []));
            break;
          case "send_message":
          case "linkedin_send_message":
            scriptArgs.push("send_message", "--url", args.profile_url, "--message", args.message);
            break;
          case "create_job_post":
            scriptArgs.push(
              "create_job_post",
              "--title",
              args.title,
              ...(args.description ? ["--description", args.description] : []),
              ...(args.location ? ["--location", args.location] : []),
              ...(args.companyUrl ? ["--company-url", args.companyUrl] : []),
            );
            break;
          case "get_session":
            scriptArgs.push("get_session");
            break;
          case "save_session":
            scriptArgs.push("save_session", "--message", args.message);
            break;
          default:
            throw new Error(`Action không hợp lệ: ${action}`);
        }

        const result = runScript({
          cwd: path.join(SKILLS_DIR, "head-hunter"),
          command: process.execPath,
          args: scriptArgs,
        });

        // Sau tìm kiếm → tự đẩy ứng viên về VClaw DB
        if (action === "linkedin_search" && result.success && Array.isArray(result.data)) {
          const validCandidates = result.data.filter((c: any) => c.profile_url?.includes("/in/"));
          if (validCandidates.length > 0) {
            await pushToVClaw("sync_candidates", {
              candidates: validCandidates,
              jobPositionId: jobPositionId ?? null,
            });
          }
        }

        // Sau đăng bài thành công → lưu vào DB
        if (action === "create_job_post" && result.success) {
          const postData = typeof result.data === "object" ? result.data : {};
          if (postData.success) {
            await pushToVClaw("save_job_post", {
              jobPositionId: jobPositionId ?? null,
              title: args.title,
              linkedinJobUrl: postData.jobUrl ?? null,
              companyUrl: args.companyUrl ?? null,
            });
          }
        }

        return result;
      },
    }));

    // =========================================================
    // 2. smart-linkedin-inbox — Linxa API (AI agent dùng trong chat)
    //    Có thể dùng trực tiếp từ AI assistant để quản lý hội thoại
    // =========================================================
    api.registerTool(() => ({
      name: "smart-linkedin-inbox",
      description: "Quản lý hộp thư LinkedIn qua Linxa: đọc tin, gắn nhãn, gợi ý hành động.",
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: [
              "check_auth",
              "list_conversations",
              "get_messages",
              "next_actions",
              "add_comment",
              "mark_as_read",
            ],
          },
          chatId: { type: "string" },
          limit: { type: "number" },
          label: { type: "string" },
          sentiment: { type: "string" },
          search: { type: "string" },
          profileId: { type: "string" },
          text: { type: "string" },
        },
        required: ["action"],
      },

      async execute(_toolCallId: string, params: any) {
        const { action, ...args } = params;
        const token = process.env.LINXA_TOKEN;
        if (!token) throw new Error("Thiếu LINXA_TOKEN trong môi trường.");

        const base = "https://app.uselinxa.com";
        let method = "GET";
        let apiPath = "/api/mcp/conversations";
        let body: unknown = null;

        switch (action) {
          case "check_auth":
            apiPath = "/api/mcp/current-li-user";
            break;
          case "list_conversations": {
            const q = new URLSearchParams();
            if (args.limit) q.append("limit", String(args.limit));
            if (args.label) q.append("label", args.label);
            if (args.sentiment) q.append("sentiment", args.sentiment);
            if (args.search) q.append("search", args.search);
            apiPath = `/api/mcp/conversations?${q}`;
            break;
          }
          case "get_messages":
            apiPath = `/api/mcp/messages/${encodeURIComponent(args.chatId)}`;
            break;
          case "next_actions":
            method = "POST";
            apiPath = "/api/mcp/next-actions";
            break;
          case "add_comment":
            method = "POST";
            apiPath = "/api/mcp/comments";
            body = { profileId: args.profileId, text: args.text };
            break;
          case "mark_as_read":
            method = "POST";
            apiPath = `/api/mcp/conversations/${encodeURIComponent(args.chatId)}/read`;
            break;
        }

        const res = await fetch(`${base}${apiPath}`, {
          method,
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: body ? JSON.stringify(body) : undefined,
        });

        if (!res.ok) {
          return { success: false, status: res.status, error: await res.text() };
        }

        return { success: true, ...(await res.json()) };
      },
    }));

    // =========================================================
    // LƯU Ý: post-job đã chuyển về vclaw-ui/app/api/recruitment
    // Nếu AI cần đăng bài, gọi trực tiếp qua HTTP hoặc dùng
    // Server Action từ Next.js UI
    // =========================================================
  },
};
