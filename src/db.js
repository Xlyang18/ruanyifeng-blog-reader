import { openDB } from "idb";

const DB_NAME = "ruanyf-reader";
const DB_VERSION = 1;

let dbPromise = null;

export function db() {
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
      },
    });
  }
  return dbPromise;
}

export async function getAllArticles() {
  return (await db()).getAll("articles");
}

export async function getArticle(id) {
  return (await db()).get("articles", id);
}

export async function putArticles(list) {
  if (!list.length) return 0;
  const d = await db();
  const tx = d.transaction("articles", "readwrite");
  for (const item of list) tx.store.put(item);
  await tx.done;
  return list.length;
}

export async function getMeta(key) {
  return (await db()).get("meta", key);
}

export async function setMeta(key, value) {
  await (await db()).put("meta", value, key);
}

export async function stats() {
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

/** 与站点对比：本地库已知的最新文章 vs 站点最新一篇文章 */
export async function reconcileFresh(list) {
  const d = await db();
  const now = new Date().toISOString();
  let added = [];
  const freshIds = new Set();
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
        archived: Boolean(item.archived),
      };
      tx.store.put(rec);
      added.push(rec);
    } else {
      // 已存在：补全标题/日期，不改阅读状态
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

export async function markRead(id, extra = {}) {
  const d = await db();
  const rec = await d.get("articles", id);
  if (!rec) return null;
  rec.status = "read";
  rec.readAt = rec.readAt || new Date().toISOString();
  Object.assign(rec, extra);
  await d.put("articles", rec);
  return rec;
}

export async function setStatus(id, status) {
  const d = await db();
  const rec = await d.get("articles", id);
  if (!rec) return null;
  rec.status = status;
  if (status === "read") rec.readAt = rec.readAt || new Date().toISOString();
  if (status === "unread") rec.readAt = null;
  await d.put("articles", rec);
  return rec;
}

/** 用站点数据补全「标题/日期」，让 popup 列表好看 */
export async function hydrate(entries) {
  const d = await db();
  const out = [];
  for (const e of entries) {
    const base = { id: e.id, url: e.url, title: e.title, published: e.published || null };
    if (!base.title || !base.published) {
      const rec = await d.get("articles", e.id);
      out.push({ ...base, title: base.title || rec?.title || "", published: base.published || rec?.published || null });
    } else out.push(base);
  }
  return out;
}
