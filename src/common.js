// 共用：站内 URL 归一化、文章条目解析
export const SITE = "https://www.ruanyifeng.com";

/** 把各种写法的文章链接归一成 https://www.ruanyifeng.com/blog/YYYY/MM/xxx.html */
export function normalizeUrl(href) {
  if (!href) return null;
  let u;
  try {
    u = new URL(href, SITE + "/blog/");
  } catch {
    return null;
  }
  if (!/(^|\.)ruanyifeng\.com$/i.test(u.hostname)) return null;
  let p = u.pathname;
  if (!/^\/blog\/\d{4}\/\d{2}\/[^\/]+\.html$/.test(p)) return null;
  return SITE + p;
}

/** 从文章页 URL 取稳定 id：2026/10/weekly-issue-416.html */
export function idFromUrl(url) {
  const u = normalizeUrl(url);
  if (!u) return null;
  return u.slice(SITE.length + "/blog/".length, -".html".length);
}

/** 从 URL 猜发布日期 YYYY-MM-DD（只到月，日不可用），用于兜底排序 */
export function monthFromUrl(url) {
  const id = idFromUrl(url);
  if (!id) return "";
  const m = id.match(/^(\d{4})\/(\d{2})\//);
  return m ? `${m[1]}-${m[2]}` : "";
}

export function titleFromDoc(doc) {
  const t = doc.querySelector("#page-title, h1.entry-title, .entry-title a, title");
  return (t?.textContent || "").replace(/^🐴\s*/, "").replace(/\s*-\s*阮一峰的网络日志\s*$/, "").trim();
}

export function dateFromDoc(doc) {
  const abbr = doc.querySelector("abbr.published[title]");
  if (abbr) {
    const d = new Date(abbr.getAttribute("title"));
    if (!isNaN(d)) return d.toISOString();
  }
  const txt = doc.querySelector(".asset-meta abbr.published, .asset-meta")?.textContent || "";
  const m = txt.match(/(\d{4})年(\d{1,2})月(\d{1,2})日/);
  if (m) {
    const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    return d.toISOString();
  }
  return null;
}

/**
 * 从任意列表页（首页 / 存档页 / 分类页 / 按月页）解析文章条目。
 * 规则：所有指向 /blog/YYYY/MM/*.html 的 rel="bookmark" 链接即为文章标题链接。
 */
export function parseEntriesFromDoc(doc) {
  const found = new Map();
  const push = (url, title, el) => {
    const n = normalizeUrl(url);
    if (!n) return;
    const prev = found.get(n);
    if (!prev || (!prev.title && title)) {
      found.set(n, { url: n, title: title || "", id: idFromUrl(n) });
    }
  };

  for (const a of doc.querySelectorAll("a[href]")) {
    const href = a.getAttribute("href");
    if (!hoverIsArticle(href)) continue;
    // 标题链接：rel=bookmark，或位于 .entry-title / 列表项中且文字较长
    const inTitle = a.closest(".entry-title, h2, h3, .module-list-item");
    const text = (a.textContent || "").trim();
    if (a.getAttribute("rel") === "bookmark" || (inTitle && text.length > 6)) {
      push(href, text, a);
    }
  }
  return [...found.values()];
}

function hoverIsArticle(href) {
  return /\/blog\/\d{4}\/\d{2}\/[^\/]+\.html(#.*)?$/.test(href || "");
}

/** 深翻列表页：BFS 抓取站内所有列表页，尽量凑齐全部文章（受 limit / depth 限制） */
export const LIST_PAGE_PATTERN = /^https:\/\/www\.ruanyifeng\.com\/(blog\/(\d{4}\/(\d{2}\/)?)?|blog\/archives\.html$)/;

export function isListPage(url) {
  const u = new URL(url);
  if (u.hostname !== "www.ruanyifeng.com") return false;
  const p = u.pathname;
  if (p === "/blog/" || p === "/blog/index.html" || p === "/blog/archives.html") return true;
  if (/^\/blog\/\d{4}\/$/.test(p)) return true;
  if (/^\/blog\/\d{4}\/\d{2}\/$/.test(p)) return true;
  if (/^\/blog\/[a-z0-9_-]+\/$/i.test(p)) return true; // 分类页 /blog/weekly/
  return false;
}
/* ────────────────────────────────────────
 * MV3 service worker 里没有 DOMParser / document，
 * 这里用一个够用的轻量 HTML「伪 DOM」解析，供后台抓取列表页使用。
 * ──────────────────────────────────────── */

function decodeEntities(s) {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n));
}

