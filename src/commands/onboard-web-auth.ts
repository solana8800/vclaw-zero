/**
 * Kích hoạt tài khoản AI Web (Web Model Auth Onboard)
 *
 * Module độc lập để xử lý việc đăng nhập và lấy token cho các model AI bản Web.
 * Hỗ trợ kích hoạt nhiều model cùng một lúc.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { resolveOpenClawAgentDir } from "../agents/agent-paths.js";
import { ensureAuthProfileStore, saveAuthProfileStore } from "../agents/auth-profiles.js";
import { ensureOpenClawModelsJson } from "../agents/models-config.js";
import type { OpenClawConfig, ModelProviderConfig } from "../config/config.js";
import { loadConfig, writeConfigFile } from "../config/io.js";
import { resolveAgentModelPrimaryValue } from "../config/model-input.js";
import type { WizardStep } from "../wizard/types.js";
import { loginChatGPTWeb } from "../zero-token/providers/chatgpt-web-auth.js";
// Import các hàm đăng nhập của từng model AI bản Web
import { loginClaudeWeb } from "../zero-token/providers/claude-web-auth.js";
import { loginDeepseekWeb } from "../zero-token/providers/deepseek-web-auth.js";
import { loginDoubaoWeb } from "../zero-token/providers/doubao-web-auth.js";
import { loginGeminiWeb } from "../zero-token/providers/gemini-web-auth.js";
import { loginGlmIntlWeb } from "../zero-token/providers/glm-intl-web-auth.js";
import { loginZWeb } from "../zero-token/providers/glm-web-auth.js";
import { loginGrokWeb } from "../zero-token/providers/grok-web-auth.js";
import { loginKimiWeb } from "../zero-token/providers/kimi-web-auth.js";
import { loginPerplexityWeb } from "../zero-token/providers/perplexity-web-auth.js";
import { loginQwenCNWeb } from "../zero-token/providers/qwen-cn-web-auth.js";
import { loginQwenWeb } from "../zero-token/providers/qwen-web-auth.js";
import { loginXiaomiMimoWeb } from "../zero-token/providers/xiaomimo-web-auth.js";
import { applyAgentDefaultModelPrimary } from "./onboard-auth.config-shared.js";

// Hàm hỗ trợ lưu thông tin đăng nhập của model AI Web
async function saveWebModelCredentials(providerId: string, credentials: unknown): Promise<void> {
  const store = ensureAuthProfileStore();
  const profileId = `${providerId}:default`;

  store.profiles[profileId] = {
    type: "token",
    provider: providerId,
    token: JSON.stringify(credentials),
  };

  saveAuthProfileStore(store);
  console.log(`  > Đã lưu thông tin đăng nhập vào auth-profiles.json`);
}

// Hàm cập nhật danh sách model được phép sử dụng (whitelist)
async function addModelToWhitelist(providerId: string, modelIds: string[]): Promise<void> {
  const config = loadConfig();

  // Đảm bảo cấu trúc config tồn tại để tránh lỗi undefined
  const anyConfig = config as Record<string, unknown>;
  if (!anyConfig.agents) {
    anyConfig.agents = { defaults: {} };
  }
  const agents = anyConfig.agents as Record<string, unknown>;
  if (!agents.defaults) {
    agents.defaults = { models: {} };
  }
  const defaults = agents.defaults as Record<string, unknown>;
  if (!defaults.models) {
    defaults.models = {};
  }

  // Danh sách tên hiển thị cho các model
  const modelAliases: Record<string, Record<string, string>> = {
    "claude-web": {
      "claude-sonnet-4-6": "Claude Web",
      "claude-opus-4-6": "Claude Opus",
      "claude-haiku-4-6": "Claude Haiku",
    },
    "chatgpt-web": {
      "gpt-4": "ChatGPT Web",
    },
    "deepseek-web": {
      "deepseek-chat": "DeepSeek V3",
      "deepseek-reasoner": "DeepSeek R1",
    },
    "doubao-web": {
      "doubao-seed-2.0": "Doubao Browser",
    },
    "gemini-web": {
      "gemini-pro": "Gemini Pro",
      "gemini-ultra": "Gemini Ultra",
      "gemini-3-flash": "Gemini 3 Flash",
    },
    "glm-web": {
      "glm-4-plus": "GLM Web",
    },
    "glm-intl-web": {
      "glm-4-plus": "GLM-4 Plus (Bản quốc tế)",
      "glm-4-think": "GLM-4 Think",
    },
    "grok-web": {
      "grok-2": "Grok Web",
    },
    "kimi-web": {
      "moonshot-v1-32k": "Kimi Web",
    },
    "perplexity-web": {
      "perplexity-web": "Perplexity Web",
    },
    "qwen-web": {
      "qwen3.5-plus": "Qwen Web",
    },
    "qwen-cn-web": {
      "qwen-turbo": "Qwen CN Web",
    },
  };

  // Thêm model vào danh sách cho phép
  for (const modelId of modelIds) {
    const modelKey = `${providerId}/${modelId}`;
    const alias = modelAliases[providerId]?.[modelId] || modelId;
    const agents = (config as Record<string, unknown>).agents as Record<string, unknown>;
    const defaults = agents.defaults as Record<string, unknown>;
    const models = defaults.models as Record<string, { alias: string }>;
    models[modelKey] = { alias };
  }

  await writeConfigFile(config);
  console.log(`  > Đã cập nhật danh sách model được phép vào openclaw.json`);
}

/**
 * Đồng bộ danh sách các nhà cung cấp AI từ models.json vào openclaw.json.
 * Việc này giúp tránh lỗi khi chạy lần đầu do openclaw.json chưa có thông tin provider,
 * dẫn đến hệ thống bị kẹt ở mặc định là Anthropic trong khi chưa có API key.
 */
