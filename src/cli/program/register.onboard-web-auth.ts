import type { Command } from "commander";
import { runOnboardWebAuth } from "../../commands/onboard-web-auth.js";

export function registerOnboardWebAuthCommand(program: Command) {
  program
    .command("webauth")
    .description(
      "Trình hướng dẫn xác thực mô hình Web - Kích hoạt Claude/ChatGPT/DeepSeek mà không cần API Key",
    )
    .option(
      "--providers <ids>",
      "Danh sách các provider muốn kích hoạt, cách nhau bằng dấu phẩy (ví dụ: deepseek-web,gemini-web)",
    )
    .option("--headless", "Chạy trình duyệt ở chế độ headless (ẩn giao diện)", false)
    .action(async (options: { providers?: string; headless: boolean }) => {
      await runOnboardWebAuth(options);
      // Playwright browser connections and timers keep the process alive.
      // Force exit after auth completes so the user returns to the terminal.
      process.exit(0);
    });
}