function stripTags(s) {
  return decodeEntities(s.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}

/** 极简查询：返回 [{attrs, text, html}] 形式的元素列表（只支持按标签 + 简单 class 筛选） */
function queryAll(html, tag, className) {
  const out = [];
  const re = new RegExp(`<${tag}\\b([^>]*)>([\\s\\S]*?)</${tag}>`, "gi");
  let m;
  while ((m = re.exec(html))) {
    const attrsRaw = m[1];
    const attrs = {};
    for (const a of attrsRaw.matchAll(/([\w:-]+)\s*=\s*"([^"]*)"|([\w:-]+)\s*=\s*'([^']*)'/g)) {
      attrs[(a[1] || a[3]).toLowerCase()] = a[2] ?? a[4];
    }
    if (className) {
      const cls = attrs["class"] || "";
      if (!className.split(".").every((c) => cls.split(/\s+/).includes(c))) continue;
    }
    out.push({ attrs, html: m[2], text: stripTags(m[2]) });
  }
  return out;
}

/** 从一段 HTML 解析文章条目（后台用）：{id,url,title,published} */
export function parseEntriesFromHtml(html) {
  const found = new Map();
  // 列表项里的「文章链接 + 日期」最可靠
  for (const li of queryAll(html, "li", "module-list-item")) {
    const a = queryAll(li.html, "a").find((x) => hoverIsArticle(x.attrs.href));
    if (!a) continue;
    const url = normalizeUrl(a.attrs.href);
    if (!url) continue;
    const dateM = li.text.match(/(\d{4})\.(\d{1,2})\.(\d{1,2})/);
    let published = null;
    if (dateM) published = new Date(Date.UTC(+dateM[1], +dateM[2] - 1, +dateM[3])).toISOString();
    const prev = found.get(idFromUrl(url));
    found.set(idFromUrl(url), {
      id: idFromUrl(url),
      url,
      title: prev?.title && prev.title.length > a.text.length ? prev.title : a.text,
      published: prev?.published || published,
    });
  }
  // 正文区块的标题链接（rel=bookmark）
  for (const a of queryAll(html, "a")) {
    if (a.attrs.rel !== "bookmark") continue;
    const url = normalizeUrl(a.attrs.href);
    if (!url) continue;
    const id = idFromUrl(url);
    const prev = found.get(id);
    if (!prev || !prev.title) found.set(id, { id, url, title: a.text, published: prev?.published || null });
  }
  return [...found.values()];
}

/** 从 HTML 里找最新一篇文章（首页顶部），并补上 abbr.published 的精确时间 */
export function parseLatestFromHtml(html) {
  const entries = parseEntriesFromHtml(html);
  if (!entries.length) return null;
  const top = entries[0];
  const m = html.match(/<abbr[^>]*class="[^"]*published[^"]*"[^>]*title="([^"]+)"/i);
  if (m) {
    const d = new Date(decodeEntities(m[1]));
    if (!isNaN(d)) top.published = d.toISOString();
  }
  return top;
}

/** 从 HTML 抽出所有站内列表页链接（按月 / 分类 / 存档） */
export function listPageLinksFromHtml(html, baseUrl) {
  const out = new Set();
  for (const a of queryAll(html, "a")) {
    const href = a.attrs.href;
    if (!href) continue;
    try {
      const abs = new URL(decodeEntities(href), baseUrl).href.split("#")[0];
      if (isListPage(abs)) out.add(abs);
    } catch {
      /* ignore */
    }
  }
  return [...out];
}
