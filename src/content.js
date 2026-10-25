// content script：列表页/文章页标注已读状态 + 记录阅读进度
import { getArticle } from "./db.js";
import { normalizeUrl, idFromUrl, titleFromDoc, dateFromDoc } from "./common.js";

const STYLE_ID = "ruanyf-reader-style";
const PILL_ATTR = "data-ruanyf-pill";
const READ_RATIO_DONE = 0.9;
const DWELL_MS = 1500;

const CSS = `
.ruanyf-badge{
  display:inline-flex;align-items:center;gap:4px;
  font-size:11px;line-height:1;font-weight:600;letter-spacing:.02em;
  padding:3px 7px;border-radius:999px;margin-left:8px;
  vertical-align:middle;white-space:nowrap;
  font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Helvetica Neue",sans-serif;
  border:1px solid transparent;
  transition:opacity .15s ease;
}
.ruanyf-badge.read{color:#0b7a3b;background:#e7f6ec;border-color:#bfe6cd;}
.ruanyf-badge.unread{color:#9a3412;background:#fff4e5;border-color:#f7d3a8;}
.ruanyf-badge.new{color:#8b1d1d;background:#ffe9e9;border-color:#f6b8b8;}
/* 已读的文章标题降淡，视觉上一眼扫出没读的 */
.read-entry h2.asset-name a{ opacity:.55; }
.read-entry h2.asset-name a::after{content:" ✓";color:#0b7a3b;font-weight:700;}
.unread-entry h2.asset-name a{ font-weight:700; }
.module-list-item.read-entry > a{ opacity:.6; }
/* 新文章：左侧红条 */
.asset.new-entry{ position:relative; }
.asset.new-entry::before{
  content:"";position:absolute;left:-12px;top:6px;bottom:6px;width:3px;
  background:#e5484d;border-radius:2px;
}
#ruanyf-bar{
  position:fixed;right:16px;bottom:16px;z-index:2147483000;
  display:flex;align-items:center;gap:10px;
  padding:8px 12px;border-radius:999px;
  background:rgba(28,28,30,.92);color:#fff;
  font:12px/1.4 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;
  box-shadow:0 6px 24px rgba(0,0,0,.28);
  backdrop-filter:blur(8px);
  cursor:pointer;user-select:none;
  transition:opacity .3s ease, transform .3s ease;
}
#ruanyf-bar .ruanyf-dot{width:8px;height:8px;border-radius:50%;background:#0a84ff;}
#ruanyf-bar.done .ruanyf-dot{background:#34c759;}
#ruanyf-bar.hidden{opacity:0;transform:translateY(8px);pointer-events:none;}
@media print{ #ruanyf-bar,.ruanyf-badge{display:none} }
`;

function injectStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement("style");
  s.id = STYLE_ID;
  s.textContent = CSS;
  (document.head || document.documentElement).appendChild(s);
}

function makeBadge(kind, label, title) {
  const span = document.createElement("span");
  span.className = `ruanyf-badge ${kind}`;
  span.setAttribute(PILL_ATTR, kind);
  span.textContent = label;
  if (title) span.title = title;
  return span;
}

/** 读后台：单篇状态（content script 读自己的 IDB 与后台不同源，统一走消息） */
async function askArticle(url) {
  try {
    const res = await chrome.runtime.sendMessage({ type: "GET_ARTICLE", url });
    return res?.article || null;
  } catch {
    return null;
  }
}

/** 只挑「文章标题」链接：排除留言锚点、页面内的普通引用链接 */
function articleLinks() {
  return [...document.querySelectorAll('a[href*="/blog/20"]')].filter((a) => {
    const href = a.getAttribute("href") || "";
    if (href.includes("#")) return false; // #comment-xxx、#comments
    if (!/\/blog\/\d{4}\/\d{2}\/[^\/]+\.html$/.test(href.split("#")[0])) return false;
    if (!(a.textContent || "").trim()) return false;
    return Boolean(a.closest(".entry-title, #homepage, li.module-list-item, .module-categories")) ||
      a.getAttribute("rel") === "bookmark";
  });
}

function hostOf(a) {
  return a.closest(".asset, li.module-list-item") || a.parentElement;
}

