// node_modules/idb/build/index.js
var instanceOfAny = (object, constructors) => constructors.some((c) => object instanceof c);
var idbProxyableTypes;
var cursorAdvanceMethods;
function getIdbProxyableTypes() {
  return idbProxyableTypes || (idbProxyableTypes = [
    IDBIndex,
    IDBObjectStore,
    IDBCursor,
    IDBDatabase,
    IDBTransaction
  ]);
}
function getCursorAdvanceMethods() {
  return cursorAdvanceMethods || (cursorAdvanceMethods = ["advance", "continue", "continuePrimaryKey"].map((method) => IDBCursor.prototype[method]));
}
var transactionDoneMap = /* @__PURE__ */ new WeakMap();
var transformCache = /* @__PURE__ */ new WeakMap();
var reverseTransformCache = /* @__PURE__ */ new WeakMap();
function promisifyRequest(request) {
  const promise = new Promise((resolve, reject) => {
    const unlisten = () => {
      request.removeEventListener("success", success);
      request.removeEventListener("error", error);
    };
    const success = () => {
      resolve(wrap(request.result));
      unlisten();
    };
    const error = () => {
      reject(request.error);
      unlisten();
    };
    request.addEventListener("success", success);
    request.addEventListener("error", error);
  });
  reverseTransformCache.set(promise, request);
  return promise;
}
function cacheDonePromiseForTransaction(tx) {
  if (transactionDoneMap.has(tx))
    return;
  const done = new Promise((resolve, reject) => {
    const unlisten = () => {
      tx.removeEventListener("complete", complete);
      tx.removeEventListener("error", error);
      tx.removeEventListener("abort", error);
    };
    const complete = () => {
      resolve();
      unlisten();
    };
    const error = () => {
      reject(tx.error || new DOMException("AbortError", "AbortError"));
      unlisten();
    };
    tx.addEventListener("complete", complete);
    tx.addEventListener("error", error);
    tx.addEventListener("abort", error);
  });
  transactionDoneMap.set(tx, done);
}
var idbProxyTraps = {
  get(target, prop, receiver) {
    if (target instanceof IDBTransaction) {
      if (prop === "done")
        return transactionDoneMap.get(target);
      if (prop === "store") {
        return receiver.objectStoreNames[1] ? void 0 : receiver.objectStore(receiver.objectStoreNames[0]);
      }
    }
    return wrap(target[prop]);
  },
  set(target, prop, value) {
    target[prop] = value;
    return true;
  },
  has(target, prop) {
    if (target instanceof IDBTransaction && (prop === "done" || prop === "store")) {
      return true;
    }
    return prop in target;
  }
};
function replaceTraps(callback) {
  idbProxyTraps = callback(idbProxyTraps);
}
function wrapFunction(func) {
  if (getCursorAdvanceMethods().includes(func)) {
    return function(...args) {
      func.apply(unwrap(this), args);
      return wrap(this.request);
    };
  }
  return function(...args) {
    return wrap(func.apply(unwrap(this), args));
  };
}
function transformCachableValue(value) {
  if (typeof value === "function")
    return wrapFunction(value);
  if (value instanceof IDBTransaction)
    cacheDonePromiseForTransaction(value);
  if (instanceOfAny(value, getIdbProxyableTypes()))
    return new Proxy(value, idbProxyTraps);
  return value;
}
function wrap(value) {
  if (value instanceof IDBRequest)
    return promisifyRequest(value);
  if (transformCache.has(value))
    return transformCache.get(value);
  const newValue = transformCachableValue(value);
  if (!Object.is(newValue, value)) {
    transformCache.set(value, newValue);
    reverseTransformCache.set(newValue, value);
  }
  return newValue;
}
var unwrap = (value) => reverseTransformCache.get(value);
function openDB(name, version, { blocked, upgrade, blocking, terminated } = {}) {
  const request = indexedDB.open(name, version);
  const openPromise = wrap(request);
  if (upgrade) {
    request.addEventListener("upgradeneeded", (event) => {
      upgrade(wrap(request.result), event.oldVersion, event.newVersion, wrap(request.transaction), event);
    });
  }
  if (blocked) {
    request.addEventListener("blocked", (event) => blocked(
      // Casting due to https://github.com/microsoft/TypeScript-DOM-lib-generator/pull/1405
      event.oldVersion,
      event.newVersion,
      event
    ));
  }
  openPromise.then((db2) => {
    if (terminated)
      db2.addEventListener("close", () => terminated());
    if (blocking) {
      db2.addEventListener("versionchange", (event) => blocking(event.oldVersion, event.newVersion, event));
    }
  }).catch(() => {
  });
  return openPromise;
}
var readMethods = ["get", "getKey", "getAll", "getAllKeys", "count"];
var writeMethods = ["put", "add", "delete", "clear"];
var cachedMethods = {};
function getMethod(target, prop) {
  if (!(target instanceof IDBDatabase && !(prop in target) && typeof prop === "string")) {
    return;
  }
  if (cachedMethods[prop])
    return cachedMethods[prop];
  const targetFuncName = prop.replace(/FromIndex$/, "");
  const useIndex = prop !== targetFuncName;
  const isWrite = writeMethods.includes(targetFuncName);
  if (
    // Bail if the target doesn't exist on the target. Eg, getAll isn't in Edge.
    !(targetFuncName in (useIndex ? IDBIndex : IDBObjectStore).prototype) || !(isWrite || readMethods.includes(targetFuncName))
  ) {
    return;
  }
  const method = async function(storeName, ...args) {
    const tx = this.transaction(storeName, isWrite ? "readwrite" : "readonly");
    let target2 = tx.store;
    if (useIndex)
      target2 = target2.index(args.shift());
    return (await Promise.all([
      target2[targetFuncName](...args),
      isWrite && tx.done
    ]))[0];
  };
  return cachedMethods[prop] = method;
}
replaceTraps((oldTraps) => ({
  ...oldTraps,
  get: (target, prop, receiver) => getMethod(target, prop) || oldTraps.get(target, prop, receiver),
  has: (target, prop) => !!getMethod(target, prop) || oldTraps.has(target, prop)
}));
var advanceMethodProps = ["advance", "continue", "continuePrimaryKey"];
var methodMap = {};
var advanceResults = /* @__PURE__ */ new WeakMap();
var ittrProxiedCursorToOriginalProxy = /* @__PURE__ */ new WeakMap();
var cursorIteratorTraps = {
  get(target, prop) {
    if (!advanceMethodProps.includes(prop))
      return target[prop];
    let cachedFunc = methodMap[prop];
    if (!cachedFunc) {
      cachedFunc = methodMap[prop] = function(...args) {
        advanceResults.set(this, ittrProxiedCursorToOriginalProxy.get(this)[prop](...args));
      };
    }
    return cachedFunc;
  }
};
async function* iterate(...args) {
  let cursor = this;
  if (!(cursor instanceof IDBCursor)) {
    cursor = await cursor.openCursor(...args);
  }
  if (!cursor)
    return;
  cursor = cursor;
  const proxiedCursor = new Proxy(cursor, cursorIteratorTraps);
  ittrProxiedCursorToOriginalProxy.set(proxiedCursor, cursor);
  reverseTransformCache.set(proxiedCursor, unwrap(cursor));
  while (cursor) {
    yield proxiedCursor;
    cursor = await (advanceResults.get(proxiedCursor) || cursor.continue());
    advanceResults.delete(proxiedCursor);
  }
}
function isIteratorProp(target, prop) {
  return prop === Symbol.asyncIterator && instanceOfAny(target, [IDBIndex, IDBObjectStore, IDBCursor]) || prop === "iterate" && instanceOfAny(target, [IDBIndex, IDBObjectStore]);
}
replaceTraps((oldTraps) => ({
  ...oldTraps,
  get(target, prop, receiver) {
    if (isIteratorProp(target, prop))
      return iterate;
    return oldTraps.get(target, prop, receiver);
  },
  has(target, prop) {
    return isIteratorProp(target, prop) || oldTraps.has(target, prop);
  }
}));

