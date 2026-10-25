// 后台：每日一次更新检查 + 通知 + 数据结构访问
import { db, stats, setMeta, getMeta, markRead, reconcileFresh, getAllArticles } from "./db.js";
import {
  normalizeUrl,
  idFromUrl,
  parseEntriesFromHtml,
  parseLatestFromHtml,
  listPageLinksFromHtml,
  titleFromDoc,
  dateFromDoc,
  SITE,
} from "./common.js";

const ALARM = "daily-check";
const LAST_CHECK = "lastCheck";
const SEEN_LATEST = "seenLatestId";
const HOME = `${SITE}/blog/index.html`;
const ARCHIVE = `${SITE}/blog/archives.html`;

chrome.runtime.onInstalled.addListener(async (details) => {
  await scheduleDaily();
  await ensureSeenBaseline();
  if (details.reason === "install") {
    chrome.tabs.create({ url: HOME });
  }
});

chrome.runtime.onStartup.addListener(async () => {
  await scheduleDaily();
  await maybeCheckDaily("startup");
});

// 定时闹钟（浏览器开着时到点）；浏览器常关的话由 onStartup 兜底
async function scheduleDaily() {
  const alarm = await chrome.alarms.get(ALARM);
  if (!alarm) {
    const when = new Date();
    when.setHours(9, 0, 0, 0);
    if (when.getTime() <= Date.now()) when.setDate(when.getDate() + 1);
    chrome.alarms.create(ALARM, { when: when.getTime(), periodInMinutes: 60 * 24 });
  }
}

chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === ALARM) runCheck({ source: "alarm" });
});

/** 「当天第一次启动 Chrome 才检查」的闸门 */
async function maybeCheckDaily(source) {
  const last = (await getMeta(LAST_CHECK)) || 0;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  if (last >= today.getTime()) return { skipped: true, reason: "today-already-checked" };
  return runCheck({ source });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      if (msg?.type === "GET_STATE") {
        sendResponse(await getState());
      } else if (msg?.type === "LIST_ARTICLES") {
        sendResponse({ ok: true, items: (await getAllArticles()).map(stripHeavy) });
      } else if (msg?.type === "CHECK_NOW") {
        sendResponse(await runCheck({ source: "manual", force: true }));
      } else if (msg?.type === "GET_ARTICLE") {
        sendResponse({ ok: true, article: stripHeavy(await getByUrl(msg.url) || {}) || null });
      } else if (msg?.type === "ARTICLE_READ") {
        // content script 在文章页读到 90% 后上报，由后台统一写库
        const d = await db();
        const id = msg.id || idFromUrl(msg.url);
        const old = await d.get("articles", id);
        const now = new Date().toISOString();
        await d.put("articles", {
          ...(old || {}),
          id,
          url: msg.url,
          title: (old && old.title) || msg.title || "",
          published: (old && old.published) || msg.published || null,
          status: "read",
          discoveredAt: (old && old.discoveredAt) || now,
          firstSeenOnSite: (old && old.firstSeenOnSite) || null,
          readAt: now,
          readProgress: msg.progress ?? 100,
          archived: Boolean(old && old.archived),
        });
        // 有新文章角标时顺手清掉
        const fresh = await d.get("articles", id);
        if (fresh) await chrome.action.setBadgeText({ text: "" }).catch(() => {});
        sendResponse({ ok: true });
      } else if (msg?.type === "MARK_READ") {
        await markRead(msg.id, { readAt: new Date().toISOString() });
        sendResponse({ ok: true });
      } else if (msg?.type === "SET_UNREAD") {
        const d = await db();
        const rec = await d.get("articles", msg.id);
        if (rec) {
          rec.status = "unread";
          rec.readAt = null;
          await d.put("articles", rec);
        }
        sendResponse({ ok: true });
      } else if (msg?.type === "DEMO_SEED") {
        // 仅用于截图：写入示例数据，不联网
        const d = await db();
        const now = new Date().toISOString();
        for (const [id, title, published, status] of msg.rows) {
          await d.put("articles", {
            id,
            url: `https://www.ruanyifeng.com/blog/${id}.html`,
            title,
            published,
            status,
            discoveredAt: now,
            firstSeenOnSite: now,
            readAt: status === "read" ? now : null,
            archived: false,
          });
        }
        sendResponse({ ok: true });
      } else if (msg?.type === "SCAN_ALL") {
        sendResponse(await scanAll());
      } else if (msg?.type === "ENSURE_SEEN") {
        await ensureSeenBaseline();
        sendResponse({ ok: true });
      } else {
        sendResponse({ ok: false, error: "unknown message" });
      }
    } catch (e) {
      sendResponse({ ok: false, error: String(e?.message || e) });
    }
  })();
  return true;
});

