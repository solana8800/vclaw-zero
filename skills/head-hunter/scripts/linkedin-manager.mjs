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
 *   create_feed_post --title "..." --description "..." --target personal|company [--company-url "..."] [--image-path "..."]
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
    target: null,
    imagePath: null,
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
    else if (a === "--target") out.target = args.shift() ?? null;
    else if (a === "--image-path") out.imagePath = args.shift() ?? null;
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

/** Ngắt client CDP — không đóng cửa sổ Chrome thật. */
async function releaseCdpBrowser(browser) {
  if (!browser) return;
  if (typeof browser.disconnect === "function") {
    await browser.disconnect();
    return;
  }
  if (typeof browser.close === "function") {
    await browser.close();
  }
}

/** Trích slug hoặc numeric id từ URL Company Page (public hoặc admin). */
function parseCompanyIdFromUrl(companyUrl) {
  if (!companyUrl?.trim()) return null;
  const m = companyUrl.trim().match(/linkedin\.com\/company\/([^/?#]+)/i);
  const id = m?.[1] ?? null;
  if (!id || id === "admin") return null;
  return id;
}

/** Các URL admin Company Page (LinkedIn đổi route theo thời gian). */
function buildCompanyAdminUrls(companyId) {
  const base = `https://www.linkedin.com/company/${companyId}/admin`;
  return [
    `${base}/page-posts/published/?share=true`,
    `${base}/page-posts/?share=true`,
    `${base}/page-posts/published/`,
    `${base}/page-posts/`,
    `${base}/feed/?share=true`,
    `${base}/`,
  ];
}

function pageLooksLikeLoginWall(url) {
  return url.includes("login") || url.includes("authwall") || url.includes("checkpoint");
}

function pageIsCompanyAdminContext(url, companyId) {
  if (!url || !companyId) return false;
  if (url.includes("/admin/")) return true;
  return url.includes(`/company/${companyId}`);
}

function buildMarketingPostText(title, description) {
  const parts = [];
  if (title?.trim()) parts.push(title.trim());
  if (description?.trim()) parts.push(description.trim());
  return parts.join("\n\n");
}

/** Modal soạn bài đăng (không phải ô comment trên feed). */
function shareBoxModal(page) {
  return page.locator(
    '[data-test-modal-id="sharebox"], div.share-creation-state, [class*="share-creation-state"]',
  );
}

/** Ô soạn bài trong modal sharebox (không dùng .last() — tránh ô Comment trên feed). */
function postComposerEditor(page) {
  return page
    .locator(
      [
        '[data-test-modal-id="sharebox"] [contenteditable="true"][aria-label*="creating content" i]',
        '[data-test-modal-id="sharebox"] [data-test-ql-editor-contenteditable="true"]',
        '[data-test-modal-id="sharebox"] .share-creation-state .ql-editor',
        '.share-creation-state .ql-editor[contenteditable="true"]',
      ].join(", "),
    )
    .first();
}

async function isShareEditorVisible(page) {
  const sharebox = page.locator('[data-test-modal-id="sharebox"]');
  if (!(await sharebox.count())) return false;
  const editor = postComposerEditor(page);
  if (!(await editor.count())) return false;
  return editor.isVisible().catch(() => false);
}

async function openShareComposer(page) {
  if (await isShareEditorVisible(page)) {
    return true;
  }

  const roleBtn = page.getByRole("button", {
    name: /Start a post|Bắt đầu đăng|Viết bài|Create a post|Create post|Write|Đăng bài|Share|Đăng|Post/i,
  });
  if (await roleBtn.count()) {
    await roleBtn.first().click();
    await sleep(2500);
    if (await isShareEditorVisible(page)) return true;
  }

  const ariaStart = page.locator(
    "[aria-label='Start a post'], [aria-label='Bắt đầu đăng bài'], [aria-label*='Create a post' i], [aria-label*='Viết bài' i]",
  );
  if (await ariaStart.count()) {
    await ariaStart.first().click();
    await sleep(2500);
    if (await isShareEditorVisible(page)) return true;
  }

  const companyCreate = page.locator(
    "button[data-control-name='page_admin_share_post'], a[data-control-name='page_admin_share_post']",
  );
  if (await companyCreate.count()) {
    await companyCreate.first().click();
    await sleep(2500);
    if (await isShareEditorVisible(page)) return true;
  }

  const inline = page
    .locator(
      "[contenteditable='true'][role='textbox'], [data-placeholder*='post' i], .share-box__textarea, .ql-editor",
    )
    .first();
  if (await inline.count()) {
    await inline.click();
    await sleep(500);
    return true;
  }
  return false;
}

/** Thử lần lượt URL admin Company Page cho đến khi mở được composer. */
async function navigateCompanyPageForPosting(page, companyUrl) {
  const companyId = parseCompanyIdFromUrl(companyUrl);
  if (!companyId) {
    return {
      ok: false,
      error: "Thiếu hoặc sai link Company Page (vd: https://www.linkedin.com/company/ten-page/).",
    };
  }

  const tried = [];
  for (const adminUrl of buildCompanyAdminUrls(companyId)) {
    tried.push(adminUrl);
    console.error(`→ Thử trang admin Company Page: ${adminUrl}`);
    await page.goto(adminUrl, { timeout: 90_000 });
    await page.waitForLoadState("domcontentloaded").catch(() => null);
    await sleep(4000);

    const currentUrl = page.url();
    if (pageLooksLikeLoginWall(currentUrl)) {
      return { ok: false, error: "Chưa đăng nhập LinkedIn. Hãy đăng nhập vào trình duyệt." };
    }

    const resolvedId = parseCompanyIdFromUrl(currentUrl) || companyId;
    if (
      !pageIsCompanyAdminContext(currentUrl, resolvedId) &&
      !pageIsCompanyAdminContext(currentUrl, companyId)
    ) {
      console.error(`⚠️ URL sau điều hướng không giống admin page: ${currentUrl}`);
    }

    if ((await isShareEditorVisible(page)) || (await openShareComposer(page))) {
      return { ok: true, companyId: resolvedId, landedUrl: currentUrl };
    }
  }

  return {
    ok: false,
    error: `Không mở được ô soạn bài Company Page (id: ${companyId}). Kiểm tra quyền admin và thử đăng nhập lại. URL đã thử: ${tried.join(" → ")}`,
    companyId,
  };
}

async function fillShareEditor(page, text) {
  await page
    .locator('[data-test-modal-id="sharebox"]')
    .waitFor({ state: "visible", timeout: 15_000 })
    .catch(() => null);

  let editor = postComposerEditor(page);
  if (!(await editor.count())) {
    console.error("⚠️ Chưa thấy sharebox composer — thử mở lại modal.");
    return false;
  }

  const placeholder =
    (await editor.getAttribute("aria-placeholder").catch(() => null)) ||
    (await editor.getAttribute("data-placeholder").catch(() => null)) ||
    "";
  if (/comment/i.test(placeholder)) {
    console.error("⚠️ Bỏ qua ô Comment, chờ composer đăng bài.");
    editor = page
      .locator(
        '[data-test-modal-id="sharebox"] [aria-label*="creating content" i][contenteditable="true"]',
      )
      .first();
  }

  if (!(await editor.count())) return false;

  // Gán nội dung trực tiếp — tránh overlay/modal chặn click Playwright
  const filledViaDom = await editor
    .evaluate((el, content) => {
      if (!el || !content) return false;
      const ph = el.getAttribute("aria-placeholder") || el.getAttribute("data-placeholder") || "";
      if (/comment/i.test(ph)) return false;
      el.focus();
      el.innerHTML = "";
      el.textContent = content;
      el.dispatchEvent(new InputEvent("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return (el.textContent || "").trim().length >= Math.min(20, content.length);
    }, text)
    .catch(() => false);

  if (filledViaDom) {
    await sleep(500);
    return true;
  }

  // Fallback: focus trong modal sharebox (force) rồi gõ
  const modalBody = page.locator(
    '[data-test-modal-id="sharebox"] .share-creation-state__content-scrollable, [data-test-modal-id="sharebox"] .share-creation-state',
  );
  if (await modalBody.count()) {
    await modalBody
      .first()
      .click({ force: true, timeout: 10_000 })
      .catch(() => null);
  }
  await editor.click({ force: true, timeout: 10_000 }).catch(() => null);
  await page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A");
  await page.keyboard.insertText(text);
  await sleep(800);

  const len = await editor.evaluate((el) => (el.textContent || "").trim().length).catch(() => 0);
  return len > 0;
}

async function attachImageToComposer(page, imagePath) {
  if (!imagePath?.trim() || !fs.existsSync(imagePath)) {
    console.error("⚠️ Không có file ảnh — chỉ đăng text.");
    return false;
  }

  const modal = page.locator('[data-test-modal-id="sharebox"]');
  const scope = (await modal.count()) ? modal : page;

  const photoBtn = scope.getByRole("button", {
    name: /Add a photo|Add image|Photo|Image|Thêm ảnh|Hình ảnh|Media/i,
  });
  if (await photoBtn.count()) {
    await photoBtn
      .first()
      .click({ force: true })
      .catch(() => null);
    await sleep(1500);
  }

  const fileInput = scope.locator('input[type="file"]').last();
  if (!(await fileInput.count())) {
    console.error("⚠️ Không tìm thấy input upload ảnh.");
    return false;
  }

  await fileInput.setInputFiles(path.resolve(imagePath));
  await sleep(4000);
  console.error(`→ Đã đính kèm ảnh: ${imagePath}`);
  return true;
}

async function clickPublishPost(page) {
  const modal = page.locator('[data-test-modal-id="sharebox"]');
  const scope = (await modal.count()) ? modal : page;
  const patterns = [/^Post$/i, /^Đăng$/i, /^Publish$/i, /^Xuất bản$/i];

  for (const pattern of patterns) {
    const postBtn = scope.getByRole("button", { name: pattern });
    const count = await postBtn.count();
    for (let i = count - 1; i >= 0; i--) {
      const btn = postBtn.nth(i);
      const visible = await btn.isVisible().catch(() => false);
      const enabled = await btn.isEnabled().catch(() => true);
      if (visible && enabled) {
        await btn.click({ force: true });
        await sleep(5000);
        return true;
      }
    }
  }

  const fallback = scope.locator("button").filter({ hasText: /^(Post|Đăng|Publish|Xuất bản)$/i });
  if (!(await fallback.count())) return false;
  await fallback.last().click({ force: true });
  await sleep(5000);
  return true;
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
    await releaseCdpBrowser(browser);
  }
}

/** Cuộn profile để lazy-load Experience / Education / Skills. */
async function scrollProfileForSections(page) {
  const steps = [0, 600, 1200, 2000, 2800, 0];
  for (const y of steps) {
    await page.evaluate((scrollY) => window.scrollTo(0, scrollY), y);
    await sleep(450);
  }
}

/** Trích danh sách text từ section LinkedIn (#experience, #education, …). */
async function extractProfileListSection(page, sectionId) {
  return page.evaluate((id) => {
    const anchor = document.getElementById(id);
    if (!anchor) return [];
    const section = anchor.closest("section") || anchor.parentElement;
    if (!section) return [];
    const out = [];
    const nodes = section.querySelectorAll(
      "li.pvs-list__paged-list-item, li.artdeco-list__item, div.pvs-entity, div[data-view-name='profile-component-entity']",
    );
    nodes.forEach((node) => {
      const text = (node.innerText || "").replace(/\s+/g, " ").trim();
      if (text.length < 12) return;
      out.push(text.slice(0, 700));
    });
    return [...new Set(out)].slice(0, 15);
  }, sectionId);
}

async function extractProfileSkills(page) {
  return page.evaluate(() => {
    const anchor = document.getElementById("skills");
    if (!anchor) return [];
    const section = anchor.closest("section") || anchor.parentElement;
    if (!section) return [];
    const skills = [];
    const selectors = [
      'a[data-field="skill_card_skill_topic"]',
      ".pv-skill-category-entity__name-text",
      "span.pvs-entity__text--bold",
    ];
    for (const sel of selectors) {
      section.querySelectorAll(sel).forEach((el) => {
        const t = (el.textContent || "").trim();
        if (t.length > 1 && t.length < 80) skills.push(t);
      });
    }
    if (skills.length === 0) {
      const blob = (section.innerText || "").replace(/\s+/g, " ").trim();
      if (blob.length > 20) {
        blob
          .split(/[,•·|]/)
          .map((s) => s.trim())
          .filter((s) => s.length > 2 && s.length < 60)
          .forEach((s) => skills.push(s));
      }
    }
    return [...new Set(skills)].slice(0, 40);
  });
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

      let location = "N/A";
      const locationEl = page
        .locator(
          ".pv-top-card--list .text-body-small, .pv-text-details__left-panel .text-body-small, span.text-body-small.inline.t-black--light",
        )
        .first();
      if (await locationEl.count()) {
        location = (await locationEl.innerText()).trim().split("\n")[0];
      }

      const avatarEl = page
        .locator(
          "img.pv-top-card-profile-picture__image, .feed-identity-module__actor-meta img, img.profile-photo-edit__preview",
        )
        .first();
      if (await avatarEl.count()) {
        avatarUrl = (await avatarEl.getAttribute("src")) || null;
      }

      // Mở rộng About trước khi scrape — tránh chỉ lấy đoạn đầu + "…see more"
      const aboutExpandSelectors = [
        "section:has(#about) button.inline-show-more-text",
        "#about ~ div button:has-text('see more')",
        "#about ~ div button:has-text('…see more')",
        "section:has(#about) button:has-text('Xem thêm')",
      ];
      for (const sel of aboutExpandSelectors) {
        const btn = page.locator(sel).first();
        if (await btn.isVisible({ timeout: 600 }).catch(() => false)) {
          await btn.click().catch(() => {});
          await page.waitForTimeout(500);
          break;
        }
      }

      const aboutEl = page
        .locator(
          "section:has(#about) div.inline-show-more-text, #about ~ div.display-flex, .pv-about-section",
        )
        .first();
      let about = (await aboutEl.count()) ? (await aboutEl.innerText()).trim() : "N/A";
      if (about !== "N/A") {
        about = about
          .replace(/\u2026\s*see more/gi, "")
          .replace(/\.\.\.\s*see more/gi, "")
          .replace(/\s*see more\s*$/gim, "")
          .replace(/\s*xem thêm\s*$/gim, "")
          .trim();
      }

      await scrollProfileForSections(page);
      const [experiences, education, skills, projects, languages, recommendations] =
        await Promise.all([
          extractProfileListSection(page, "experience"),
          extractProfileListSection(page, "education"),
          extractProfileSkills(page),
          extractProfileListSection(page, "projects"),
          extractProfileListSection(page, "languages"),
          extractProfileListSection(page, "recommendations"),
        ]);

      let connectionStatus = "UNKNOWN";
      try {
        const connectBtn = page.getByRole("button", { name: /^(Connect|Kết nối)$/i }).first();
        const pendingBtn = page
          .getByRole("button", { name: /^(Pending|Đang chờ|Đã gửi)$/i })
          .first();
        const messageBtn = page.getByRole("button", { name: /^(Message|Nhắn tin)$/i }).first();
        if (await messageBtn.isVisible().catch(() => false)) {
          connectionStatus = "CONNECTED";
        } else if (await pendingBtn.isVisible().catch(() => false)) {
          connectionStatus = "PENDING";
        } else if (await connectBtn.isVisible().catch(() => false)) {
          connectionStatus = "NOT_CONNECTED";
        }
      } catch {
        /* bỏ qua */
      }

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
        location,
        experiences,
        education,
        skills,
        projects,
        languages,
        recommendations,
        url: profileUrl,
        avatarUrl,
        connectionStatus,
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
    await releaseCdpBrowser(browser);
  }
}

// ============================================================
// 3. Đăng bài marketing — feed cá nhân hoặc Company Page
//    KHÔNG dùng Job Post trả phí (job-posting/v2).
// ============================================================
async function linkedinCreateFeedPost({
  title,
  description,
  target,
  companyUrl,
  imagePath,
  cdpUrl,
}) {
  const postTarget =
    target === "company" || target === "personal" ? target : companyUrl ? "company" : "personal";
  const postText = buildMarketingPostText(title, description);

  if (!postText.trim()) {
    return { success: false, error: "Nội dung bài đăng trống." };
  }

  console.error(`--- Đăng bài marketing LinkedIn (${postTarget}) ---`);
  const { browser, page } = await connectPage(cdpUrl);

  try {
    if (postTarget === "company") {
      const nav = await navigateCompanyPageForPosting(page, companyUrl);
      if (!nav.ok) {
        return { success: false, error: nav.error };
      }
      console.error(`→ Đã vào admin Company Page: ${nav.landedUrl}`);
    } else {
      console.error("→ Mở feed cá nhân (tài khoản đang đăng nhập trên Chrome)");
      await page.goto("https://www.linkedin.com/feed/", { timeout: 90_000 });
      await page.waitForLoadState("domcontentloaded").catch(() => null);
      await sleep(5000);

      const currentUrl = page.url();
      if (pageLooksLikeLoginWall(currentUrl)) {
        return { success: false, error: "Chưa đăng nhập LinkedIn. Hãy đăng nhập vào trình duyệt." };
      }

      if (!(await openShareComposer(page))) {
        return {
          success: false,
          error: "Không mở được ô soạn bài trên feed cá nhân.",
        };
      }
    }

    if (!(await fillShareEditor(page, postText))) {
      return { success: false, error: "Không điền được nội dung bài đăng." };
    }

    let imageAttached = false;
    if (imagePath) {
      imageAttached = await attachImageToComposer(page, imagePath);
    }

    if (!(await clickPublishPost(page))) {
      return { success: false, error: "Không nhấn được nút Post/Đăng." };
    }

    const urlAfter = page.url();
    const postUrl =
      urlAfter.includes("/feed/update/") ||
      urlAfter.includes("/posts/") ||
      urlAfter.includes("/page-posts/") ||
      urlAfter.includes("/admin/page-posts/")
        ? urlAfter.split("?")[0]
        : undefined;

    return {
      success: true,
      target: postTarget,
      companyUrl: postTarget === "company" ? companyUrl : null,
      postUrl,
      imageAttached,
      pageTitle: await page.title(),
      note: postUrl
        ? `Đã đăng bài marketing${imageAttached ? " kèm ảnh" : ""}. URL: ${postUrl}`
        : `Đã nhấn đăng bài${imageAttached ? " kèm ảnh" : ""}. Kiểm tra feed trên LinkedIn.`,
    };
  } finally {
    await releaseCdpBrowser(browser);
  }
}

// ============================================================
// 4. Gửi tin nhắn LinkedIn (CDP)
// ============================================================
function msgComposerEditor(page) {
  return page
    .locator(
      '.msg-form__contenteditable[contenteditable="true"], div.msg-form__msg-content-container [contenteditable="true"], [data-artdeco-is-focused="true"][contenteditable="true"], div[role="textbox"][contenteditable="true"]',
    )
    .first();
}

async function fillMessageComposer(page, text) {
  await page
    .locator(".msg-overlay-conversation-bubble, .msg-form, [data-test-id='msg-form']")
    .first()
    .waitFor({ state: "visible", timeout: 20_000 })
    .catch(() => null);

  let editor = msgComposerEditor(page);
  if (!(await editor.count())) {
    editor = page
      .locator('[contenteditable="true"]')
      .filter({ hasNot: page.locator('[data-test-modal-id="sharebox"] *') })
      .first();
  }
  if (!(await editor.count())) return false;

  const filled = await editor
    .evaluate((el, content) => {
      if (!el || !content) return false;
      el.focus();
      el.innerHTML = "";
      el.textContent = content;
      el.dispatchEvent(new InputEvent("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return (el.textContent || "").trim().length >= Math.min(5, content.length);
    }, text)
    .catch(() => false);

  if (filled) return true;

  await editor.click({ force: true }).catch(() => {});
  await sleep(300);
  await page.keyboard.insertText(text).catch(() => {});
  const after = await editor.innerText().catch(() => "");
  return after.trim().length >= Math.min(5, text.length);
}

async function clickSendMessage(page) {
  const scopes = [
    page.locator(".msg-form__send-button"),
    page.getByRole("button", { name: /^(Send|Gửi)$/i }),
    page.locator('button[type="submit"]').filter({ hasText: /^(Send|Gửi)$/i }),
  ];
  for (const btn of scopes) {
    const loc = btn.first();
    if (await loc.isVisible({ timeout: 2000 }).catch(() => false)) {
      if (await loc.isEnabled().catch(() => false)) {
        await loc.click();
        await sleep(1500);
        return true;
      }
    }
  }
  return false;
}

async function linkedinSendMessage(url, message, cdpUrl) {
  console.error(`--- Gửi tin nhắn LinkedIn: ${url} ---`);
  let profileUrl = (url || "").split("?")[0];
  if (!profileUrl.includes("/in/")) {
    return { success: false, error: "URL profile không hợp lệ." };
  }
  if (!profileUrl.startsWith("http")) {
    profileUrl = `https://www.linkedin.com${profileUrl}`;
  }

  const { browser, page } = await connectPage(cdpUrl);
  try {
    await page.goto(profileUrl, { timeout: 60_000 });
    await page.waitForLoadState("domcontentloaded").catch(() => null);
    await sleep(2000);

    const currentUrl = page.url();
    if (currentUrl.includes("login") || currentUrl.includes("authwall")) {
      return { success: false, error: "Chưa đăng nhập LinkedIn trên Chrome CDP." };
    }

    const connectBtn = page.getByRole("button", { name: /^(Connect|Kết nối)$/i }).first();
    const messageBtn = page
      .getByRole("button", { name: /^(Message|Nhắn tin)$/i })
      .or(page.getByRole("link", { name: /^(Message|Nhắn tin)$/i }))
      .first();

    if (!(await messageBtn.isVisible({ timeout: 12_000 }).catch(() => false))) {
      if (await connectBtn.isVisible().catch(() => false)) {
        return {
          success: false,
          error:
            "Chưa kết nối với ứng viên — không có nút Nhắn tin. Gửi lời mời kết nối trên LinkedIn trước.",
        };
      }
      return { success: false, error: "Không thấy nút Nhắn tin trên profile." };
    }

    await messageBtn.click();
    await sleep(3500);

    if (!(await fillMessageComposer(page, message))) {
      return { success: false, error: "Không điền được nội dung tin nhắn trong hộp thoại." };
    }

    let sent = await clickSendMessage(page);
    if (!sent) {
      await page.keyboard.press("Control+Enter").catch(() => {});
      await page.keyboard.press("Meta+Enter").catch(() => {});
      await sleep(1200);
      sent = await clickSendMessage(page);
    }
    if (!sent) {
      return { success: false, error: "Không nhấn được nút Gửi — kiểm tra LinkedIn messaging UI." };
    }

    return {
      success: true,
      recipient: profileUrl,
      message_preview: message.slice(0, 80),
      note: "Đã nhấn Gửi trên LinkedIn. Kiểm tra hộp thoại nếu cần.",
    };
  } catch (e) {
    return { success: false, error: `Lỗi gửi tin: ${e.message}` };
  } finally {
    await releaseCdpBrowser(browser);
  }
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
    await releaseCdpBrowser(browser);
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
  const {
    action,
    query,
    url,
    message,
    title,
    description,
    location,
    companyUrl,
    target,
    imagePath,
    cdpUrl,
  } = cli;

  const VALID_ACTIONS = [
    "search",
    "get_profile",
    "send_message",
    "create_feed_post",
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
      console.log(JSON.stringify(await linkedinSendMessage(url, message, cdpUrl), null, 2));
    } else if (action === "create_feed_post") {
      if (!title && !description) {
        console.error("Error: cần --title hoặc --description");
        process.exit(1);
      }
      const postTarget =
        target === "company" || target === "personal"
          ? target
          : companyUrl
            ? "company"
            : "personal";
      const result = await linkedinCreateFeedPost({
        title,
        description,
        target: postTarget,
        companyUrl: postTarget === "company" ? companyUrl : null,
        imagePath,
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
