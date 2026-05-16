#!/usr/bin/env node
import fs from "fs";
import os from "os";
import path from "path";
/**
 * Điều phối LinkedIn qua Chrome CDP (playwright-core).
 * Chạy từ thư mục skill: node scripts/linkedin-manager.mjs <action> [options]
 *
 * Actions:
 *   search          --query "..."         Tìm ứng viên
 *   get_profile     --url "..."           Lấy thông tin profile
 *   send_message    --url "..." --message "..."   Gửi tin nhắn
 *   create_job_post --title "..." --description "..." --location "..." [--company-url "..."]
 *
 * Biến môi trường: LINKEDIN_CDP_URL (mặc định http://127.0.0.1:9222)
 */
import { chromium } from "playwright-core";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SESSION_FILE = path.join(os.homedir(), ".openclaw", "workspace", "linkedin-session.json");

function parseCli(argv) {
  const args = [...argv];
  const out = {
    action: args.shift() ?? null,
    query: null,
    url: null,
    message: null,
    title: null,
    description: null,
    location: null,
    companyUrl: null,
    cdpUrl: process.env.LINKEDIN_CDP_URL || "http://127.0.0.1:9222",
  };
  while (args.length) {
    const a = args.shift();
    if (a === "--query") out.query = args.shift() ?? null;
    else if (a === "--url") out.url = args.shift() ?? null;
    else if (a === "--message") out.message = args.shift() ?? null;
    else if (a === "--title") out.title = args.shift() ?? null;
    else if (a === "--description") out.description = args.shift() ?? null;
    else if (a === "--location") out.location = args.shift() ?? null;
    else if (a === "--company-url") out.companyUrl = args.shift() ?? null;
    else if (a === "--cdp-url") out.cdpUrl = args.shift() ?? out.cdpUrl;
  }
  return out;
}

async function connectPage(cdpUrl) {
  const base = cdpUrl.replace(/\/$/, "");
  try {
    const res = await fetch(`${base}/json/version`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const versionInfo = await res.json();
    const wsUrl = versionInfo.webSocketDebuggerUrl;
    if (!wsUrl) throw new Error("Phản hồi CDP thiếu webSocketDebuggerUrl");
    const browser = await chromium.connectOverCDP(wsUrl);
    const context = browser.contexts()[0] ?? (await browser.newContext());
    let page = context.pages()[0];
    if (!page) page = await context.newPage();
    return { browser, page };
  } catch (e) {
    throw new Error(
      `Không thể kết nối Chrome (CDP: ${base}). Hãy đảm bảo Chrome đang chạy với --remote-debugging-port=9222. Chi tiết: ${e.message}`,
    );
  }
}

// ============================================================
// 1. Tìm kiếm ứng viên
// ============================================================
async function linkedinSearch(query, cdpUrl) {
  console.error(`--- Đang tìm kiếm ứng viên với từ khóa: '${query}' ---`);
  const { browser, page } = await connectPage(cdpUrl);
  try {
    const encoded = encodeURIComponent(query);
    await page.goto(`https://www.linkedin.com/search/results/people/?keywords=${encoded}`, {
      timeout: 60_000,
    });

    try {
      let people = page.getByRole("button", { name: "People", exact: true });
      if (!(await people.isVisible().catch(() => false)))
        people = page.getByRole("button", { name: "Mọi người", exact: true });
      if (await people.isVisible().catch(() => false)) {
        await people.click();
        await sleep(2000);
      }
    } catch {
      /* bỏ qua */
    }

    try {
      await page.waitForSelector(
        ".reusable-search__result-container, .entity-result, a[href*='/in/']",
        { timeout: 15_000 },
      );
    } catch {
      console.error(`⚠️ Không thấy kết quả rõ ràng. Tiêu đề: ${await page.title()}`);
    }

    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight / 2));
    await sleep(3000);

    let selectors = await page.locator(".reusable-search__result-container").all();
    if (selectors.length === 0) selectors = await page.locator(".entity-result").all();
    if (selectors.length === 0) selectors = await page.locator("div:has(a[href*='/in/'])").all();

    console.error(`--- Tìm thấy ${selectors.length} thẻ kết quả ---`);

    const seen = new Set();
    const results = [];
    for (const sel of selectors) {
      if (results.length >= 5) break;
      try {
        let nameEl = sel.locator(".entity-result__title-text a, .actor-name").first();
        if (!(await nameEl.count())) nameEl = sel.locator("a[href*='/in/']").first();
        if (!(await nameEl.count())) continue;

        const name = (await nameEl.innerText()).split("\n")[0].trim();
        let href = await nameEl.getAttribute("href");
        if (!href) continue;
        let profileUrl = href.split("?")[0];
        if (!profileUrl.startsWith("http")) profileUrl = `https://www.linkedin.com${profileUrl}`;
        if (!profileUrl.includes("/in/") || seen.has(profileUrl)) continue;
        seen.add(profileUrl);

        const headlineEl = sel
          .locator(".entity-result__primary-subtitle, .subline-level-1")
          .first();
        const headline = (await headlineEl.count()) ? (await headlineEl.innerText()).trim() : "N/A";
        const locationEl = sel
          .locator(".entity-result__secondary-subtitle, .subline-level-2")
          .first();
        const location = (await locationEl.count()) ? (await locationEl.innerText()).trim() : "N/A";

        results.push({ name, headline, profile_url: profileUrl, location });
      } catch (e) {
        console.error(`⚠️ Lỗi trích xuất: ${e}`);
      }
    }
    return results;
  } finally {
    await browser.disconnect();
  }
}

