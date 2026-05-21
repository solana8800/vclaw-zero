#!/usr/bin/env node
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
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
import {
  linkedInConnectButtonName,
  linkedInConnectLabelFragment,
  linkedInMessageButtonName,
  linkedInMoreButtonName,
  linkedInPendingButtonName,
  linkedInProfileActionElementSelector,
  linkedInSendInvitationButtonName,
} from "./linkedin-action-selectors.mjs";
import { applyLinkedInProfileExtractionTemplate } from "./linkedin-profile-extractors.mjs";
import { applyLinkedInSearchExtractionTemplate } from "./linkedin-search-extractors.mjs";
import { buildLinkedInConnectRequest } from "./linkedin-voyager-connect.mjs";
import {
  buildLinkedInDashMessageRequest,
  parseLinkedInMessagingThreadId,
} from "./linkedin-voyager-message.mjs";
import {
  buildLinkedInAutomationPopupFeatures,
  shouldFocusLinkedInAutomationPage,
} from "./linkedin-window-policy.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SESSION_FILE = path.join(os.homedir(), ".openclaw", "workspace", "linkedin-session.json");
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const LINKEDIN_TEMPLATES_FILE = path.resolve(
  SCRIPT_DIR,
  "..",
  "templates",
  "linkedin",
  "linkedin-templates.v1.json",
);
let cachedLinkedInTemplates = null;

function loadLinkedInTemplate(name) {
  if (!cachedLinkedInTemplates) {
    cachedLinkedInTemplates = JSON.parse(fs.readFileSync(LINKEDIN_TEMPLATES_FILE, "utf8"));
  }
  return cachedLinkedInTemplates?.templates?.[name] ?? null;
}

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
    threadId: null,
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
    else if (a === "--thread-id" || a === "--threadId") out.threadId = args.shift() ?? null;
    else if (a === "--cdp-url") out.cdpUrl = args.shift() ?? out.cdpUrl;
  }
  return out;
}

function isVclawAppPage(url) {
  return /^https?:\/\/(?:127\.0\.0\.1|localhost):\d+(?:\/|$)/.test(url);
}

function isLinkedInPage(url) {
  return /^https?:\/\/(?:[\w-]+\.)?linkedin\.com(?:\/|$)/i.test(url);
}

