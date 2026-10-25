// popup：列表渲染 + 手动操作（数据全部走后台，保证与 content script 共用同一个 IndexedDB 源）
const listEl = document.getElementById("list");
const statusEl = document.getElementById("status");
const statEl = document.getElementById("stats");
const checkBtn = document.getElementById("check");
const scanBtn = document.getElementById("scan");
const tabs = document.querySelectorAll(".tab");

let activeTab = "unread";
let items = [];

const send = (msg) => chrome.runtime.sendMessage(msg);

function fmtDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d)) return "";
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function fmtAgo(ts) {
  if (!ts) return "从未";
  const t = typeof ts === "number" ? ts : new Date(ts).getTime();
  const diff = Date.now() - t;
  if (diff < 0) return "刚刚";
  if (diff < 60e3) return "刚刚";
  if (diff < 3600e3) return `${Math.floor(diff / 60e3)} 分钟前`;
  if (diff < 86400e3) return `${Math.floor(diff / 3600e3)} 小时前`;
  return `${Math.floor(diff / 86400e3)} 天前`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

async function load() {
  const res = await send({ type: "LIST_ARTICLES" });
  items = res?.items || [];
  render();
  renderStatus();
}

function render() {
  const read = items.filter((a) => a.status === "read");
  const unread = items.filter((a) => a.status === "unread");
  const fresh = items.filter((a) => a.status === "new");

  statEl.innerHTML = `
    <span class="chip read">已读 ${read.length}</span>
    <span class="chip unread">未读 ${unread.length}</span>
    ${fresh.length ? `<span class="chip new">新入库 ${fresh.length}</span>` : ""}`;

  const source =
    activeTab === "unread"
      ? [...fresh, ...unread].sort((a, b) => (b.published || "").localeCompare(a.published || ""))
      : [...read].sort((a, b) => (b.readAt || "").localeCompare(a.readAt || ""));

  if (!source.length) {
    listEl.innerHTML = `<div class="empty">${
      activeTab === "unread"
        ? "暂无未读记录<br/><span style='font-size:11px'>点下方「导入历史文章」建立档案，或直接上站点读（读到 90% 自动记已读）</span>"
        : "还没有已读记录"
    }</div>`;
    return;
  }

  listEl.innerHTML = "";
  for (const a of source.slice(0, 80)) {
    const row = document.createElement("div");
    row.className = `row ${a.status}`;
    row.innerHTML = `
      <a class="title" href="${escapeHtml(a.url)}" target="_blank" rel="noopener">${escapeHtml(a.title || a.url)}</a>
      <div class="meta">
        <span>${fmtDate(a.published)}</span>
        ${a.status === "new" || a.status === "unread" ? `<span class="tag new">未读</span>` : ""}
        ${a.status === "read" ? `<span class="tag read">读于 ${fmtAgo(a.readAt)}</span>` : ""}
      </div>`;
    const actions = document.createElement("div");
    actions.className = "actions";
    const b = document.createElement("button");
    b.textContent = a.status === "read" ? "恢复未读" : "标为已读";
    b.onclick = async () => {
      await send({ type: a.status === "read" ? "SET_UNREAD" : "MARK_READ", id: a.id });
      await load();
      notifyTabRefresh();
    };
    actions.appendChild(b);
    row.appendChild(actions);
    listEl.appendChild(row);
  }
  if (source.length > 80) {
    const more = document.createElement("div");
    more.className = "empty";
    more.textContent = `仅显示 80 条（共 ${source.length} 条）`;
    listEl.appendChild(more);
  }
}

async function notifyTabRefresh() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id) chrome.tabs.sendMessage(tab.id, { type: "REFRESH" }).catch(() => {});
}

async function updateBadge() {
  const pending = items.filter((a) => a.status === "new").length;
  try {
    if (pending > 0) {
      await chrome.action.setBadgeBackgroundColor({ color: "#e5484d" });
      await chrome.action.setBadgeText({ text: String(pending) });
    } else {
      await chrome.action.setBadgeText({ text: "" });
    }
  } catch {}
}

async function renderStatus() {
  const st = await send({ type: "GET_STATE" });
  if (st?.lastError) {
    statusEl.textContent = `⚠️ 上次检查失败：${st.lastError.msg}`;
    statusEl.className = "status err";
    return;
  }
  statusEl.textContent = `上次检查：${fmtAgo(st?.lastCheck)}`;
  statusEl.className = "status";
}

checkBtn.onclick = async () => {
  checkBtn.disabled = true;
  checkBtn.textContent = "检查中…";
  const res = await send({ type: "CHECK_NOW" });
  checkBtn.disabled = false;
  checkBtn.textContent = "立即检查更新";
  if (res?.ok) {
    statusEl.textContent = res.isNew ? `✅ 发现新文章：${res.newest?.title || ""}` : "✅ 已是最新，没有新文章";
    statusEl.className = "status";
  } else {
    statusEl.textContent = `⚠️ 检查失败：${res?.error || "未知错误"}`;
    statusEl.className = "status err";
  }
  await load();
};

scanBtn.onclick = async () => {
  scanBtn.disabled = true;
  scanBtn.textContent = "抓取中…";
  const res = await send({ type: "SCAN_ALL" });
  scanBtn.disabled = false;
  scanBtn.textContent = "导入历史文章";
  if (res?.ok) {
    statusEl.textContent = `✅ 扫描 ${res.pages} 页，收录 ${res.scanned} 篇，新增 ${res.added} 篇`;
    statusEl.className = "status";
  } else {
    statusEl.textContent = `⚠️ 导入失败：${res?.error || "未知错误"}`;
    statusEl.className = "status err";
  }
  await load();
};

tabs.forEach((t) =>
  t.addEventListener("click", () => {
    tabs.forEach((x) => x.classList.toggle("active", x === t));
    activeTab = t.dataset.tab;
    render();
  })
);

load().then(updateBadge);