// ============================================================
// 2. Lấy thông tin profile (hoặc profile bản thân nếu url trống)
// ============================================================
async function linkedinGetProfile(url, cdpUrl) {
  const targetUrl = url || "https://www.linkedin.com/feed/";
  console.error(`--- Đang lấy thông tin profile (Identify): ${targetUrl} ---`);
  const { browser, page } = await connectPage(cdpUrl);
  try {
    await page.goto(targetUrl, { timeout: 60_000 });
    await page.waitForLoadState("networkidle").catch(() => null);

    const currentUrl = page.url();
    const onLoginWall =
      currentUrl.includes("login") ||
      currentUrl.includes("authwall") ||
      currentUrl.includes("checkpoint");

    let sessionCookie = null;
    let sessionData = null;
    try {
      const context = page.context();
      const cookies = await context.cookies();
      sessionCookie = cookies.find((c) => c.name === "li_at")?.value || null;

      const cookieStr = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
      const userAgent = await page.evaluate(() => navigator.userAgent);

      sessionData = JSON.stringify({
        cookie: cookieStr,
        userAgent: userAgent,
      });
    } catch {
      /* bỏ qua */
    }

    const loggedIn = Boolean(sessionCookie) && !onLoginWall;
    if (!loggedIn) {
      return {
        success: false,
        loggedIn: false,
        error: "Chưa đăng nhập LinkedIn",
        url: currentUrl,
        sessionCookie,
      };
    }

    try {
      let name = "N/A";
      let headline = "N/A";
      let avatarUrl = null;

      const nameEl = page
        .locator(
          "h1.text-heading-xlarge, .pv-top-card--list .text-heading-xlarge, .feed-identity-module__actor-meta a",
        )
        .first();
      if (await nameEl.count()) name = (await nameEl.innerText()).trim().split("\n")[0];

      const headlineEl = page
        .locator(
          "div.text-body-medium, .pv-top-card--list .text-body-medium, .feed-identity-module__actor-meta .identity-headline",
        )
        .first();
      if (await headlineEl.count()) headline = (await headlineEl.innerText()).trim();

      const avatarEl = page
        .locator(
          "img.pv-top-card-profile-picture__image, .feed-identity-module__actor-meta img, img.profile-photo-edit__preview",
        )
        .first();
      if (await avatarEl.count()) {
        avatarUrl = (await avatarEl.getAttribute("src")) || null;
      }

      const aboutEl = page.locator("#about ~ div.display-flex, .pv-about-section").first();
      const about = (await aboutEl.count()) ? (await aboutEl.innerText()).trim() : "N/A";

      let profileUrl = currentUrl;
      if (!profileUrl.includes("/in/")) {
        const profileLink = page.locator("a[href*='/in/']").first();
        if (await profileLink.count()) {
          const href = await profileLink.getAttribute("href");
          if (href) {
            profileUrl = href.startsWith("http")
              ? href.split("?")[0]
              : `https://www.linkedin.com${href.split("?")[0]}`;
          }
        }
      }

      if (sessionCookie && sessionData) {
        try {
          const base = JSON.parse(sessionData);
          const cookieStr = base.cookie || "";
          const dotcomMatch = cookieStr.match(/(?:^|;\s*)dotcom_user=([^;]*)/);
          const dotcomUser = dotcomMatch?.[1]?.replace(/^"|"$/g, "") || null;
          base.profile = {
            name: name !== "N/A" ? name : undefined,
            headline: headline !== "N/A" ? headline : undefined,
            username: dotcomUser || undefined,
            avatarUrl: avatarUrl || undefined,
            url: profileUrl,
            savedAt: new Date().toISOString(),
          };
          sessionData = JSON.stringify(base);
          fs.mkdirSync(path.dirname(SESSION_FILE), { recursive: true });
          fs.writeFileSync(SESSION_FILE, sessionData);
          console.error(`--- Đã lưu session + profile vào file: ${SESSION_FILE} ---`);
        } catch (err) {
          console.error(`⚠️ Lỗi lưu file session: ${err.message}`);
        }
      }

      return {
        success: true,
        loggedIn: true,
        name,
        headline,
        about,
        url: profileUrl,
        avatarUrl,
        sessionCookie,
        sessionData,
        sessionFile: SESSION_FILE,
      };
    } catch (e) {
      return {
        success: false,
        loggedIn: false,
        error: `Lỗi trích xuất dữ liệu: ${e.message}`,
        url: currentUrl,
        sessionCookie,
        sessionData,
      };
    }
  } finally {
    await browser.disconnect();
  }
}