async function connectBrowser(cdpUrl) {
  const base = cdpUrl.replace(/\/$/, "");
  try {
    const res = await fetch(`${base}/json/version`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const versionInfo = await res.json();
    const wsUrl = versionInfo.webSocketDebuggerUrl;
    if (!wsUrl) throw new Error("Phản hồi CDP thiếu webSocketDebuggerUrl");
    const browser = await chromium.connectOverCDP(wsUrl);
    const context = browser.contexts()[0] ?? (await browser.newContext());
    return { browser, context };
  } catch (e) {
    throw new Error(
      `Không thể kết nối Chrome (CDP: ${base}). Hãy đảm bảo Chrome đang chạy với --remote-debugging-port=9222. Chi tiết: ${e.message}`,
    );
  }
}

function pickAutomationPage(context) {
  const pages = context.pages();
  return (
    pages.find((candidate) => isLinkedInPage(candidate.url())) ??
    pages.find((candidate) => {
      const url = candidate.url();
      return url === "about:blank" || !isVclawAppPage(url);
    }) ??
    null
  );
}

async function openAutomationPageFromApp(context, url) {
  const appPage = context.pages().find((candidate) => isVclawAppPage(candidate.url()));
  if (!appPage) {
    throw new Error("Không tìm thấy cửa sổ VClaw để mở cửa sổ LinkedIn riêng.");
  }

  const popupPromise = context.waitForEvent("page", { timeout: 10_000 }).catch(() => null);
  const features = buildLinkedInAutomationPopupFeatures();
  await appPage.evaluate(
    ({ targetUrl, popupFeatures }) => {
      window.open(targetUrl, "_blank", popupFeatures);
    },
    { targetUrl: url, popupFeatures: features },
  );
  return (await popupPromise) ?? pickAutomationPage(context);
}

async function connectPage(cdpUrl, options = {}) {
  const { browser, context } = await connectBrowser(cdpUrl);
  try {
    let page = pickAutomationPage(context);
    if (!page) {
      page = await openAutomationPageFromApp(context, "https://www.linkedin.com/feed/");
    }
    if (!page) {
      throw new Error("Không mở được cửa sổ LinkedIn riêng.");
    }
    if (shouldFocusLinkedInAutomationPage(options)) {
      await page.bringToFront().catch(() => {});
    }
    return { browser, page };
  } catch (e) {
    await releaseCdpBrowser(browser).catch(() => {});
    throw e;
  }
}

async function connectOrOpenPage(cdpUrl, url, options = {}) {
  const { browser, context } = await connectBrowser(cdpUrl);
  try {
    let page = pickAutomationPage(context);
    if (!page) {
      page = await openAutomationPageFromApp(context, url);
    }

    if (!page) {
      throw new Error("Không mở được cửa sổ LinkedIn riêng.");
    }
    if (shouldFocusLinkedInAutomationPage(options)) {
      await page.bringToFront().catch(() => {});
    }
    return { browser, page };
  } catch (e) {
    await releaseCdpBrowser(browser).catch(() => {});
    throw e;
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

function profileAction(page, name) {
  return page.getByRole("button", { name }).or(page.getByRole("link", { name })).first();
}

function connectActionFallback(page) {
  return page
    .locator(
      [
        'button[aria-label^="Connect"]',
        'button[aria-label^="Kết nối"]',
        'button[aria-label*=" to connect" i]',
        'button[aria-label*="kết nối" i]',
        'a[aria-label^="Connect"]',
        'a[aria-label^="Kết nối"]',
        'a[aria-label*=" to connect" i]',
        'a[aria-label*="kết nối" i]',
        'div[role="button"][aria-label^="Connect"]',
        'div[role="button"][aria-label^="Kết nối"]',
        'div[role="button"][aria-label*=" to connect" i]',
        'div[role="button"][aria-label*="kết nối" i]',
      ].join(", "),
    )
    .first();
}

function profileTextActionFallback(page, name) {
  return page.locator(linkedInProfileActionElementSelector).filter({ hasText: name }).first();
}

function messageActionFallback(page) {
  return page
    .locator(
      [
        'button[aria-label^="Message"]',
        'button[aria-label^="Nhắn tin"]',
        'a[aria-label^="Message"]',
        'a[aria-label^="Nhắn tin"]',
      ].join(", "),
    )
    .first();
}

function normalizeLinkedInHref(href) {
  const value = String(href || "").trim();
  if (!value) return null;
  if (value.startsWith("http://") || value.startsWith("https://")) return value;
  if (value.startsWith("/")) return `https://www.linkedin.com${value}`;
  return null;
}

function isLinkedInConnectInviteHref(href) {
  const value = String(href || "");
  return (
    value.includes("/preload/custom-invite/") ||
    value.includes("/mynetwork/invite-connect/connections/")
  );
}

async function openConnectInviteFromLocator(page, locator) {
  const href = normalizeLinkedInHref(await locator.getAttribute("href").catch(() => null));
  if (!href || !isLinkedInConnectInviteHref(href)) return false;
  console.error(`[sendConnect] mở form lời mời qua href: ${href}`);
  await page.goto(href, { timeout: 60_000 });
  await page.waitForLoadState("domcontentloaded").catch(() => null);
  await sleep(1200);
  return true;
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
const LINKEDIN_SEARCH_MAX = Math.min(
  Math.max(Number(process.env.LINKEDIN_SEARCH_MAX || 10) || 10, 1),
  25,
);

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

    const searchTemplate = loadLinkedInTemplate("searchPeople") || {};
    const cardSelectors = Array.isArray(searchTemplate.cardSelectors)
      ? searchTemplate.cardSelectors
      : [];
    let selectors = [];
    for (const selector of cardSelectors) {
      selectors = await page.locator(selector).all();
      if (selectors.length) break;
    }
    if (selectors.length === 0)
      selectors = await page.locator(".reusable-search__result-container").all();
    if (selectors.length === 0) selectors = await page.locator(".entity-result").all();
    if (selectors.length === 0) selectors = await page.locator("div:has(a[href*='/in/'])").all();

    console.error(`--- Tìm thấy ${selectors.length} thẻ DOM ---`);

    const templatedResults = await applyLinkedInSearchExtractionTemplate({
      template: searchTemplate,
      cards: selectors,
    });

    const seen = new Set();
    const results = [];
    for (const [index, sel] of selectors.entries()) {
      if (results.length >= LINKEDIN_SEARCH_MAX) break;
      const templatedResult = templatedResults[index] || {};
      try {
        let name = templatedResult.name || "N/A";
        let href = templatedResult.profile_url || null;
        if (!href) {
          let nameEl = sel.locator(".entity-result__title-text a, .actor-name").first();
          if (!(await nameEl.count())) nameEl = sel.locator("a[href*='/in/']").first();
          if (!(await nameEl.count())) continue;

          name = (await nameEl.innerText()).split("\n")[0].trim();
          href = await nameEl.getAttribute("href");
        }
        if (!href) continue;
        let profileUrl = href.split("?")[0];
        if (!profileUrl.startsWith("http")) profileUrl = `https://www.linkedin.com${profileUrl}`;
        if (!profileUrl.includes("/in/") || seen.has(profileUrl)) continue;
        seen.add(profileUrl);

        let headline = templatedResult.headline || "N/A";
        if (headline === "N/A") {
          const headlineEl = sel
            .locator(".entity-result__primary-subtitle, .subline-level-1")
            .first();
          headline = (await headlineEl.count()) ? (await headlineEl.innerText()).trim() : "N/A";
        }

        let location = templatedResult.location || "N/A";
        if (location === "N/A") {
          const locationEl = sel
            .locator(".entity-result__secondary-subtitle, .subline-level-2")
            .first();
          location = (await locationEl.count()) ? (await locationEl.innerText()).trim() : "N/A";
        }

        results.push({
          name,
          headline,
          profile_url: profileUrl,
          profile_id_url: null,
          location,
        });
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
      const pageText = await page.evaluate(() => document.body?.innerText || "").catch(() => "");

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
      const [
        selectorExperiences,
        selectorEducation,
        selectorSkills,
        selectorProjects,
        selectorLanguages,
        selectorRecommendations,
      ] = await Promise.all([
        extractProfileListSection(page, "experience"),
        extractProfileListSection(page, "education"),
        extractProfileSkills(page),
        extractProfileListSection(page, "projects"),
        extractProfileListSection(page, "languages"),
        extractProfileListSection(page, "recommendations"),
      ]);
      const extractedProfile = await applyLinkedInProfileExtractionTemplate({
        template: loadLinkedInTemplate("profile") || {},
        page,
        pageText,
        selectorValues: {
          name,
          headline,
          location,
          about,
          experiences: selectorExperiences,
          education: selectorEducation,
          skills: selectorSkills,
          projects: selectorProjects,
          languages: selectorLanguages,
          recommendations: selectorRecommendations,
        },
      });
      name = extractedProfile.name ?? "N/A";
      headline = extractedProfile.headline ?? "N/A";
      location = extractedProfile.location ?? "N/A";
      about = extractedProfile.about ?? "N/A";
      const experiences = extractedProfile.experiences ?? [];
      const education = extractedProfile.education ?? [];
      const skills = extractedProfile.skills ?? [];
      const projects = extractedProfile.projects ?? [];
      const languages = extractedProfile.languages ?? [];
      const recommendations = extractedProfile.recommendations ?? [];

      let connectionStatus = "UNKNOWN";
      try {
        const connectBtn = profileAction(page, linkedInConnectButtonName)
          .or(connectActionFallback(page))
          .first();
        const pendingBtn = page.getByRole("button", { name: linkedInPendingButtonName }).first();
        const messageBtn = profileAction(page, linkedInMessageButtonName)
          .or(messageActionFallback(page))
          .first();
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

      // Lấy profileUrl từ currentUrl hoặc DOM (không dùng API interception)
      let profileUrl = currentUrl.split("?")[0];
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

      // profileIdUrl: nếu input url khác với profileUrl sau navigate → input là ID URL (/in/ACoAAC...)
      // LinkedIn tự redirect từ ID URL sang slug URL nên currentUrl sẽ là slug
      const normalizeForCompare = (u) =>
        (u || "")
          .replace(/^https?:\/\/(www\.)?linkedin\.com/i, "")
          .replace(/\/$/, "")
          .toLowerCase();
      const inputNorm = normalizeForCompare(url || "");
      const slugNorm = normalizeForCompare(profileUrl);
      let profileIdUrl = null;
      if (inputNorm && inputNorm !== slugNorm && inputNorm.includes("/in/")) {
        // Input url là ID URL — normalize thành absolute
        profileIdUrl = (url || "").startsWith("http")
          ? url.split("?")[0]
          : `https://www.linkedin.com${(url || "").startsWith("/") ? url.split("?")[0] : "/in/" + url.split("?")[0]}`;
        console.error(`[getProfile] profileIdUrl từ input: ${profileIdUrl} → slug: ${profileUrl}`);
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
        url: profileUrl, // slug URL: /in/que-le-ta/
        profileIdUrl, // ID URL: /in/ACoAAC.../  (null nếu API không trả về)
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
// 4. Gửi lời mời kết nối LinkedIn (CDP) — kèm ghi chú tùy chọn (tối đa 300 ký tự)
// ============================================================
async function clickConnectOnProfile(page) {
  const direct = profileAction(page, linkedInConnectButtonName)
    .or(connectActionFallback(page))
    .or(profileTextActionFallback(page, linkedInConnectLabelFragment))
    .first();
  if (await direct.isVisible({ timeout: 4000 }).catch(() => false)) {
    if (await openConnectInviteFromLocator(page, direct)) {
      return true;
    }
    try {
      await direct.click();
      return true;
    } catch (error) {
      if (await openConnectInviteFromLocator(page, direct)) {
        return true;
      }
      await direct.click({ force: true }).catch(() => {});
      await sleep(1200);
      return true;
    }
  }
  const moreBtn = page
    .getByRole("button", { name: linkedInMoreButtonName })
    .or(page.locator('button[aria-label^="More"], button[aria-label^="Thêm"]'))
    .first();
  if (await moreBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
    await moreBtn.click();
    await sleep(800);
    const menuConnect = page
      .getByRole("menuitem", { name: linkedInConnectButtonName })
      .or(page.getByRole("button", { name: linkedInConnectButtonName }))
      .or(page.getByRole("link", { name: linkedInConnectButtonName }))
      .or(page.getByRole("menuitem", { name: linkedInConnectLabelFragment }))
      .or(page.getByRole("button", { name: linkedInConnectLabelFragment }))
      .or(page.getByRole("link", { name: linkedInConnectLabelFragment }))
      .or(connectActionFallback(page))
      .or(profileTextActionFallback(page, linkedInConnectLabelFragment))
      .first();
    if (await menuConnect.isVisible({ timeout: 3000 }).catch(() => false)) {
      if (await openConnectInviteFromLocator(page, menuConnect)) {
        return true;
      }
      try {
        await menuConnect.click();
      } catch {
        if (await openConnectInviteFromLocator(page, menuConnect)) {
          return true;
        }
        await menuConnect.click({ force: true }).catch(() => {});
      }
      await sleep(1200);
      return true;
    }
  }
  return false;
}

async function fillConnectNoteModal(page, note) {
  const trimmed = (note || "").trim().slice(0, 300);
  if (!trimmed) return true;

  const addNote = page.getByRole("button", { name: /Add a note|Thêm ghi chú|Add note/i }).first();
  if (await addNote.isVisible({ timeout: 4000 }).catch(() => false)) {
    await addNote.click();
    await sleep(600);
  }

  const textarea = page
    .locator(
      'textarea[name="message"], textarea#custom-message, textarea[aria-label*="note"], textarea[aria-label*="ghi chú"]',
    )
    .first();
  if (await textarea.isVisible({ timeout: 5000 }).catch(() => false)) {
    await textarea.fill(trimmed);
    return true;
  }

  const editable = page
    .locator(
      '[data-test-modal] [contenteditable="true"], div[role="dialog"] [contenteditable="true"]',
    )
    .first();
  if (await editable.count()) {
    await editable.click({ force: true }).catch(() => {});
    await page.keyboard.insertText(trimmed).catch(() => {});
    return true;
  }
  return false;
}

async function clickSendInvitation(page) {
  const scopes = [
    page.getByRole("button", { name: linkedInSendInvitationButtonName }),
    page.locator('button[aria-label*="Send invitation"], button[aria-label*="Gửi lời mời"]'),
  ];
  for (const btn of scopes) {
    const loc = btn.first();
    if (await loc.isVisible({ timeout: 2500 }).catch(() => false)) {
      if (await loc.isEnabled().catch(() => false)) {
        try {
          await loc.click();
        } catch {
          await loc.click({ force: true }).catch(() => {});
        }
        await sleep(2000);
        return true;
      }
    }
  }
  const clickedViaEval = await page
    .evaluate(() => {
      const controls = Array.from(document.querySelectorAll("button, [role='button']"));
      const sendBtn = controls.find((el) => {
        const text = (el.innerText || el.textContent || "").trim().toLowerCase();
        const label = (el.getAttribute("aria-label") || "").trim().toLowerCase();
        return (
          text === "send" ||
          text === "gửi" ||
          text.includes("send invitation") ||
          text.includes("gửi lời mời") ||
          label.includes("send invitation") ||
          label.includes("gửi lời mời")
        );
      });
      if (!sendBtn || sendBtn.disabled) return false;
      sendBtn.click();
      return true;
    })
    .catch(() => false);
  if (clickedViaEval) {
    await sleep(2000);
    return true;
  }
  return false;
}

async function linkedinSendConnectVoyagerFromInvitePage(page, note) {
  const requestContext = await page.evaluate((rawNote) => {
    const getCsrf = () => {
      const m = document.cookie.match(/JSESSIONID[=:]"?([^";,\s]+)"?/);
      return m ? m[1] : null;
    };
    const getMeta = (name) => document.querySelector(`meta[name="${name}"]`)?.content || null;
    const html = document.documentElement.innerHTML;
    const vanityName = new URL(location.href).searchParams.get("vanityName");
    const viewerProfileUrn =
      html.match(
        /com\.linkedin\.voyager\.common\.Me[\s\S]{0,500}?dashEntityUrn":"(urn:li:fsd_profile:[A-Za-z0-9_-]+)"/,
      )?.[1] || null;

    const escapedVanity = vanityName ? vanityName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : null;
    const patterns = escapedVanity
      ? [
          new RegExp(
            `entityUrn":"(urn:li:fsd_profile:[A-Za-z0-9_-]+)"[^]{0,600}?publicIdentifier":"${escapedVanity}"`,
          ),
          new RegExp(
            `publicIdentifier":"${escapedVanity}"[^]{0,600}?entityUrn":"(urn:li:fsd_profile:[A-Za-z0-9_-]+)"`,
          ),
          new RegExp(
            `dashEntityUrn":"(urn:li:fsd_profile:[A-Za-z0-9_-]+)"[^]{0,600}?publicIdentifier":"${escapedVanity}"`,
          ),
          new RegExp(
            `publicIdentifier":"${escapedVanity}"[^]{0,600}?dashEntityUrn":"(urn:li:fsd_profile:[A-Za-z0-9_-]+)"`,
          ),
        ]
      : [];
    let inviteeProfileUrn = null;
    for (const pattern of patterns) {
      const match = html.match(pattern);
      if (match?.[1]) {
        inviteeProfileUrn = match[1];
        break;
      }
    }
    if (!inviteeProfileUrn) {
      const fsdProfiles = [
        ...new Set([...html.matchAll(/urn:li:fsd_profile:[A-Za-z0-9_-]+/g)].map((m) => m[0])),
      ];
      inviteeProfileUrn =
        fsdProfiles.find((value) => value !== viewerProfileUrn) || fsdProfiles[0] || null;
    }

    const pageInstances = [
      ...new Set([...html.matchAll(/urn:li:page:[^"'\\<\s]+/g)].map((m) => m[0])),
    ];
    const pageInstance =
      pageInstances.find((value) => value.includes("preload.custom-invite")) ||
      pageInstances.find((value) => value.includes("invite-connect")) ||
      getMeta("bprPageInstance");

    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const tzOffset = -new Date().getTimezoneOffset() / 60;
    const serviceVersion = getMeta("serviceVersion");
    const clientVersion =
      serviceVersion ||
      window.__APP_VERSION__ ||
      document.querySelector("meta[name='version']")?.content ||
      "1.13.44284";
    const liTrack = {
      clientVersion,
      mpVersion: clientVersion,
      osName: "web",
      timezoneOffset: tzOffset,
      timezone: tz,
      deviceFormFactor: "DESKTOP",
      mpName: "voyager-web",
      displayDensity: window.devicePixelRatio || 1,
      displayWidth: window.screen.width,
      displayHeight: window.screen.height,
    };

    return {
      csrfToken: getCsrf(),
      language: getMeta("i18nLocale") || navigator.language || "en_US",
      pageInstance,
      inviteeProfileUrn,
      liTrack,
      customMessage: String(rawNote || "")
        .trim()
        .slice(0, 300),
    };
  }, note);

  const request = buildLinkedInConnectRequest({
    inviteeProfileUrn: requestContext.inviteeProfileUrn,
    customMessage: requestContext.customMessage,
    csrfToken: requestContext.csrfToken,
    language: requestContext.language,
    pageInstance: requestContext.pageInstance,
    liTrack: requestContext.liTrack,
  });

  return page.evaluate(async (req) => {
    try {
      const resp = await fetch(req.url, {
        method: "POST",
        credentials: "include",
        headers: req.headers,
        body: req.body,
      });
      const text = await resp.text().catch(() => "");
      if (!resp.ok) {
        return { success: false, error: `HTTP ${resp.status}: ${text.slice(0, 300)}` };
      }
      let data = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        data = null;
      }
      return {
        success: true,
        _method: "voyager_connect",
        responsePreview: text.slice(0, 300),
        data,
      };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }, request);
}

async function linkedinSendConnect(url, note, cdpUrl) {
  console.error(`--- Gửi lời mời kết nối LinkedIn: ${url} ---`);
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

    const pendingBtn = page.getByRole("button", { name: linkedInPendingButtonName }).first();
    if (await pendingBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      return {
        success: false,
        error: "Đã gửi lời mời kết nối trước đó — đang chờ ứng viên chấp nhận.",
        connectionStatus: "PENDING",
      };
    }

    const messageBtn = page
      .getByRole("button", { name: linkedInMessageButtonName })
      .or(page.getByRole("link", { name: linkedInMessageButtonName }))
      .or(messageActionFallback(page))
      .first();
    if (await messageBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      return {
        success: false,
        error: "Đã kết nối với ứng viên — dùng Gửi tin nhắn thay vì kết bạn.",
        connectionStatus: "CONNECTED",
      };
    }

    const clicked = await clickConnectOnProfile(page);
    if (!clicked) {
      return { success: false, error: "Không thấy nút Kết nối trên profile." };
    }
    await sleep(1500);

    if (page.url().includes("/preload/custom-invite/") || page.url().includes("/invite-connect/")) {
      const voyagerResult = await linkedinSendConnectVoyagerFromInvitePage(page, note);
      if (voyagerResult.success) {
        return {
          success: true,
          recipient: profileUrl,
          note_preview: (note || "").trim().slice(0, 80),
          connectionStatus: "PENDING",
          note: "Đã gửi lời mời kết nối qua LinkedIn Voyager API.",
          _method: voyagerResult._method,
        };
      }
      console.error(`[sendConnectVoyager] fallback UI sau khi API fail: ${voyagerResult.error}`);
    }

    if (note?.trim()) {
      const filled = await fillConnectNoteModal(page, note);
      if (!filled) {
        console.error("⚠️ Không điền được ghi chú — thử gửi không kèm note.");
      }
    }

    const sent = await clickSendInvitation(page);
    if (!sent) {
      return { success: false, error: "Không nhấn được Gửi lời mời — kiểm tra popup LinkedIn." };
    }

    return {
      success: true,
      recipient: profileUrl,
      note_preview: (note || "").trim().slice(0, 80),
      connectionStatus: "PENDING",
      note: "Đã gửi lời mời kết nối trên LinkedIn.",
    };
  } catch (e) {
    return { success: false, error: `Lỗi gửi lời mời: ${e.message}` };
  } finally {
    await releaseCdpBrowser(browser);
  }
}

// ============================================================
// 5. Gửi tin nhắn LinkedIn (CDP)
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

  await editor.click({ force: true }).catch(() => {});
  await sleep(500);
  await page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A").catch(() => {});
  await page.keyboard.press("Backspace").catch(() => {});
  await sleep(200);

  await page.keyboard.insertText(text).catch(() => {});
  await sleep(800);

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
        await loc.click({ force: true });
        await sleep(1500);
        return true;
      }
    }
  }

  // Fallback: Force click bằng JS thuần
  const clickedViaEval = await page
    .evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button[type="submit"]'));
      const sendBtn = btns.find((b) => {
        const text = (b.innerText || b.textContent || "").trim().toLowerCase();
        return text === "send" || text === "gửi";
      });
      if (sendBtn && !sendBtn.disabled) {
        sendBtn.click();
        return true;
      }

      // Tìm nút chính trong form gửi
      const formBtns = Array.from(
        document.querySelectorAll("form.msg-form button.artdeco-button--primary"),
      );
      if (formBtns.length > 0 && !formBtns[0].disabled) {
        formBtns[0].click();
        return true;
      }
      return false;
    })
    .catch(() => false);

  if (clickedViaEval) {
    await sleep(1500);
    return true;
  }

  return false;
}

/**
 * Gửi tin nhắn qua LinkedIn Voyager API (internal REST) — inject fetch() vào browser context.
 * Không navigate, không click, không type — ít bị detect hơn nhiều so với DOM automation.
 * profileIdUrl phải dạng /in/ACoAAA... (ID-based URL từ GraphQL).
 */
async function linkedinSendMessageVoyager(profileIdUrl, message, cdpUrl, knownThreadId = null) {
  let profileUrl = (profileIdUrl || "").split("?")[0];
  const idMatch = profileUrl.match(/\/in\/([^/?#\s]+)/);
  if (!idMatch && !knownThreadId) {
    return { success: false, error: "profileIdUrl không chứa /in/<id>" };
  }
  if (profileUrl && !profileUrl.startsWith("http")) {
    profileUrl = `https://www.linkedin.com${profileUrl.startsWith("/") ? profileUrl : `/in/${profileUrl}`}`;
  }

  const { browser, page: rawPage } = await connectPage(cdpUrl);
  // Kiểm tra page còn sống không; nếu không thì dùng trang mới
  let page = rawPage;
  try {
    await page.evaluate(() => true);
  } catch {
    console.error("[sendVoyager] page cũ dead — tạo trang mới");
    page = await browser.contexts()[0].newPage();
  }
  try {
    if (knownThreadId) {
      const threadUrl = `https://www.linkedin.com/messaging/thread/${encodeURIComponent(knownThreadId)}/`;
      console.error(`[sendVoyager] mở thẳng LinkedIn thread từ DB: ${knownThreadId}`);
      await page.goto(threadUrl, { timeout: 60_000 });
    } else {
      await page.goto(profileUrl, { timeout: 60_000 });
    }
    await page.waitForLoadState("domcontentloaded").catch(() => null);
    await sleep(1500);

    const currentUrl = page.url();
    if (pageLooksLikeLoginWall(currentUrl)) {
      return { success: false, error: "Chưa đăng nhập LinkedIn trên Chrome CDP." };
    }

    let openedThread = knownThreadId || parseLinkedInMessagingThreadId(currentUrl);
    if (!openedThread) {
      let clickedMessage = false;
      for (let i = 0; i < 3; i++) {
        clickedMessage = await page
          .evaluate(() => {
            const btns = Array.from(document.querySelectorAll('button, a, div[role="button"]'));
            const msgBtn = btns.find((b) => {
              const text = (b.innerText || b.textContent || "").trim().toLowerCase();
              return (
                text === "message" ||
                text === "nhắn tin" ||
                text.startsWith("message ") ||
                text.startsWith("nhắn tin ")
              );
            });
            if (msgBtn) {
              msgBtn.click();
              return true;
            }
            return false;
          })
          .catch(() => false);

        if (clickedMessage) break;

        if (i === 0) {
          await page
            .evaluate(() => {
              const moreBtns = Array.from(document.querySelectorAll("button, a"));
              const moreBtn = moreBtns.find((b) => {
                const t = (b.innerText || b.getAttribute("aria-label") || "").trim().toLowerCase();
                return (
                  t === "more" || t === "thêm" || t === "more actions" || t === "các hành động khác"
                );
              });
              if (moreBtn) moreBtn.click();
            })
            .catch(() => {});
        }
        await sleep(1200);
      }

      if (!clickedMessage) {
        return {
          success: false,
          error:
            "Không tìm thấy nút 'Nhắn tin' (Message) trên profile. Có thể bạn chưa kết nối với ứng viên này trên LinkedIn.",
        };
      }

      await sleep(2500);
      openedThread = parseLinkedInMessagingThreadId(page.url());
      if (!openedThread) {
        const firstThreadLink = page.locator("a[href*='/messaging/thread/']").first();
        if (await firstThreadLink.count()) {
          const href = await firstThreadLink.getAttribute("href");
          if (href) {
            await page.goto(href.startsWith("http") ? href : `https://www.linkedin.com${href}`, {
              timeout: 25_000,
            });
            await page.waitForLoadState("domcontentloaded").catch(() => null);
            await sleep(1000);
            openedThread = parseLinkedInMessagingThreadId(page.url());
          }
        }
      }
    }

    if (!openedThread) {
      return { success: false, error: "Không lấy được LinkedIn messaging thread id." };
    }

    const requestContext = await page.evaluate((threadId) => {
      const getCsrf = () => {
        const m = document.cookie.match(/JSESSIONID[=:]"?([^";,\s]+)"?/);
        return m ? m[1] : null;
      };
      const getMeta = (name) => document.querySelector(`meta[name="${name}"]`)?.content || null;
      const randomToken = () =>
        crypto.randomUUID?.() ||
        "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
          const r = crypto.getRandomValues(new Uint8Array(1))[0] & 15;
          const v = c === "x" ? r : (r & 3) | 8;
          return v.toString(16);
        });
      const randomTrackingId = () =>
        String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16)));
      const findMailboxUrn = () => {
        const html = document.documentElement.innerHTML;
        const escapedThreadId = threadId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const conversationMatch = html.match(
          new RegExp(
            `urn:li:msg_conversation:\\\\?\\((urn:li:fsd_profile:[^,)"]+),${escapedThreadId}`,
          ),
        );
        if (conversationMatch?.[1]) return conversationMatch[1];
        const mailboxMatch = html.match(/"mailboxUrn"\s*:\s*"(urn:li:fsd_profile:[^"]+)"/);
        if (mailboxMatch?.[1]) return mailboxMatch[1];
        const profileMatch = html.match(/urn:li:fsd_profile:[A-Za-z0-9_-]+/);
        return profileMatch?.[0] || null;
      };
      const findPageInstance = () => {
        const html = document.documentElement.innerHTML;
        const pageInstances = [
          ...new Set([...html.matchAll(/urn:li:page:[^"'\\<\s]+/g)].map((m) => m[0])),
        ];
        return (
          pageInstances.find((value) =>
            value.includes("d_flagship3_messaging_conversation_detail"),
          ) ||
          pageInstances.find((value) => value.includes("messaging")) ||
          getMeta("bprPageInstance")
        );
      };
      const csrf = getCsrf();
      if (!csrf) return { error: "Không tìm thấy CSRF token (JSESSIONID) trong cookie" };
      const mailboxUrn = findMailboxUrn();
      if (!mailboxUrn) return { error: "Không tìm thấy mailboxUrn LinkedIn" };

      const liLang = getMeta("i18nLocale") || navigator.language || "en_US";
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      const tzOffset = -new Date().getTimezoneOffset() / 60;
      const serviceVersion = getMeta("serviceVersion");
      const clientVersion =
        serviceVersion ||
        window.__APP_VERSION__ ||
        document.querySelector("meta[name='version']")?.content ||
        "1.13.20537";
      const liTrack = {
        clientVersion,
        mpVersion: clientVersion,
        osName: "web",
        timezoneOffset: tzOffset,
        timezone: tz,
        deviceFormFactor: "DESKTOP",
        mpName: "voyager-web",
        displayDensity: window.devicePixelRatio || 1,
        displayWidth: window.screen.width,
        displayHeight: window.screen.height,
      };
      const pageInstance = findPageInstance();

      return {
        csrfToken: csrf,
        language: liLang,
        liTrack,
        mailboxUrn,
        originToken: randomToken(),
        pageInstance,
        trackingId: randomTrackingId(),
      };
    }, openedThread);

    if (requestContext.error) {
      return { success: false, error: requestContext.error };
    }

    const request = buildLinkedInDashMessageRequest({
      message,
      threadId: openedThread,
      ...requestContext,
    });
    const result = await page.evaluate(async (req) => {
      try {
        const resp = await fetch(req.url, {
          method: "POST",
          credentials: "include",
          headers: req.headers,
          body: req.body,
        });

        if (!resp.ok) {
          const txt = await resp.text().catch(() => "");
          return { success: false, error: `HTTP ${resp.status}: ${txt.slice(0, 300)}` };
        }
        const data = await resp.json().catch(() => null);
        return { success: true, _method: "voyager_dash", messageUrn: data?.value?.entityUrn };
      } catch (err) {
        return { success: false, error: err.message };
      }
    }, request);

    console.error(`[sendVoyager] ${result.success ? "✓ OK" : "✗ FAIL"} → ${result.error ?? ""}`);
    return result;
  } catch (e) {
    return { success: false, error: `Voyager exception: ${e.message}` };
  } finally {
    await releaseCdpBrowser(browser);
  }
}

// async function linkedinSendMessage(url, message, cdpUrl) {
//   console.error(`--- Gửi tin nhắn LinkedIn: ${url} ---`);
//   let profileUrl = (url || "").split("?")[0];
//   if (!profileUrl.includes("/in/")) {
//     return { success: false, error: "URL profile không hợp lệ." };
//   }
//   if (!profileUrl.startsWith("http")) {
//     profileUrl = `https://www.linkedin.com${profileUrl}`;
//   }

//   const { browser, page } = await connectPage(cdpUrl);
//   try {
//     await page.goto(profileUrl, { timeout: 60_000 });
//     await page.waitForLoadState("domcontentloaded").catch(() => null);
//     await sleep(2000);

//     const currentUrl = page.url();
//     if (currentUrl.includes("login") || currentUrl.includes("authwall")) {
//       return { success: false, error: "Chưa đăng nhập LinkedIn trên Chrome CDP." };
//     }

//     const connectBtn = profileAction(page, linkedInConnectButtonName)
//       .or(connectActionFallback(page))
//       .first();
//     // Resilient search and click for Message button
//     let clickedMessage = false;
//     for (let i = 0; i < 3; i++) {
//       clickedMessage = await page
//         .evaluate(() => {
//           const btns = Array.from(document.querySelectorAll('button, a, div[role="button"]'));
//           const msgBtn = btns.find((b) => {
//             const text = (b.innerText || b.textContent || "").trim().toLowerCase();
//             return (
//               text === "message" ||
//               text === "nhắn tin" ||
//               text.startsWith("message ") ||
//               text.startsWith("nhắn tin ")
//             );
//           });
//           if (msgBtn) {
//             msgBtn.click();
//             return true;
//           }
//           return false;
//         })
//         .catch(() => false);

//       if (clickedMessage) break;

//       // If not found, try to open the "More" menu and wait a bit before retrying
//       if (i === 0) {
//         await page
//           .evaluate(() => {
//             const moreBtns = Array.from(document.querySelectorAll("button, a"));
//             const moreBtn = moreBtns.find((b) => {
//               const t = (b.innerText || b.getAttribute("aria-label") || "").trim().toLowerCase();
//               return (
//                 t === "more" || t === "thêm" || t === "more actions" || t === "các hành động khác"
//               );
//             });
//             if (moreBtn) moreBtn.click();
//           })
//           .catch(() => {});
//       }
//       await sleep(1500);
//     }

//     if (!clickedMessage) {
//       const isPending = await page
//         .evaluate(() => {
//           return Array.from(document.querySelectorAll("button, a")).some((b) => {
//             const t = (b.innerText || "").trim().toLowerCase();
//             return t === "pending" || t === "đang chờ" || t === "đã gửi";
//           });
//         })
//         .catch(() => false);

//       if (isPending) {
//         return {
//           success: false,
//           error:
//             "Ứng viên chưa chấp nhận lời mời (Đang chờ) và không có nút Nhắn tin (Premium/Open Profile).",
//         };
//       }

//       return {
//         success: false,
//         error:
//           "Không tìm thấy nút 'Nhắn tin' (Message) trên profile. Có thể bạn chưa kết nối với ứng viên này trên LinkedIn, hoặc giao diện LinkedIn đã thay đổi.",
//       };
//     }

//     await sleep(3500);

//     if (!(await fillMessageComposer(page, message))) {
//       return { success: false, error: "Không điền được nội dung tin nhắn trong hộp thoại." };
//     }

//     let sent = await clickSendMessage(page);
//     if (!sent) {
//       await page.keyboard.press("Enter").catch(() => {});
//       await sleep(500);
//       await page.keyboard.press("Control+Enter").catch(() => {});
//       await page.keyboard.press("Meta+Enter").catch(() => {});
//       await sleep(1200);
//       sent = await clickSendMessage(page);
//     }
//     // Enter gửi tin ngay trên LinkedIn — compose box trống sau khi gửi = thành công
//     if (!sent) {
//       const editorText = await msgComposerEditor(page)
//         .innerText()
//         .catch(() => "");
//       sent = !editorText.trim();
//     }
//     if (!sent) {
//       return { success: false, error: "Không nhấn được nút Gửi — kiểm tra LinkedIn messaging UI." };
//     }

//     return {
//       success: true,
//       recipient: profileUrl,
//       message_preview: message.slice(0, 80),
//       note: "Đã nhấn Gửi trên LinkedIn. Kiểm tra hộp thoại nếu cần.",
//     };
//   } catch (e) {
//     return { success: false, error: `Lỗi gửi tin: ${e.message}` };
//   } finally {
//     await releaseCdpBrowser(browser);
//   }
// }

// ============================================================
// 5. Mở trình duyệt (để người dùng đăng nhập)
// ============================================================
async function openBrowserUrl(url, cdpUrl) {
  console.error(`--- Mở trình duyệt tại: ${url} ---`);
  const { browser, page } = await connectOrOpenPage(cdpUrl, url, { manual: true });
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
// 7. Đồng bộ toàn bộ inbox LinkedIn (local sync via CDP)
// ============================================================
async function linkedinSyncInbox(cdpUrl) {
  console.error("--- Bắt đầu đồng bộ tin nhắn LinkedIn qua CDP ---");
  const { browser, page } = await connectPage(cdpUrl);

  const collectedConversations = [];
  const collectedMessages = [];

  // Dùng Fetch.enable (requestStage: Response) thay vì Network.responseReceived vì
  // Network.getResponseBody không đọc được khi connect qua connectOverCDP — browser đã consume body trước.
  // Fetch.enable "pause" response trước khi deliver tới page, đọc body qua Fetch.getResponseBody luôn OK.
  const cdpSession = await page.context().newCDPSession(page);
  await cdpSession.send("Fetch.enable", {
    patterns: [
      { urlPattern: "*voyagerMessagingGraphQL*", requestStage: "Response" },
      { urlPattern: "*voyager/api/messaging*", requestStage: "Response" },
    ],
  });

  let fetchInterceptCount = 0;

  cdpSession.on("Fetch.requestPaused", async ({ requestId, request, responseStatusCode }) => {
    const reqUrl = (request?.url || "").split("?")[0];
    fetchInterceptCount++;
    console.error(
      `[syncInbox Fetch #${fetchInterceptCount}] url=${reqUrl} | status=${responseStatusCode ?? "?"}`,
    );
    try {
      if (responseStatusCode && responseStatusCode >= 200 && responseStatusCode < 300) {
        let jsonStr;
        try {
          const { body, base64Encoded } = await cdpSession.send("Fetch.getResponseBody", {
            requestId,
          });
          jsonStr = base64Encoded ? Buffer.from(body, "base64").toString("utf-8") : body;
        } catch (bodyErr) {
          console.error(
            `[syncInbox Fetch #${fetchInterceptCount}] getResponseBody lỗi: ${bodyErr.message}`,
          );
          return;
        }

        let json;
        try {
          json = JSON.parse(jsonStr);
        } catch {
          return;
        }

        const dataKeys = Object.keys(json?.data ?? {}).join(", ");
        console.error(
          `[syncInbox Fetch #${fetchInterceptCount}] data keys: [${dataKeys || "(trống)"}]`,
        );

        const elements = json?.data?.messengerConversationsBySyncToken?.elements;
        if (Array.isArray(elements) && elements.length > 0) {
          console.error(
            `[syncInbox Fetch #${fetchInterceptCount}] messengerConversationsBySyncToken: ${elements.length} hội thoại`,
          );
          collectedConversations.push(json);
        } else if (dataKeys) {
          console.error(
            `[syncInbox Fetch #${fetchInterceptCount}] Không có messengerConversationsBySyncToken — bỏ qua`,
          );
        }
      }
    } catch (e) {
      console.error(`[syncInbox Fetch #${fetchInterceptCount}] lỗi xử lý: ${e.message}`);
    } finally {
      await cdpSession.send("Fetch.continueRequest", { requestId }).catch((e) => {
        console.error(`[syncInbox Fetch] continueRequest lỗi: ${e.message}`);
      });
    }
  });

  try {
    console.error("--- Điều hướng tới mục nhắn tin LinkedIn ---");
    await page.goto("https://www.linkedin.com/messaging/", {
      timeout: 60_000,
      waitUntil: "domcontentloaded",
    });

    // Kiểm tra đăng nhập
    const currentUrl = page.url();
    console.error(`[syncInbox] URL hiện tại sau navigate: ${currentUrl}`);
    if (
      currentUrl.includes("/login") ||
      currentUrl.includes("/signup") ||
      currentUrl.includes("/checkpoint")
    ) {
      console.error("Lỗi: Phiên đăng nhập LinkedIn đã hết hạn!");
      return {
        success: false,
        error:
          "Phiên đăng nhập LinkedIn đã hết hạn hoặc chưa được liên kết. Vui lòng vào phần 'Cài đặt tuyển dụng' để kết nối lại tài khoản của bạn.",
      };
    }

    // Đợi API conversations được tải xong
    console.error("--- Đợi API LinkedIn phản hồi ---");
    await sleep(3000);

    // Scroll để kích hoạt LinkedIn lazy-load thêm hội thoại cũ hơn
    console.error("--- Scroll để tải thêm hội thoại ---");
    for (let i = 0; i < 5; i++) {
      await page.evaluate(() => {
        const containerSelectors = [
          ".msg-conversations-container__conversations-list",
          '[class*="conversations-list"]',
          ".scaffold-layout__list",
          ".msg-overlay-list-bubble-scroll-region",
        ];
        let scrolled = false;
        for (const sel of containerSelectors) {
          const el = document.querySelector(sel);
          if (el) {
            el.scrollTop = el.scrollHeight;
            scrolled = true;
            break;
          }
        }
        if (!scrolled) window.scrollTo(0, document.body.scrollHeight);
      });
      await sleep(1500);
    }

    // Đợi thêm để thu thập phản hồi API cuối cùng sau scroll
    await sleep(2000);

    // Tổng kết Fetch intercept
    console.error(
      `[syncInbox Fetch] Tổng: ${fetchInterceptCount} intercept, ${collectedConversations.length} batch hợp lệ`,
    );

    // Fallback DOM nếu CDP không bắt được response nào
    if (collectedConversations.length === 0) {
      console.error("Không bắt được API response qua CDP — thử DOM fallback...");
      // Log page title + sample DOM để debug
      const pageInfo = await page
        .evaluate(() => ({
          title: document.title,
          url: location.href,
          threadLinks: document.querySelectorAll('a[href*="/messaging/thread/"]').length,
          bodyText: document.body?.innerText?.slice(0, 200) ?? "",
        }))
        .catch(() => null);
      console.error("[syncInbox DOM] Page info:", JSON.stringify(pageInfo));
      const domConversations = await page
        .evaluate(() => {
          const seen = new Set();
          const results = [];
          document.querySelectorAll('a[href*="/messaging/thread/"]').forEach((linkEl) => {
            const href = linkEl.getAttribute("href") || "";
            const match = href.match(/\/messaging\/thread\/([^/?#]+)/);
            if (!match) return;
            const threadId = match[1];
            if (seen.has(threadId)) return;
            seen.add(threadId);

            const container =
              linkEl.closest("li") ||
              linkEl.closest('[class*="conversation"]') ||
              linkEl.parentElement;

            const nameEl = container?.querySelector(
              'h3, strong, [class*="participant-names"], [class*="name"]',
            );
            const name = (
              nameEl?.textContent?.trim() ||
              linkEl.textContent?.trim() ||
              "Ứng viên LinkedIn"
            ).replace(/\s+/g, " ");

            const snippetEl = container?.querySelector(
              '[class*="message-snippet"], [class*="snippet"], [class*="preview"]',
            );
            const snippet = snippetEl?.textContent?.trim() || "";

            const imgEl = container?.querySelector("img");
            const avatarUrl = imgEl?.getAttribute("src") || null;

            results.push({ fromDom: true, threadId, name, snippet, avatarUrl });
          });
          return results;
        })
        .catch(() => []);

      console.error(`[syncInbox DOM] tìm thấy ${domConversations.length} thread`);
      if (domConversations.length > 0) {
        collectedConversations.push({ fromDom: true, elements: domConversations });
      }
    }

    const convCount = collectedConversations.reduce((sum, c) => {
      if (c.fromDom) return sum + (c.elements?.length || 0);
      return (
        sum +
        (c.data?.messengerConversationsBySyncToken?.elements?.length || c.elements?.length || 0)
      );
    }, 0);
    console.error(
      `--- Đồng bộ xong: ${convCount} hội thoại, ${collectedMessages.length} thread tin nhắn ---`,
    );

    return {
      success: true,
      conversationsCount: convCount,
      messagesCount: collectedMessages.length,
      conversations: collectedConversations,
      messages: collectedMessages,
    };
  } catch (err) {
    return { success: false, error: `Lỗi khi đồng bộ tin nhắn qua CDP: ${err.message}` };
  } finally {
    await cdpSession.detach().catch(() => {});
    await releaseCdpBrowser(browser);
  }
}

// ============================================================
// 9. Đồng bộ chi tiết tin nhắn một hội thoại cụ thể (per-thread)
// ============================================================
async function linkedinSyncThread(threadId, cdpUrl) {
  console.error(`--- Bắt đầu đồng bộ tin nhắn thread: ${threadId} ---`);
  const { browser, page } = await connectPage(cdpUrl);

  const collectedMessages = [];

  const cdpSession = await page.context().newCDPSession(page);

  const targetUrn = `urn:li:messagingThread:${threadId}`;

  // Dùng Fetch.enable thay vì Network.responseReceived để đảm bảo body luôn sẵn sàng
  // Bắt rộng hơn: voyager/api để không bỏ sót URL variant
  await cdpSession.send("Fetch.enable", {
    patterns: [
      { urlPattern: "*voyagerMessagingGraphQL*", requestStage: "Response" },
      { urlPattern: "*voyager/api/messaging*", requestStage: "Response" },
    ],
  });

  let fetchInterceptCount = 0;

  cdpSession.on("Fetch.requestPaused", async ({ requestId, request, responseStatusCode }) => {
    const reqUrl = (request?.url || "").split("?")[0];
    fetchInterceptCount++;
    console.error(
      `[syncThread Fetch #${fetchInterceptCount}] url=${reqUrl} | status=${responseStatusCode ?? "?"}`,
    );
    try {
      if (responseStatusCode && responseStatusCode >= 200 && responseStatusCode < 300) {
        let jsonStr;
        try {
          const { body, base64Encoded } = await cdpSession.send("Fetch.getResponseBody", {
            requestId,
          });
          jsonStr = base64Encoded ? Buffer.from(body, "base64").toString("utf-8") : body;
        } catch (bodyErr) {
          console.error(
            `[syncThread Fetch #${fetchInterceptCount}] getResponseBody lỗi: ${bodyErr.message}`,
          );
          return;
        }

        let json;
        try {
          json = JSON.parse(jsonStr);
        } catch {
          console.error(
            `[syncThread Fetch #${fetchInterceptCount}] JSON parse lỗi (${jsonStr?.length ?? 0} bytes)`,
          );
          return;
        }

        const dataKeys = Object.keys(json?.data || {});
        console.error(
          `[syncThread Fetch #${fetchInterceptCount}] data keys: [${dataKeys.join(", ")}]`,
        );

        let handled = false;

        // Kiểu chính: messengerMessagesBySyncToken — flat list messages của thread
        // queryId=messengerMessages.xxx, mỗi message có backendConversationUrn để filter
        const syncMessages = json?.data?.messengerMessagesBySyncToken?.elements;
        if (Array.isArray(syncMessages)) {
          handled = true;
          const filtered = syncMessages.filter(
            (m) => !m.backendConversationUrn || m.backendConversationUrn === targetUrn,
          );
          console.error(
            `[syncThread Fetch #${fetchInterceptCount}] messengerMessagesBySyncToken: ${syncMessages.length} tổng, ${filtered.length} khớp thread`,
          );
          collectedMessages.push(...filtered);
        }

        // Kiểu phụ 1: messengerMessagesByAnchorTimestamp
        const threadMsgs = json?.data?.messengerMessagesByAnchorTimestamp?.elements;
        if (Array.isArray(threadMsgs)) {
          handled = true;
          console.error(
            `[syncThread Fetch #${fetchInterceptCount}] messengerMessagesByAnchorTimestamp: ${threadMsgs.length} tin nhắn`,
          );
          collectedMessages.push(...threadMsgs);
        }

        // Kiểu phụ 2: messengerConversationsBySyncToken — inbox batch (filter theo thread)
        const convElements = json?.data?.messengerConversationsBySyncToken?.elements;
        if (Array.isArray(convElements)) {
          handled = true;
          let matched = 0;
          for (const conv of convElements) {
            const convUrn = conv.backendUrn;
            if (convUrn && convUrn !== targetUrn) continue;
            const msgElements = conv.messages?.elements;
            if (msgElements?.length > 0) {
              matched++;
              console.error(
                `[syncThread Fetch #${fetchInterceptCount}] inbox conv (target): ${msgElements.length} tin nhắn`,
              );
              collectedMessages.push(...msgElements);
            }
          }
          if (matched === 0) {
            console.error(
              `[syncThread Fetch #${fetchInterceptCount}] inbox batch: ${convElements.length} conv, không tìm thấy targetUrn`,
            );
          }
        }

        // Kiểu phụ 3: messengerConversation — single conv object
        const singleConv = json?.data?.messengerConversation;
        if (singleConv) {
          handled = true;
          const convUrn = singleConv.backendUrn;
          const msgCount = singleConv.messages?.elements?.length ?? 0;
          console.error(
            `[syncThread Fetch #${fetchInterceptCount}] messengerConversation: urn=${convUrn} | msgs=${msgCount}`,
          );
          if (msgCount > 0 && (!convUrn || convUrn === targetUrn)) {
            collectedMessages.push(...singleConv.messages.elements);
          }
        }

        if (!handled && dataKeys.length > 0) {
          console.error(
            `[syncThread Fetch #${fetchInterceptCount}] Không nhận dạng data. Keys: [${dataKeys.join(", ")}]`,
          );
        }
      } else {
        console.error(
          `[syncThread Fetch #${fetchInterceptCount}] bỏ qua status=${responseStatusCode}`,
        );
      }
    } catch (e) {
      console.error(`[syncThread Fetch #${fetchInterceptCount}] lỗi xử lý: ${e.message}`);
    } finally {
      await cdpSession.send("Fetch.continueRequest", { requestId }).catch((e) => {
        console.error(`[syncThread Fetch] continueRequest lỗi: ${e.message}`);
      });
    }
  });

  try {
    // Mở thẳng URL hội thoại
    const threadUrl = `https://www.linkedin.com/messaging/thread/${encodeURIComponent(threadId)}/`;
    console.error(`--- [syncThread] Fetch.enable đã bật, điều hướng tới ${threadUrl} ---`);
    await page.goto(threadUrl, { timeout: 60_000, waitUntil: "domcontentloaded" });

    const currentUrl = page.url();
    console.error(`--- [syncThread] currentUrl sau goto: ${currentUrl} ---`);
    if (
      currentUrl.includes("/login") ||
      currentUrl.includes("/signup") ||
      currentUrl.includes("/checkpoint")
    ) {
      return {
        success: false,
        error: "Phiên đăng nhập LinkedIn đã hết hạn. Vui lòng kết nối lại tài khoản.",
      };
    }

    // Đợi API tải xong — tăng lên 5s để đảm bảo tất cả request kịp fire
    console.error(
      `--- [syncThread] Đợi 5s cho API tải xong, fetchInterceptCount=${fetchInterceptCount} ---`,
    );
    await sleep(5000);
    console.error(
      `--- [syncThread] Sau 5s: collectedMessages=${collectedMessages.length}, fetchInterceptCount=${fetchInterceptCount} ---`,
    );

    // Scroll lên đầu để kích hoạt tải thêm tin nhắn cũ hơn
    console.error(`--- [syncThread] Scroll lên đầu (3 lần) để trigger load thêm ---`);
    for (let i = 0; i < 3; i++) {
      await page.evaluate(() => {
        const selectors = [
          ".msg-s-message-list-container",
          '[class*="message-list"]',
          ".scaffold-layout__detail",
          ".msg-conversations-container",
        ];
        for (const sel of selectors) {
          const el = document.querySelector(sel);
          if (el) {
            console.log(`[scroll] Found ${sel}, scrollTop from ${el.scrollTop} to 0`);
            el.scrollTop = 0;
            return;
          }
        }
        console.log("[scroll] Không tìm thấy message container, dùng window.scrollTo");
        window.scrollTo(0, 0);
      });
      await sleep(1500);
      console.error(
        `--- [syncThread] Sau scroll ${i + 1}: collectedMessages=${collectedMessages.length} ---`,
      );
    }

    await sleep(2000);
    console.error(
      `--- [syncThread] Kết thúc chờ: collectedMessages=${collectedMessages.length}, fetchInterceptCount=${fetchInterceptCount} ---`,
    );

    // Dedup theo backendUrn
    const seen = new Set();
    const unique = collectedMessages.filter((m) => {
      if (!m.backendUrn) return true;
      if (seen.has(m.backendUrn)) return false;
      seen.add(m.backendUrn);
      return true;
    });

    console.error(
      `--- [syncThread] Đồng bộ xong: ${unique.length} tin nhắn duy nhất (thread: ${threadId}) ---`,
    );
    return { success: true, messages: unique, messagesCount: unique.length };
  } catch (err) {
    console.error(`--- [syncThread] Lỗi: ${err.message} ---`);
    return { success: false, error: `Lỗi khi đồng bộ thread: ${err.message}` };
  } finally {
    await cdpSession.send("Fetch.disable").catch(() => {});
    await cdpSession.detach().catch(() => {});
    await releaseCdpBrowser(browser);
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
    "send_connect",
    "create_feed_post",
    "open_browser",
    "get_session",
    "save_session",
    "sync_inbox",
    "sync_thread",
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
      if ((!url && !cli.threadId) || !message) {
        console.error("Error: --url hoặc --threadId, và --message là bắt buộc");
        process.exit(1);
      }
      // Thử Voyager API trước (không navigate, không click — ít bị detect)
      console.error(
        `[send_message] Thử Voyager API cho: ${url}${cli.threadId ? ` thread=${cli.threadId}` : ""}`,
      );
      let result = await linkedinSendMessageVoyager(url, message, cdpUrl, cli.threadId);
      let usedMethod = "voyager";
      if (result.success) {
        console.error(`[send_message] ✓ Voyager API thành công — không cần navigate/click`);
      } else {
        console.error(`[send_message] ✗ Voyager thất bại: ${result.error}`);
        console.error(`[send_message] Fallback sang DOM automation (navigate + click)...`);
        // result = await linkedinSendMessage(url, message, cdpUrl);
        usedMethod = "dom";
        if (result.success) {
          console.error(`[send_message] ✓ DOM fallback thành công`);
        } else {
          console.error(`[send_message] ✗ DOM fallback cũng thất bại: ${result.error}`);
        }
      }
      result._method = result.success ? usedMethod : "failed";
      console.log(JSON.stringify(result, null, 2));
    } else if (action === "send_connect") {
      if (!url) {
        console.error("Error: --url bắt buộc");
        process.exit(1);
      }
      console.log(JSON.stringify(await linkedinSendConnect(url, message || "", cdpUrl), null, 2));
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
    } else if (action === "sync_inbox") {
      console.log(JSON.stringify(await linkedinSyncInbox(cdpUrl), null, 2));
    } else if (action === "sync_thread") {
      if (!url) {
        console.error("Error: --url (threadId) bắt buộc");
        process.exit(1);
      }
      console.log(JSON.stringify(await linkedinSyncThread(url, cdpUrl), null, 2));
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