/** 在列表页的每个条目上贴徽标 */
async function decorateList() {
  const links = articleLinks();
  // 每个 host 只贴一次，避免重复
  const seenHosts = new Set();
  for (const a of links) {
    const host = hostOf(a);
    if (!host || seenHosts.has(host)) continue;
    seenHosts.add(host);

    const url = normalizeUrl(a.getAttribute("href"));
    if (!url) continue;
    const rec = await askArticle(url);

    host.querySelectorAll(`.ruanyf-badge:not([${PILL_ATTR}])`).forEach((n) => n.remove());
    host.classList.remove("read-entry", "unread-entry", "new-entry");

    let badge;
    if (rec?.status === "read") {
      host.classList.add("read-entry");
      badge = makeBadge("read", "已读", rec.readAt ? `已读于 ${new Date(rec.readAt).toLocaleString("zh-CN")}` : "已读");
    } else if (rec?.status === "new") {
      host.classList.add("new-entry", "unread-entry");
      badge = makeBadge("new", "新文章", "上次检查发现的新文章，尚未阅读");
    } else {
      host.classList.add("unread-entry");
      badge = makeBadge("unread", "未读", "还没读过");
    }

    const titleEl = host.querySelector(".entry-title a") || a;
    titleEl.insertAdjacentElement("afterend", badge);
  }
}

/** 文章详情页：跟踪阅读进度，读完自动标已读 */
function trackArticlePage() {
  const url = normalizeUrl(location.href);
  const id = idFromUrl(location.href);
  if (!id) return;

  const bar = document.createElement("div");
  bar.id = "ruanyf-bar";
  bar.innerHTML = `<span class="ruanyf-dot"></span><span class="ruanyf-text">阅读进度 0%</span>`;
  bar.title = "阅读到 90% 自动标记「已读」（点击可跳到底部）";
  (document.body || document.documentElement).appendChild(bar);
  const textEl = bar.querySelector(".ruanyf-text");

  let done = false;
  let maxRatio = 0;
  let activeMs = 0;
  let lastTick = Date.now();

  const computeRatio = () => {
    const el = document.scrollingElement || document.documentElement;
    const full = Math.max(el.scrollHeight, document.body?.scrollHeight || 0);
    if (full <= window.innerHeight + 150) return 1; // 短文章：一屏看完
    return Math.min(1, (window.scrollY + window.innerHeight) / full);
  };

  const render = () => {
    if (done) {
      textEl.textContent = "✓ 已标记为已读";
      bar.classList.add("done");
    } else {
      textEl.textContent = `阅读进度 ${Math.round(maxRatio * 100)}%`;
    }
  };

  const finish = () => {
    if (done) return;
    done = true;
    render();
    const payload = {
      id,
      url,
      title: titleFromDoc(document),
      published: dateFromDoc(document),
      progress: Math.round(maxRatio * 100),
    };
    // 已读状态统一由后台写库（后台持有同一份 IndexedDB，popup 也从后台读）
    chrome.runtime.sendMessage({ type: "ARTICLE_READ", ...payload }).catch(() => {});
    setTimeout(() => bar.classList.add("hidden"), 2600);
  };

  const tick = () => {
    const now = Date.now();
    if (document.visibilityState === "visible" && document.hasFocus()) activeMs += now - lastTick;
    lastTick = now;
    const r = computeRatio();
    if (r > maxRatio) maxRatio = r;
    render();
    if (maxRatio >= READ_RATIO_DONE && activeMs >= DWELL_MS) {
      finish();
      clearInterval(timer);
    }
  };

  const timer = setInterval(tick, 1000);
  bar.addEventListener("click", () => window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" }));
  maxRatio = computeRatio();
  render();
}

function isDetailPage() {
  return /\/blog\/\d{4}\/\d{2}\/[^\/]+\.html/.test(location.pathname);
}

function boot() {
  injectStyle();
  if (isDetailPage()) trackArticlePage();
  else decorateList();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot, { once: true });
} else {
  boot();
}

// 后台状态变了（popup 操作 / 新文章），当前页刷新徽标
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type !== "REFRESH") return;
  document.querySelectorAll(`[${PILL_ATTR}]`).forEach((n) => n.remove());
  if (!isDetailPage()) decorateList();
});