// ============================================================
// 3. Đăng bài tuyển dụng trực tiếp lên LinkedIn
//    Hỗ trợ: trang cá nhân (/in/) hoặc Company Page (/company/)
// ============================================================
async function linkedinCreateJobPost({ title, description, location, companyUrl, cdpUrl }) {
  console.error(`--- Đang đăng việc làm: '${title}' ---`);
  const { browser, page } = await connectPage(cdpUrl);

  try {
    // Xác định đăng lên đâu: company page hay personal
    const isCompanyPost = companyUrl && companyUrl.includes("/company/");

    // LinkedIn job posting URL
    let postUrl = "https://www.linkedin.com/jobs/post/";
    if (isCompanyPost) {
      // Trích company slug từ URL
      const slug = companyUrl.replace(/\/$/, "").split("/company/")[1]?.split("/")[0];
      if (slug) postUrl = `https://www.linkedin.com/company/${slug}/jobs/post/`;
    }

    console.error(`→ Mở trang: ${postUrl}`);
    await page.goto(postUrl, { timeout: 60_000 });
    await sleep(3000);

    // Nếu bị redirect về trang khác (login, v.v.) thì báo lỗi
    const currentUrl = page.url();
    if (currentUrl.includes("login") || currentUrl.includes("authwall")) {
      return { success: false, error: "Chưa đăng nhập LinkedIn. Hãy đăng nhập vào trình duyệt." };
    }

    // ---- Điền form đăng việc ----
    // Tiêu đề vị trí
    const titleField = page
      .locator(
        "input[id*='title'], input[placeholder*='title'], input[aria-label*='Job title'], input[aria-label*='Tiêu đề']",
      )
      .first();
    if (await titleField.count()) {
      await titleField.click();
      await titleField.fill(title);
      await sleep(500);
    }

    // Địa điểm / Location
    if (location) {
      const locationField = page
        .locator(
          "input[id*='location'], input[placeholder*='location'], input[aria-label*='Location'], input[aria-label*='Địa điểm']",
        )
        .first();
      if (await locationField.count()) {
        await locationField.click();
        await locationField.fill(location);
        await sleep(1500);
        // Chọn gợi ý đầu tiên từ dropdown
        const suggestion = page.locator(".basic-typeahead__selectable, [role='option']").first();
        if (await suggestion.count()) await suggestion.click();
        await sleep(500);
      }
    }

    // Mô tả công việc
    if (description) {
      // LinkedIn dùng contenteditable editor cho description
      const descField = page
        .locator(
          ".ql-editor, [contenteditable='true'][aria-label*='description'], [contenteditable='true'][aria-label*='mô tả'], textarea[id*='description']",
        )
        .first();
      if (await descField.count()) {
        await descField.click();
        await descField.fill(description);
        await sleep(500);
      }
    }

    // Lấy URL hiện tại trước khi submit để so sánh
    const urlBefore = page.url();

    // Tìm nút Submit / Post / Đăng
    const submitBtn = page.getByRole("button", { name: /post|đăng|submit|tiếp theo|next/i }).last();
    if (await submitBtn.count()) {
      console.error("→ Nhấn nút đăng bài...");
      await submitBtn.click();
      await sleep(3000);
    } else {
      return {
        success: false,
        error: "Không tìm thấy nút đăng bài. Giao diện LinkedIn có thể đã thay đổi.",
      };
    }

    // Kiểm tra kết quả — nếu URL thay đổi hoặc có thông báo thành công
    const urlAfter = page.url();
    const pageTitle = await page.title();

    // LinkedIn thường redirect về trang job sau khi đăng thành công
    const jobUrl = urlAfter.includes("/jobs/view/") ? urlAfter : undefined;

    return {
      success: true,
      jobUrl,
      pageTitle,
      note: jobUrl
        ? `Bài đăng thành công! URL: ${jobUrl}`
        : "Đã nhấn đăng bài. Hãy kiểm tra LinkedIn để xác nhận.",
    };
  } finally {
    await browser.disconnect();
  }
}