async function syncModelsProvidersToConfig(): Promise<void> {
  const config = loadConfig();
  await ensureOpenClawModelsJson(config);

  const agentDir = resolveOpenClawAgentDir();
  const modelsPath = path.join(agentDir, "models.json");

  let providers: Record<string, unknown> = {};
  try {
    const raw = await fs.readFile(modelsPath, "utf8");
    const parsed = JSON.parse(raw) as { providers?: Record<string, unknown> };
    if (parsed?.providers && typeof parsed.providers === "object") {
      providers = parsed.providers;
    }
  } catch {
    return;
  }

  // Lọc bỏ các nhà cung cấp AI bản Web vì chúng được xử lý qua cầu nối zero-token
  const webProviderIds = new Set(WEB_MODEL_PROVIDERS.map((p) => p.id));
  const filtered = Object.fromEntries(
    Object.entries(providers).filter(([k]) => !webProviderIds.has(k)),
  );
  providers = filtered;

  if (Object.keys(providers).length === 0) {
    return;
  }

  let nextConfig: OpenClawConfig = {
    ...config,
    models: {
      ...config.models,
      mode: config.models?.mode ?? "merge",
      providers: {
        ...config.models?.providers,
        ...(providers as Record<string, ModelProviderConfig>),
      },
    },
    // Giữ nguyên danh sách whitelist hiện có, không ghi đè
    agents: config.agents,
  };

  // Nếu chưa cài đặt model chính, tự động lấy model đầu tiên của nhà cung cấp đầu tiên
  if (!resolveAgentModelPrimaryValue(config.agents?.defaults?.model)) {
    const firstEntry = Object.entries(providers).find(
      ([, p]) =>
        p &&
        typeof p === "object" &&
        Array.isArray((p as { models?: unknown[] }).models) &&
        (p as { models: { id?: string }[] }).models.length > 0,
    );
    if (firstEntry) {
      const [providerId, provider] = firstEntry;
      const firstModel = (provider as { models: { id: string }[] }).models[0];
      if (firstModel?.id) {
        nextConfig = applyAgentDefaultModelPrimary(nextConfig, `${providerId}/${firstModel.id}`);
        console.log(`  > Đã tự động chọn model mặc định: ${providerId}/${firstModel.id}`);
      }
    }
  }

  await writeConfigFile(nextConfig);
  console.log(`  > Đã đồng bộ danh sách nhà cung cấp (providers) vào openclaw.json`);
}

