// E2E：用 Playwright 启动带扩展的 Chrome（headless=new 支持扩展），真实访问站点验证功能
import { chromium } from "playwright-core";
import { resolve, dirname } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

const DIST = resolve("dist");
const userDataDir = mkdtempSync(resolve(tmpdir(), "ruanyf-e2e-"));
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "✅" : "❌"} ${name}${detail ? "  " + detail : ""}`);
};

const ctx = await chromium.launchPersistentContext(userDataDir, {
  executablePath:
    "/Users/xlyang/Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
  headless: true,
  viewport: { width: 1280, height: 900 },
  args: [
    `--disable-extensions-except=${DIST}`,
    `--load-extension=${DIST}`,
    "--no-first-run",
    "--no-default-browser-check",
  ],
});

// 等待 service worker 起来，拿到扩展 id
let [sw] = ctx.serviceWorkers();
if (!sw) sw = await ctx.waitForEvent("serviceworker", { timeout: 15000 });
const extId = sw.url().split("/")[2];
console.log("扩展 ID:", extId);

const page = ctx.pages()[0] || (await ctx.newPage());
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => {
  if (m.type() === "error") errors.push("console:" + m.text());
});

async function goto(url) {
  await page.goto(url, { waitUntil: "load", timeout: 60000 });
  await page.waitForTimeout(1200);
}

// ── 1) 首页注入
await goto("https://www.ruanyifeng.com/blog/index.html");
const heroBadge = await page.locator(".asset .ruanyf-badge").first().textContent().catch(() => null);
const homeBadges = await page.locator(".ruanyf-badge").count();
check("首页注入徽标", homeBadges > 0, `徽标数=${homeBadges}`);
check("首页顶部文章有徽标", Boolean(heroBadge), `首条=${heroBadge}`);
const styleOk = await page.evaluate(() => Boolean(document.getElementById("ruanyf-reader-style")));
check("样式已注入", styleOk);

// ── 2) 存档页
await goto("https://www.ruanyifeng.com/blog/archives.html");
const archBadges = await page.locator(".ruanyf-badge").count();
check("存档页注入徽标", archBadges > 0, `徽标数=${archBadges}`);

// ── 3) 文章页阅读进度 + 自动标已读
const ART = "https://www.ruanyifeng.com/blog/2026/10/weekly-issue-415.html";
await goto(ART);
const hasBar = await page.locator("#ruanyf-bar").count();
check("文章页显示阅读进度条", hasBar === 1);
const initialText = await page.locator("#ruanyf-bar").textContent().catch(() => "");
console.log("   初始:", initialText.trim());

// 模拟真人滚动阅读
await page.evaluate(async () => {
  const h = document.body.scrollHeight;
  for (let y = 0; y < h; y += 400) {
    window.scrollTo(0, y);
    await new Promise((r) => setTimeout(r, 60));
  }
  window.scrollTo(0, h);
});
await page.waitForTimeout(2600);
const afterText = await page.locator("#ruanyf-bar").textContent().catch(() => "");
check("滚到底后自动标记已读", afterText.includes("已标记为已读"), afterText.trim());

// 已读状态是否真的落库（popup 同源页面 + 后台消息，走真实链路）
const popup0 = await ctx.newPage();
await popup0.goto(`chrome-extension://${extId}/popup.html`);
await popup0.waitForTimeout(800);
const dbRec = await popup0.evaluate(async () => {
  const res = await chrome.runtime.sendMessage({ type: "LIST_ARTICLES" });
  const items = res?.items || [];
  return { total: items.length, read: items.filter((a) => a.status === "read").map((a) => a.id) };
});
check("已读记录确实写入数据库", dbRec.read.length >= 1, JSON.stringify(dbRec).slice(0, 200));

// ── 4) 回首页看徽标变化
await goto("https://www.ruanyifeng.com/blog/index.html");
const state = await page.evaluate(() => {
  const rows = [...document.querySelectorAll("li.module-list-item")].map((li) => ({
    t: (li.querySelector("a")?.textContent || "").trim().slice(0, 26),
    b: li.querySelector(".ruanyf-badge")?.textContent || "",
  }));
  return { rows, hero: document.querySelector(".asset .ruanyf-badge")?.textContent };
});
console.log("   首页:", JSON.stringify(state.rows.slice(0, 4), null, 0), "hero=", state.hero);
check(
  "已读文章在首页显示「已读」",
  state.hero === "已读" || state.rows.some((r) => r.b === "已读"),
  `hero=${state.hero}`
);

// ── 5) popup 页面（提前打开，供后台消息通道使用）
const popup = await ctx.newPage();
await popup.goto(`chrome-extension://${extId}/popup.html`);
await popup.waitForTimeout(1500);

// 后台消息：检查更新 / 扫描（经由真实 popup 页面触发，走 chrome.runtime 通道）
const chk = await popup.evaluate(async () => await chrome.runtime.sendMessage({ type: "CHECK_NOW" }));
check("手动检查更新可用", chk?.ok === true, JSON.stringify(chk).slice(0, 200));

const scan = await popup.evaluate(async () => await chrome.runtime.sendMessage({ type: "SCAN_ALL" }));
check("历史文章导入可用", scan?.ok === true, JSON.stringify(scan).slice(0, 240));

// ── 6) popup 渲染
await popup.reload();
await popup.waitForTimeout(1500);
const popupText = await popup.locator("body").innerText();
const rows = await popup.locator(".row").count();
check("popup 能渲染列表", rows > 0, `行数=${rows}`);
console.log("---- popup ----\n" + popupText.slice(0, 900));
await popup.screenshot({ path: "test-artifacts/popup.png", fullPage: true });

// 截图留证
await page.goto("https://www.ruanyifeng.com/blog/index.html", { waitUntil: "load" });
await page.waitForTimeout(1500);
await page.screenshot({ path: "test-artifacts/home.png", fullPage: false });
await page.goto(ART, { waitUntil: "load" });
await page.waitForTimeout(1500);
await page.screenshot({ path: "test-artifacts/article.png", fullPage: false });

check("无页面 JS 异常", errors.length === 0, errors.slice(0, 3).join(" | "));

console.log("\n==== 汇总 ====");
const fails = results.filter((r) => !r.ok);
console.log(`${results.length - fails.length}/${results.length} 通过`);
await ctx.close();
rmSync(userDataDir, { recursive: true, force: true });
process.exit(fails.length ? 1 : 0);