// ============================================================
// 4. Gửi tin nhắn (stub — cần implement thêm)
// ============================================================
function linkedinSendMessage(url, message) {
  console.error(`--- Gửi tin nhắn (stub): ${url} ---`);
  return { status: "success", recipient: url, message_preview: message.slice(0, 50) };
}

// ============================================================
// 5. Mở trình duyệt (để người dùng đăng nhập)
// ============================================================
async function openBrowserUrl(url, cdpUrl) {
  console.error(`--- Mở trình duyệt tại: ${url} ---`);
  const { browser, page } = await connectPage(cdpUrl);
  try {
    await page.goto(url, { timeout: 60_000 });
    return { success: true, message: "Trình duyệt đã được mở. Vui lòng đăng nhập." };
  } finally {
    // Không dùng close() vì sẽ đóng cả trình duyệt thật.
    // Dùng disconnect() để ngắt kết nối CDP client nhưng giữ lại cửa sổ.
    await browser.disconnect();
  }
}

// ============================================================
// 6. Quản lý session file (để vclaw-ui gọi qua Gateway)
// ============================================================
function getSessionFromFile() {
  if (fs.existsSync(SESSION_FILE)) {
    return { success: true, data: fs.readFileSync(SESSION_FILE, "utf-8"), file: SESSION_FILE };
  }
  return { success: false, error: "Không tìm thấy file session" };
}

function saveSessionToFile(data) {
  try {
    fs.writeFileSync(SESSION_FILE, data, "utf-8");
    return { success: true, file: SESSION_FILE };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// ============================================================
// Main
// ============================================================
async function main() {
  const cli = parseCli(process.argv.slice(2));
  const { action, query, url, message, title, description, location, companyUrl, cdpUrl } = cli;

  const VALID_ACTIONS = [
    "search",
    "get_profile",
    "send_message",
    "create_job_post",
    "open_browser",
    "get_session",
    "save_session",
  ];
  if (!action || !VALID_ACTIONS.includes(action)) {
    console.error(
      `Usage: node scripts/linkedin-manager.mjs <${VALID_ACTIONS.join("|")}> [options]`,
    );
    process.exit(1);
  }

  try {
    if (action === "search") {
      if (!query) {
        console.error("Error: --query bắt buộc");
        process.exit(1);
      }
      console.log(JSON.stringify(await linkedinSearch(query, cdpUrl), null, 2));
    } else if (action === "get_profile") {
      // linkedinGetProfile đã handle url null → /me
      console.log(JSON.stringify(await linkedinGetProfile(url, cdpUrl), null, 2));
    } else if (action === "send_message") {
      if (!url || !message) {
        console.error("Error: --url và --message bắt buộc");
        process.exit(1);
      }
      console.log(JSON.stringify(linkedinSendMessage(url, message), null, 2));
    } else if (action === "create_job_post") {
      if (!title) {
        console.error("Error: --title bắt buộc");
        process.exit(1);
      }
      const result = await linkedinCreateJobPost({
        title,
        description,
        location,
        companyUrl,
        cdpUrl,
      });
      console.log(JSON.stringify(result, null, 2));
    } else if (action === "open_browser") {
      if (!url) {
        console.error("Error: --url bắt buộc");
        process.exit(1);
      }
      const result = await openBrowserUrl(url, cdpUrl);
      console.log(JSON.stringify(result, null, 2));
    } else if (action === "get_session") {
      console.log(JSON.stringify(getSessionFromFile(), null, 2));
    } else if (action === "save_session") {
      // save_session mong đợi dữ liệu qua message hoặc một flag khác,
      // nhưng ở đây ta dùng message làm data truyền vào
      if (!message) {
        console.error("Error: --message (data) bắt buộc");
        process.exit(1);
      }
      console.log(JSON.stringify(saveSessionToFile(message), null, 2));
    }
  } catch (e) {
    console.log(
      JSON.stringify(
        {
          success: false,
          error: e.message || String(e),
        },
        null,
        2,
      ),
    );
    process.exit(0); // Exit 0 để Gateway nhận được JSON thay vì lỗi crash 500
  }
}

await main();