/** popup 用：去掉可能很大的字段（如正文缓存） */
function stripHeavy(a) {
  return {
    id: a.id,
    url: a.url,
    title: a.title,
    published: a.published || null,
    status: a.status,
    readAt: a.readAt || null,
    discoveredAt: a.discoveredAt || null,
  };
}

/** 按 URL 取记录（content script 只认 URL） */
async function getByUrl(url) {
  const n = normalizeUrl(url);
  if (!n) return null;
  return (await db()).get("articles", idFromUrl(n));
}

async function getState() {
  const s = await stats();
  const last = (await getMeta(LAST_CHECK)) || 0;
  const seenLatest = await getMeta(SEEN_LATEST);
  const notifyErr = await getMeta("lastNotifyError");
  return { ...s, lastCheck: last, seenLatest, lastError: await getMeta("lastError"), lastNotifyError: notifyErr, now: Date.now() };
}

/** 首次使用：把站点当前最新文章记为「已见过」，避免第一次就报一堆红点 */
async function ensureSeenBaseline() {
  if (await getMeta(SEEN_LATEST)) return;
  const list = await fetchHomepage();
  if (!list.length) return;
  const latest = list[0];
  await setMeta(SEEN_LATEST, latest.id);
  await setMeta("seenLatestDate", latest.published || null);
}

async function fetchText(url) {
  const res = await fetch(url, { cache: "no-store", credentials: "omit" });
  if (!res.ok) throw new Error(`HTTP ${res.status} @ ${url}`);
  return await res.text();
}

/** 从 HTML 里取 <title> 文本（用于补全文章标题） */
function htmlTitle(html) {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? m[1].replace(/<[^>]*>/g, "").replace(/&amp;/g, "&").trim() : "";
}


/** 从列表页里抓「文章 id -> 发布日期（ISO）」：取自 li 文本 2026.10.16 或 abbr.published 的 title */
function extractListPageDatesFromHtml(html) {
  const map = new Map();
  for (const e of parseEntriesFromHtml(html)) if (e.published) map.set(e.id, e.published);
  return map;
}

/** 首页：拿到最新一篇（与「最新文章」列表） */
async function fetchHomepage() {
  return parseEntriesFromHtml(await fetchText(HOME));
}

/** 存档页：一次能列出最近 20 篇，带日期 */
async function fetchArchive() {
  return parseEntriesFromHtml(await fetchText(ARCHIVE));
}

/** 文章页：补全标题与日期 */
async function fetchArticleMeta(url) {
  try {
    const html = await fetchText(url);
    const id = idFromUrl(url);
    const found = parseEntriesFromHtml(html).find((e) => e.id === id);
    // 文章页：<title>xxx - 阮一峰的网络日志</title> 与 abbr.published 的精确时间
    let title = found?.title || htmlTitle(html).replace(/\s*-\s*阮一峰的网络日志\s*$/, "").replace(/^🐴\s*/, "");
    const m = html.match(/<abbr[^>]*class="[^"]*published[^"]*"[^>]*title="([^"]+)"/i);
    const published = m && !isNaN(new Date(m[1])) ? new Date(m[1]).toISOString() : null;
    return { title, published };
  } catch {
    return { title: "", published: null };
  }
}

/** 核心检查：抓站点最新文章，与本地最新记录对比；同时把新出现的文章入库为「新文章」 */
async function runCheck({ source = "auto", force = false } = {}) {
  const d = await db();
  let newest = null;
  try {
    const html = await fetchText(HOME);
    newest = parseLatestFromHtml(html);
    if (!newest) throw new Error("首页未解析到文章");
  } catch (e) {
    await setMeta("lastError", { at: Date.now(), msg: String(e?.message || e) });
    return { ok: false, error: String(e?.message || e) };
  }
  if (!newest.title || !newest.published) {
    const meta = await fetchArticleMeta(newest.url);
    newest.title = newest.title || meta.title;
    newest.published = newest.published || meta.published;
  }

  const seen = await getMeta(SEEN_LATEST);
  const isNew = Boolean(seen) && seen !== newest.id;

  // 新文章入库（只在确认是新文章时，避免把历史文章全标成「新」）
  if (isNew) {
    const now = new Date().toISOString();
    const rec = await d.get("articles", newest.id);
    if (!rec) {
      await d.put("articles", {
        id: newest.id,
        url: newest.url,
        title: newest.title,
        published: newest.published,
        status: "new",
        discoveredAt: now,
        firstSeenOnSite: now,
        readAt: null,
        archived: false,
      });
    } else if (rec.status === "new") {
      /* 已是新文章，保持 */
    }
    await setMeta(SEEN_LATEST, newest.id);
    await setMeta("seenLatestDate", newest.published || null);
    await notifyNew(newest);
  } else if (!seen) {
    await setMeta(SEEN_LATEST, newest.id);
    await setMeta("seenLatestDate", newest.published || null);
  }

  await setMeta(LAST_CHECK, Date.now());
  await setMeta("lastSource", source);
  await setMeta("lastError", null);
  return { ok: true, isNew, newest, source, force };
}