// src/db.js
var DB_NAME = "ruanyf-reader";
var DB_VERSION = 1;
var dbPromise = null;
function db() {
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, DB_VERSION, {
      upgrade(d) {
        if (!d.objectStoreNames.contains("articles")) {
          const s = d.createObjectStore("articles", { keyPath: "id" });
          s.createIndex("url", "url", { unique: false });
          s.createIndex("published", "published", { unique: false });
          s.createIndex("status", "status", { unique: false });
        }
        if (!d.objectStoreNames.contains("meta")) {
          d.createObjectStore("meta");
        }
      }
    });
  }
  return dbPromise;
}
async function getAllArticles() {
  return (await db()).getAll("articles");
}
async function getMeta(key) {
  return (await db()).get("meta", key);
}
async function setMeta(key, value) {
  await (await db()).put("meta", value, key);
}
async function stats() {
  const all = await getAllArticles();
  let read = 0;
  let unread = 0;
  let newest = null;
  for (const a of all) {
    if (a.status === "read") read++;
    else if (a.status !== "skipped") unread++;
    if (a.published && (!newest || a.published > newest)) newest = a.published;
  }
  return { total: all.length, read, unread, newest };
}
async function reconcileFresh(list) {
  const d = await db();
  const now = (/* @__PURE__ */ new Date()).toISOString();
  let added = [];
  const freshIds = /* @__PURE__ */ new Set();
  const tx = d.transaction("articles", "readwrite");
  for (const item of list) {
    const old = await tx.store.get(item.id);
    freshIds.add(item.id);
    if (!old) {
      const rec = {
        id: item.id,
        url: item.url,
        title: item.title,
        published: item.published || null,
        status: "new",
        discoveredAt: now,
        firstSeenOnSite: now,
        readAt: null,
        archived: Boolean(item.archived)
      };
      tx.store.put(rec);
      added.push(rec);
    } else {
      let dirty = false;
      if ((!old.title || old.title.length < 2) && item.title) {
        old.title = item.title;
        dirty = true;
      }
      if (!old.published && item.published) {
        old.published = item.published;
        dirty = true;
      }
      if (!old.url) {
        old.url = item.url;
        dirty = true;
      }
      if (dirty) tx.store.put(old);
    }
  }
  await tx.done;
  return { added, freshIds: [...freshIds] };
}
async function markRead(id, extra = {}) {
  const d = await db();
  const rec = await d.get("articles", id);
  if (!rec) return null;
  rec.status = "read";
  rec.readAt = rec.readAt || (/* @__PURE__ */ new Date()).toISOString();
  Object.assign(rec, extra);
  await d.put("articles", rec);
  return rec;
}