// Định nghĩa cấu trúc nhà cung cấp AI bản Web
interface WebModelProvider {
  id: string;
  name: string;
  loginFn: (params: {
    onProgress: (msg: string) => void;
    openUrl: (url: string) => Promise<boolean>;
    headless?: boolean;
  }) => Promise<unknown>;
}

const WEB_MODEL_PROVIDERS: WebModelProvider[] = [
  { id: "claude-web", name: "Claude Web", loginFn: loginClaudeWeb },
  { id: "chatgpt-web", name: "ChatGPT Web", loginFn: loginChatGPTWeb },
  { id: "deepseek-web", name: "DeepSeek Web", loginFn: loginDeepseekWeb },
  { id: "doubao-web", name: "Doubao Web", loginFn: loginDoubaoWeb },
  { id: "gemini-web", name: "Gemini Web", loginFn: loginGeminiWeb },
  { id: "glm-web", name: "GLM Web (Nội địa TQ)", loginFn: loginZWeb },
  { id: "glm-intl-web", name: "GLM Web (Quốc tế)", loginFn: loginGlmIntlWeb },
  { id: "grok-web", name: "Grok Web", loginFn: loginGrokWeb },
  { id: "kimi-web", name: "Kimi Web", loginFn: loginKimiWeb },
  { id: "perplexity-web", name: "Perplexity Web", loginFn: loginPerplexityWeb },
  { id: "qwen-web", name: "Qwen Web (Alibaba Nội địa)", loginFn: loginQwenWeb },
  { id: "qwen-cn-web", name: "Qwen Web (Alibaba Quốc tế)", loginFn: loginQwenCNWeb },
  { id: "xiaomimo-web", name: "Xiaomi Mimo Web", loginFn: loginXiaomiMimoWeb },
];

export async function runOnboardWebAuth(
  options: { providers?: string; headless?: boolean } = {},
): Promise<void> {
  // Kiểm tra tham số dòng lệnh --providers hoặc từ options của Commander
  let providersFromArgs: string[] = [];

  if (options.providers) {
    providersFromArgs = options.providers.split(",").map((p) => p.trim());
  } else {
    const args = process.argv;
    const providersIdx = args.indexOf("--providers");
    if (providersIdx !== -1 && args[providersIdx + 1]) {
      providersFromArgs = args[providersIdx + 1].split(",").map((p) => p.trim());
    }
  }

  if (providersFromArgs.length === 0) {
    console.log("\n🦞 Kích hoạt tài khoản AI Web\n");

    // Hiển thị danh sách các model đã được kích hoạt trước đó
    const store = ensureAuthProfileStore();
    const authorizedModels = Object.keys(store.profiles).filter(
      (key) => key.endsWith("-web") || key.includes("-web:"),
    );

    if (authorizedModels.length > 0) {
      console.log("Các tài khoản AI Web đã kích hoạt:");
      for (const model of authorizedModels) {
        console.log(`  - ${model}`);
      }
      console.log("");
    }

    // Yêu cầu người dùng chọn model muốn kích hoạt
    console.log(
      "Vui lòng chọn tài khoản AI Web muốn kích hoạt (nhập nhiều số cách nhau bằng dấu phẩy):\n",
    );

    for (let i = 0; i < WEB_MODEL_PROVIDERS.length; i++) {
      const provider = WEB_MODEL_PROVIDERS[i];
      const isAuthorized = authorizedModels.some((m) => m.startsWith(provider.id));
      const status = isAuthorized ? " ✓ Đã kích hoạt" : "";
      console.log(`  ${i + 1}. ${provider.name}${status}`);
    }

    console.log("\n  0. Thoát");
    console.log("  a. Kích hoạt tất cả model");
    console.log("");

    // Nhận dữ liệu từ terminal
    const readline = await import("readline");
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    const question = (prompt: string): Promise<string> =>
      new Promise((resolve) => rl.question(prompt, resolve));

    const input = await question("Lựa chọn của bạn: ");

    rl.close();

    if (input.trim() === "0" || input.trim() === "") {
      console.log("Đã thoát.");
      return;
    }

    // Xử lý các model người dùng đã chọn
    let selectedProviders: WebModelProvider[] = [];

    if (input.trim() === "a") {
      selectedProviders = WEB_MODEL_PROVIDERS;
    } else {
      const indices = input.split(",").map((s) => parseInt(s.trim()) - 1);
      selectedProviders = indices
        .filter((i) => i >= 0 && i < WEB_MODEL_PROVIDERS.length)
        .map((i) => WEB_MODEL_PROVIDERS[i]);
    }

    if (selectedProviders.length === 0) {
      console.log("Bạn chưa chọn model nào.");
      return;
    }

    await doRunAuth(selectedProviders, options.headless);
  } else {
    // Chạy trực tiếp với các provider từ tham số
    const selectedProviders = WEB_MODEL_PROVIDERS.filter((p) => providersFromArgs.includes(p.id));
    if (selectedProviders.length === 0) {
      console.log(`Không tìm thấy provider nào phù hợp với: ${providersFromArgs.join(", ")}`);
      return;
    }
    await doRunAuth(selectedProviders, options.headless);
  }
}