async function notifyNew(art) {
  const title = art.title || "阮一峰发布了新文章";
  // 先更新工具栏角标（通知权限被拒时也有可见提示）
  try {
    await chrome.action.setBadgeBackgroundColor({ color: "#e5484d" });
    await chrome.action.setBadgeText({ text: "NEW" });
  } catch {}
  try {
    await chrome.notifications.create(`ruanyf-${art.id}`, {
      type: "basic",
      iconUrl: chrome.runtime.getURL("icons/icon128.png"),
      title: "📚 阮一峰更新了",
      message: title,
      contextMessage: "点击打开文章",
      priority: 2,
      requireInteraction: true,
      buttons: [{ title: "打开文章" }, { title: "稍后再说" }],
    });
    await setMeta("unactionedNotification", { id: art.id, url: art.url, at: Date.now() });
  } catch (e) {
    console.warn("notification failed", e);
    await setMeta("lastNotifyError", { at: Date.now(), msg: String(e?.message || e) });
  }
}

chrome.notifications.onClicked.addListener(async (nid) => {
  const pending = await getMeta("unactionedNotification");
  const url = pending?.url || HOME;
  chrome.tabs.create({ url });
  chrome.notifications.clear(nid);
  await chrome.action.setBadgeText({ text: "" });
});

chrome.notifications.onButtonClicked.addListener(async (nid, idx) => {
  if (idx === 0) {
    const pending = await getMeta("unactionedNotification");
    chrome.tabs.create({ url: pending?.url || HOME });
    chrome.action.setBadgeText({ text: "" });
  }
  chrome.notifications.clear(nid);
});
/**
 * 历史建档：BFS 抓取站内所有列表页（首页、存档、按月、分类），把全部文章入库为「未读」。
 * 注意：站点没有全站文章列表接口，只能靠列表页 + 分页累加，因此设上限防止无限抓取。
 */
async function scanAll({ maxPages = 80, maxMs = 45000 } = {}) {
  const started = Date.now();
  const seenPages = new Set(["__start__"]);
  let queue = [HOME, ARCHIVE];
  const articles = new Map();
  let pageCount = 0;

  while (queue.length && pageCount < maxPages && Date.now() - started < maxMs) {
    const batch = queue.splice(0, 4);
    const results = await Promise.allSettled(
      batch.map(async (u) => {
        pageCount++;
        const html = await fetchText(u);
        return { u, html };
      })
    );
    for (const r of results) {
      if (r.status !== "fulfilled") continue;
      const { u, html } = r.value;
      const dated = extractListPageDatesFromHtml(html);
      for (const e of parseEntriesFromHtml(html)) {
        const published = dated.get(e.id) || e.published || null;
        const prev = articles.get(e.id);
        if (!prev) articles.set(e.id, { ...e, published });
        else if (!prev.published && published) prev.published = published;
      }
      // 扩展下一页：按月页、分类页
      for (const abs of listPageLinksFromHtml(html, u)) {
        if (seenPages.has(abs)) continue;
        seenPages.add(abs);
        queue.push(abs);
      }
    }
  }

  const list = [...articles.values()];
  // 未在存档页拿到日期的，按月页 URL 兜底无日；这里尽量用首屏抓到的日期
  const { added } = await reconcileFresh(list);
  await setMeta("lastScan", { at: Date.now(), scanned: list.length, added: added.length, pages: pageCount });
  return { ok: true, scanned: list.length, added: added.length, pages: pageCount };
}
// 调试钩子：仅供 E2E 测试通过 service worker 调用
globalThis.__ruanyf = { runCheck, scanAll, getState, ensureSeenBaseline, fetchText, parseEntriesFromHtml, SITE };