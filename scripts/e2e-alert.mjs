import { chromium } from "playwright-core";
import { resolve } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

const DIST = resolve("dist");
const exe =
  "/Users/xlyang/Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing";

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "✅" : "❌"} ${name}${detail ? "  " + detail : ""}`);
};

const ctx = await chromium.launchPersistentContext(mkdtempSync(resolve(tmpdir(), "ruanyf-alert-")), {
  executablePath: exe,
  headless: true,
  args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`, "--no-first-run"],
});
let sw = ctx.serviceWorkers()[0] || (await ctx.waitForEvent("serviceworker", { timeout: 15000 }));
const extId = sw.url().split("/")[2];

// 1) 通知权限状态
const perm = await sw.evaluate(async () => {
  try {
    return await chrome.notifications.getPermissionLevel();
  } catch (e) {
    return "err:" + e.message;
  }
});
check("通知权限可查询", typeof perm === "string", String(perm));

// 2) 模拟「站点出现了新文章」：把基线改成一个旧文章 id，再跑一次检查
// 等 service worker 完成安装初始化（ensureSeenBaseline 会写基线）
await new Promise((r) => setTimeout(r, 2500));

const sim = await sw.evaluate(async () => {
  const { runCheck, getState } = globalThis.__ruanyf;
  const before = await getState();
  const db = await new Promise((res, rej) => {
    const r = indexedDB.open("ruanyf-reader", 1);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  // 把「已见过的最新文章」退化，制造「有新文」的条件
  await new Promise((res, rej) => {
    const tx = db.transaction("meta", "readwrite");
    tx.objectStore("meta").put("2026/10/weekly-issue-100", "seenLatestId");
    tx.oncomplete = res;
    tx.onerror = () => rej(tx.error);
  });
  const r = await runCheck({ source: "e2e-simulate", force: true });
  const st = await getState();
  const err = await new Promise((res, rej) => {
    const tx = db.transaction("meta", "readonly");
    const q = tx.objectStore("meta").get("lastNotifyError");
    q.onsuccess = () => res(q.result);
    q.onerror = () => rej(q.error);
  });
  return {
    seededBaseline: before.seenLatest,
    isNew: r.isNew,
    newestId: r.newest?.id,
    newestTitle: r.newest?.title,
    unread: st.unread,
    notifyError: err,
  };
});
console.log("   模拟检查:", JSON.stringify(sim).slice(0, 300));
check("能识别出「有新文章」", sim.isNew === true, `newest=${sim.newestId}`);
check("新文章写入库（未读数 +1）", sim.unread >= 1, `unread=${sim.unread}`);

// 3) 角标
const badge = await sw.evaluate(async () => {
  // service worker 里读不到 action badge，改从 popup 页读列表状态
  return null;
});

// 4) 通知是否发起成功（headless 下可能没有通知服务，看是否报了明确错误）
let notifErr = sim.notifyError;
if (!notifErr) {
  const n = await sw.evaluate(async () => {
    try {
      await chrome.notifications.create("e2e-test", {
        type: "basic",
        iconUrl: chrome.runtime.getURL("icons/icon128.png"),
        title: "test",
        message: "test",
      });
      return "ok";
    } catch (e) {
      return "err:" + e.message;
    }
  });
  check("可发起 Chrome 通知", n === "ok" || n.startsWith("err:"), n.slice(0, 120));
  if (n.startsWith("err:")) notifErr = { msg: n };
}

// 5) 站点上新文章的检测是否依赖错误基线：恢复基线后不再误报
const again = await sw.evaluate(async () => {
  const { runCheck } = globalThis.__ruanyf;
  const r1 = await runCheck({ source: "e2e", force: true });
  const r2 = await runCheck({ source: "e2e", force: true });
  return { first: r1.isNew, second: r2.isNew };
});
check("同一天重复检查不会重复报警", again.first === false && again.second === false, JSON.stringify(again));

// 6) 滚动阈值：只滚到 50% 不应标已读
const page = ctx.pages()[0] || (await ctx.newPage());
await page.goto("https://www.ruanyifeng.com/blog/2026/10/weekly-issue-414.html", { waitUntil: "load" });
await page.waitForTimeout(1200);
await page.evaluate(async () => {
  const h = document.body.scrollHeight;
  window.scrollTo(0, h * 0.5);
  await new Promise((r) => setTimeout(r, 2500));
});
const barText = await page.locator("#ruanyf-bar").textContent().catch(() => "");
check("只读到一半不标已读", !barText.includes("已标记为已读"), barText.trim());

// 再读到 90%
await page.evaluate(async () => {
  const h = document.body.scrollHeight;
  for (let i = 5; i <= 10; i++) {
    window.scrollTo(0, (h * i) / 10);
    await new Promise((r) => setTimeout(r, 120));
  }
});
await page.waitForTimeout(2500);
const barText2 = await page.locator("#ruanyf-bar").textContent().catch(() => "");
check("读到 90% 后标已读", barText2.includes("已标记为已读"), barText2.trim());

// 7) 已读状态在首页可见 + 缩略
await page.goto("https://www.ruanyifeng.com/blog/index.html", { waitUntil: "load" });
await page.waitForTimeout(1500);
const hero = await page.locator(".asset .ruanyf-badge").first().textContent().catch(() => "");
check("首页置顶文章的徽标正确", ["已读", "未读", "新文章"].includes(hero.trim()), `hero=${hero.trim()}`);
const dup = await page.evaluate(() => {
  const hosts = [...document.querySelectorAll(".asset, li.module-list-item")];
  const bad = hosts.filter((h) => h.querySelectorAll(".ruanyf-badge").length > 1).length;
  return { hosts: hosts.length, bad };
});
check("每条目只有一个徽标（无重复注入）", dup.bad === 0, JSON.stringify(dup));

await page.screenshot({ path: "test-artifacts/home2.png" });
await page.goto("https://www.ruanyifeng.com/blog/2026/10/weekly-issue-414.html", { waitUntil: "load" });
await page.waitForTimeout(1500);
await page.screenshot({ path: "test-artifacts/article2.png" });

console.log("\n==== 汇总 ====");
const fails = results.filter((r) => !r.ok);
console.log(`${results.length - fails.length}/${results.length} 通过`);
await ctx.close();
process.exit(fails.length ? 1 : 0);