async function doRunAuth(selectedProviders: WebModelProvider[], headless = false): Promise<void> {
  console.log(`\nSẽ tiến hành kích hoạt: ${selectedProviders.map((p) => p.name).join(", ")}`);

  // Danh sách model ID tương ứng cho từng nhà cung cấp
  const providerModelIds: Record<string, string[]> = {
    "claude-web": ["claude-sonnet-4-6", "claude-opus-4-6", "claude-haiku-4-6"],
    "chatgpt-web": ["gpt-4"],
    "deepseek-web": ["deepseek-chat", "deepseek-reasoner"],
    "doubao-web": ["doubao-seed-2.0"],
    "gemini-web": ["gemini-pro", "gemini-ultra", "gemini-3-flash"],
    "glm-web": ["glm-4-plus"],
    "glm-intl-web": ["glm-4-plus", "glm-4-think"],
    "grok-web": ["grok-2"],
    "kimi-web": ["moonshot-v1-32k"],
    "perplexity-web": ["perplexity-web"],
    "qwen-web": ["qwen3.5-plus"],
    "qwen-cn-web": ["qwen-turbo"],
    "xiaomimo-web": ["xiaomimo-chat"],
  };

  // Tiến hành đăng nhập cho từng model đã chọn
  for (const provider of selectedProviders) {
    console.log(`\nĐang kích hoạt ${provider.name}...`);
    try {
      const result = await provider.loginFn({
        onProgress: (msg) => console.log(`  > ${msg}`),
        openUrl: async (url) => {
          console.log(`  > Vui lòng đăng nhập tại trình duyệt đang mở: ${url}`);
          return true;
        },
        headless,
      });

      // Nếu đăng nhập thành công và có thông tin trả về, lưu vào auth-profiles.json
      if (result && typeof result === "object") {
        await saveWebModelCredentials(provider.id, result);
      }

      // Thêm model vào danh sách được phép sử dụng
      const modelIds = providerModelIds[provider.id] || [];
      if (modelIds.length > 0) {
        await addModelToWhitelist(provider.id, modelIds);
      }

      console.log(`  ✓ Kích hoạt ${provider.name} thành công!`);
    } catch (error) {
      console.error(`  ✗ Lỗi khi kích hoạt ${provider.name}:`, error);
    }
  }

  // Đồng bộ lại cấu hình lần cuối để đảm bảo mọi thứ hoạt động trơn tru
  if (selectedProviders.length > 0) {
    await syncModelsProvidersToConfig();
  }

  console.log("\nHoàn tất quá trình kích hoạt!");
  console.log("Bây giờ bạn đã có thể sử dụng các model này trên giao diện VClaw.");
}

// Đăng ký bước này vào trình hướng dẫn (Wizard) của CLI
export const ONBOARD_WEB_AUTH_STEP: WizardStep = {
  title: "Kích hoạt AI Web",
  description:
    "Đăng nhập và kích hoạt các model AI bản trình duyệt (Claude, ChatGPT, DeepSeek, v.v.)",
  run: async () => {
    await runOnboardWebAuth();
  },
};