// src/common.js
var SITE = "https://www.ruanyifeng.com";
function normalizeUrl(href) {
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
function idFromUrl(url) {
  const u = normalizeUrl(url);
  if (!u) return null;
  return u.slice(SITE.length + "/blog/".length, -".html".length);
}
function hoverIsArticle(href) {
  return /\/blog\/\d{4}\/\d{2}\/[^\/]+\.html(#.*)?$/.test(href || "");
}
function isListPage(url) {
  const u = new URL(url);
  if (u.hostname !== "www.ruanyifeng.com") return false;
  const p = u.pathname;
  if (p === "/blog/" || p === "/blog/index.html" || p === "/blog/archives.html") return true;
  if (/^\/blog\/\d{4}\/$/.test(p)) return true;
  if (/^\/blog\/\d{4}\/\d{2}\/$/.test(p)) return true;
  if (/^\/blog\/[a-z0-9_-]+\/$/i.test(p)) return true;
  return false;
}
function decodeEntities(s) {
  return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n));
}
function stripTags(s) {
  return decodeEntities(s.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}
function queryAll(html, tag, className) {
  const out = [];
  const re = new RegExp(`<${tag}\\b([^>]*)>([\\s\\S]*?)</${tag}>`, "gi");
  let m;
  while (m = re.exec(html)) {
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
function parseEntriesFromHtml(html) {
  const found = /* @__PURE__ */ new Map();
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
      published: prev?.published || published
    });
  }
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
function parseLatestFromHtml(html) {
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
function listPageLinksFromHtml(html, baseUrl) {
  const out = /* @__PURE__ */ new Set();
  for (const a of queryAll(html, "a")) {
    const href = a.attrs.href;
    if (!href) continue;
    try {
      const abs = new URL(decodeEntities(href), baseUrl).href.split("#")[0];
      if (isListPage(abs)) out.add(abs);
    } catch {
    }
  }
  return [...out];
}

// src/background-parts.js
var ALARM = "daily-check";
var LAST_CHECK = "lastCheck";
var SEEN_LATEST = "seenLatestId";
var HOME = `${SITE}/blog/index.html`;
var ARCHIVE = `${SITE}/blog/archives.html`;
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
async function scheduleDaily() {
  const alarm = await chrome.alarms.get(ALARM);
  if (!alarm) {
    const when = /* @__PURE__ */ new Date();
    when.setHours(9, 0, 0, 0);
    if (when.getTime() <= Date.now()) when.setDate(when.getDate() + 1);
    chrome.alarms.create(ALARM, { when: when.getTime(), periodInMinutes: 60 * 24 });
  }
}
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === ALARM) runCheck({ source: "alarm" });
});
async function maybeCheckDaily(source) {
  const last = await getMeta(LAST_CHECK) || 0;
  const today = /* @__PURE__ */ new Date();
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
        const d = await db();
        const id = msg.id || idFromUrl(msg.url);
        const old = await d.get("articles", id);
        const now = (/* @__PURE__ */ new Date()).toISOString();
        await d.put("articles", {
          ...old || {},
          id,
          url: msg.url,
          title: old && old.title || msg.title || "",
          published: old && old.published || msg.published || null,
          status: "read",
          discoveredAt: old && old.discoveredAt || now,
          firstSeenOnSite: old && old.firstSeenOnSite || null,
          readAt: now,
          readProgress: msg.progress ?? 100,
          archived: Boolean(old && old.archived)
        });
        const fresh = await d.get("articles", id);
        if (fresh) await chrome.action.setBadgeText({ text: "" }).catch(() => {
        });
        sendResponse({ ok: true });
      } else if (msg?.type === "MARK_READ") {
        await markRead(msg.id, { readAt: (/* @__PURE__ */ new Date()).toISOString() });
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
        const d = await db();
        const now = (/* @__PURE__ */ new Date()).toISOString();
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
            archived: false
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
function stripHeavy(a) {
  return {
    id: a.id,
    url: a.url,
    title: a.title,
    published: a.published || null,
    status: a.status,
    readAt: a.readAt || null,
    discoveredAt: a.discoveredAt || null
  };
}
async function getByUrl(url) {
  const n = normalizeUrl(url);
  if (!n) return null;
  return (await db()).get("articles", idFromUrl(n));
}
async function getState() {
  const s = await stats();
  const last = await getMeta(LAST_CHECK) || 0;
  const seenLatest = await getMeta(SEEN_LATEST);
  const notifyErr = await getMeta("lastNotifyError");
  return { ...s, lastCheck: last, seenLatest, lastError: await getMeta("lastError"), lastNotifyError: notifyErr, now: Date.now() };
}
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
function htmlTitle(html) {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? m[1].replace(/<[^>]*>/g, "").replace(/&amp;/g, "&").trim() : "";
}
function extractListPageDatesFromHtml(html) {
  const map = /* @__PURE__ */ new Map();
  for (const e of parseEntriesFromHtml(html)) if (e.published) map.set(e.id, e.published);
  return map;
}
async function fetchHomepage() {
  return parseEntriesFromHtml(await fetchText(HOME));
}
async function fetchArticleMeta(url) {
  try {
    const html = await fetchText(url);
    const id = idFromUrl(url);
    const found = parseEntriesFromHtml(html).find((e) => e.id === id);
    let title = found?.title || htmlTitle(html).replace(/\s*-\s*阮一峰的网络日志\s*$/, "").replace(/^🐴\s*/, "");
    const m = html.match(/<abbr[^>]*class="[^"]*published[^"]*"[^>]*title="([^"]+)"/i);
    const published = m && !isNaN(new Date(m[1])) ? new Date(m[1]).toISOString() : null;
    return { title, published };
  } catch {
    return { title: "", published: null };
  }
}
async function runCheck({ source = "auto", force = false } = {}) {
  const d = await db();
  let newest = null;
  try {
    const html = await fetchText(HOME);
    newest = parseLatestFromHtml(html);
    if (!newest) throw new Error("\u9996\u9875\u672A\u89E3\u6790\u5230\u6587\u7AE0");
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
  if (isNew) {
    const now = (/* @__PURE__ */ new Date()).toISOString();
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
        archived: false
      });
    } else if (rec.status === "new") {
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
  const title = art.title || "\u962E\u4E00\u5CF0\u53D1\u5E03\u4E86\u65B0\u6587\u7AE0";
  try {
    await chrome.action.setBadgeBackgroundColor({ color: "#e5484d" });
    await chrome.action.setBadgeText({ text: "NEW" });
  } catch {
  }
  try {
    await chrome.notifications.create(`ruanyf-${art.id}`, {
      type: "basic",
      iconUrl: chrome.runtime.getURL("icons/icon128.png"),
      title: "\u{1F4DA} \u962E\u4E00\u5CF0\u66F4\u65B0\u4E86",
      message: title,
      contextMessage: "\u70B9\u51FB\u6253\u5F00\u6587\u7AE0",
      priority: 2,
      requireInteraction: true,
      buttons: [{ title: "\u6253\u5F00\u6587\u7AE0" }, { title: "\u7A0D\u540E\u518D\u8BF4" }]
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
async function scanAll({ maxPages = 80, maxMs = 45e3 } = {}) {
  const started = Date.now();
  const seenPages = /* @__PURE__ */ new Set(["__start__"]);
  let queue = [HOME, ARCHIVE];
  const articles = /* @__PURE__ */ new Map();
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
      for (const abs of listPageLinksFromHtml(html, u)) {
        if (seenPages.has(abs)) continue;
        seenPages.add(abs);
        queue.push(abs);
      }
    }
  }
  const list = [...articles.values()];
  const { added } = await reconcileFresh(list);
  await setMeta("lastScan", { at: Date.now(), scanned: list.length, added: added.length, pages: pageCount });
  return { ok: true, scanned: list.length, added: added.length, pages: pageCount };
}
globalThis.__ruanyf = { runCheck, scanAll, getState, ensureSeenBaseline, fetchText, parseEntriesFromHtml, SITE };
