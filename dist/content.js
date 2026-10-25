(() => {
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
  function titleFromDoc(doc) {
    const t = doc.querySelector("#page-title, h1.entry-title, .entry-title a, title");
    return (t?.textContent || "").replace(/^🐴\s*/, "").replace(/\s*-\s*阮一峰的网络日志\s*$/, "").trim();
  }
  function dateFromDoc(doc) {
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

  // src/content.js
  var STYLE_ID = "ruanyf-reader-style";
  var PILL_ATTR = "data-ruanyf-pill";
  var READ_RATIO_DONE = 0.9;
  var DWELL_MS = 1500;
  var CSS = `
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
/* \u5DF2\u8BFB\u7684\u6587\u7AE0\u6807\u9898\u964D\u6DE1\uFF0C\u89C6\u89C9\u4E0A\u4E00\u773C\u626B\u51FA\u6CA1\u8BFB\u7684 */
.read-entry h2.asset-name a{ opacity:.55; }
.read-entry h2.asset-name a::after{content:" \u2713";color:#0b7a3b;font-weight:700;}
.unread-entry h2.asset-name a{ font-weight:700; }
.module-list-item.read-entry > a{ opacity:.6; }
/* \u65B0\u6587\u7AE0\uFF1A\u5DE6\u4FA7\u7EA2\u6761 */
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
  async function askArticle(url) {
    try {
      const res = await chrome.runtime.sendMessage({ type: "GET_ARTICLE", url });
      return res?.article || null;
    } catch {
      return null;
    }
  }
  function articleLinks() {
    return [...document.querySelectorAll('a[href*="/blog/20"]')].filter((a) => {
      const href = a.getAttribute("href") || "";
      if (href.includes("#")) return false;
      if (!/\/blog\/\d{4}\/\d{2}\/[^\/]+\.html$/.test(href.split("#")[0])) return false;
      if (!(a.textContent || "").trim()) return false;
      return Boolean(a.closest(".entry-title, #homepage, li.module-list-item, .module-categories")) || a.getAttribute("rel") === "bookmark";
    });
  }
  function hostOf(a) {
    return a.closest(".asset, li.module-list-item") || a.parentElement;
  }
  async function decorateList() {
    const links = articleLinks();
    const seenHosts = /* @__PURE__ */ new Set();
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
        badge = makeBadge("read", "\u5DF2\u8BFB", rec.readAt ? `\u5DF2\u8BFB\u4E8E ${new Date(rec.readAt).toLocaleString("zh-CN")}` : "\u5DF2\u8BFB");
      } else if (rec?.status === "new") {
        host.classList.add("new-entry", "unread-entry");
        badge = makeBadge("new", "\u65B0\u6587\u7AE0", "\u4E0A\u6B21\u68C0\u67E5\u53D1\u73B0\u7684\u65B0\u6587\u7AE0\uFF0C\u5C1A\u672A\u9605\u8BFB");
      } else {
        host.classList.add("unread-entry");
        badge = makeBadge("unread", "\u672A\u8BFB", "\u8FD8\u6CA1\u8BFB\u8FC7");
      }
      const titleEl = host.querySelector(".entry-title a") || a;
      titleEl.insertAdjacentElement("afterend", badge);
    }
  }
  function trackArticlePage() {
    const url = normalizeUrl(location.href);
    const id = idFromUrl(location.href);
    if (!id) return;
    const bar = document.createElement("div");
    bar.id = "ruanyf-bar";
    bar.innerHTML = `<span class="ruanyf-dot"></span><span class="ruanyf-text">\u9605\u8BFB\u8FDB\u5EA6 0%</span>`;
    bar.title = "\u9605\u8BFB\u5230 90% \u81EA\u52A8\u6807\u8BB0\u300C\u5DF2\u8BFB\u300D\uFF08\u70B9\u51FB\u53EF\u8DF3\u5230\u5E95\u90E8\uFF09";
    (document.body || document.documentElement).appendChild(bar);
    const textEl = bar.querySelector(".ruanyf-text");
    let done = false;
    let maxRatio = 0;
    let activeMs = 0;
    let lastTick = Date.now();
    const computeRatio = () => {
      const el = document.scrollingElement || document.documentElement;
      const full = Math.max(el.scrollHeight, document.body?.scrollHeight || 0);
      if (full <= window.innerHeight + 150) return 1;
      return Math.min(1, (window.scrollY + window.innerHeight) / full);
    };
    const render = () => {
      if (done) {
        textEl.textContent = "\u2713 \u5DF2\u6807\u8BB0\u4E3A\u5DF2\u8BFB";
        bar.classList.add("done");
      } else {
        textEl.textContent = `\u9605\u8BFB\u8FDB\u5EA6 ${Math.round(maxRatio * 100)}%`;
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
        progress: Math.round(maxRatio * 100)
      };
      chrome.runtime.sendMessage({ type: "ARTICLE_READ", ...payload }).catch(() => {
      });
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
    const timer = setInterval(tick, 1e3);
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
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type !== "REFRESH") return;
    document.querySelectorAll(`[${PILL_ATTR}]`).forEach((n) => n.remove());
    if (!isDetailPage()) decorateList();
  });
})();
