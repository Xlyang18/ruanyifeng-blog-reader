// src/popup.js
var listEl = document.getElementById("list");
var statusEl = document.getElementById("status");
var statEl = document.getElementById("stats");
var checkBtn = document.getElementById("check");
var scanBtn = document.getElementById("scan");
var tabs = document.querySelectorAll(".tab");
var activeTab = "unread";
var items = [];
var send = (msg) => chrome.runtime.sendMessage(msg);
function fmtDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d)) return "";
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function fmtAgo(ts) {
  if (!ts) return "\u4ECE\u672A";
  const t = typeof ts === "number" ? ts : new Date(ts).getTime();
  const diff = Date.now() - t;
  if (diff < 0) return "\u521A\u521A";
  if (diff < 6e4) return "\u521A\u521A";
  if (diff < 36e5) return `${Math.floor(diff / 6e4)} \u5206\u949F\u524D`;
  if (diff < 864e5) return `${Math.floor(diff / 36e5)} \u5C0F\u65F6\u524D`;
  return `${Math.floor(diff / 864e5)} \u5929\u524D`;
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
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
    <span class="chip read">\u5DF2\u8BFB ${read.length}</span>
    <span class="chip unread">\u672A\u8BFB ${unread.length}</span>
    ${fresh.length ? `<span class="chip new">\u65B0\u5165\u5E93 ${fresh.length}</span>` : ""}`;
  const source = activeTab === "unread" ? [...fresh, ...unread].sort((a, b) => (b.published || "").localeCompare(a.published || "")) : [...read].sort((a, b) => (b.readAt || "").localeCompare(a.readAt || ""));
  if (!source.length) {
    listEl.innerHTML = `<div class="empty">${activeTab === "unread" ? "\u6682\u65E0\u672A\u8BFB\u8BB0\u5F55<br/><span style='font-size:11px'>\u70B9\u4E0B\u65B9\u300C\u5BFC\u5165\u5386\u53F2\u6587\u7AE0\u300D\u5EFA\u7ACB\u6863\u6848\uFF0C\u6216\u76F4\u63A5\u4E0A\u7AD9\u70B9\u8BFB\uFF08\u8BFB\u5230 90% \u81EA\u52A8\u8BB0\u5DF2\u8BFB\uFF09</span>" : "\u8FD8\u6CA1\u6709\u5DF2\u8BFB\u8BB0\u5F55"}</div>`;
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
        ${a.status === "new" || a.status === "unread" ? `<span class="tag new">\u672A\u8BFB</span>` : ""}
        ${a.status === "read" ? `<span class="tag read">\u8BFB\u4E8E ${fmtAgo(a.readAt)}</span>` : ""}
      </div>`;
    const actions = document.createElement("div");
    actions.className = "actions";
    const b = document.createElement("button");
    b.textContent = a.status === "read" ? "\u6062\u590D\u672A\u8BFB" : "\u6807\u4E3A\u5DF2\u8BFB";
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
    more.textContent = `\u4EC5\u663E\u793A 80 \u6761\uFF08\u5171 ${source.length} \u6761\uFF09`;
    listEl.appendChild(more);
  }
}
async function notifyTabRefresh() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id) chrome.tabs.sendMessage(tab.id, { type: "REFRESH" }).catch(() => {
  });
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
  } catch {
  }
}
async function renderStatus() {
  const st = await send({ type: "GET_STATE" });
  if (st?.lastError) {
    statusEl.textContent = `\u26A0\uFE0F \u4E0A\u6B21\u68C0\u67E5\u5931\u8D25\uFF1A${st.lastError.msg}`;
    statusEl.className = "status err";
    return;
  }
  statusEl.textContent = `\u4E0A\u6B21\u68C0\u67E5\uFF1A${fmtAgo(st?.lastCheck)}`;
  statusEl.className = "status";
}
checkBtn.onclick = async () => {
  checkBtn.disabled = true;
  checkBtn.textContent = "\u68C0\u67E5\u4E2D\u2026";
  const res = await send({ type: "CHECK_NOW" });
  checkBtn.disabled = false;
  checkBtn.textContent = "\u7ACB\u5373\u68C0\u67E5\u66F4\u65B0";
  if (res?.ok) {
    statusEl.textContent = res.isNew ? `\u2705 \u53D1\u73B0\u65B0\u6587\u7AE0\uFF1A${res.newest?.title || ""}` : "\u2705 \u5DF2\u662F\u6700\u65B0\uFF0C\u6CA1\u6709\u65B0\u6587\u7AE0";
    statusEl.className = "status";
  } else {
    statusEl.textContent = `\u26A0\uFE0F \u68C0\u67E5\u5931\u8D25\uFF1A${res?.error || "\u672A\u77E5\u9519\u8BEF"}`;
    statusEl.className = "status err";
  }
  await load();
};
scanBtn.onclick = async () => {
  scanBtn.disabled = true;
  scanBtn.textContent = "\u6293\u53D6\u4E2D\u2026";
  const res = await send({ type: "SCAN_ALL" });
  scanBtn.disabled = false;
  scanBtn.textContent = "\u5BFC\u5165\u5386\u53F2\u6587\u7AE0";
  if (res?.ok) {
    statusEl.textContent = `\u2705 \u626B\u63CF ${res.pages} \u9875\uFF0C\u6536\u5F55 ${res.scanned} \u7BC7\uFF0C\u65B0\u589E ${res.added} \u7BC7`;
    statusEl.className = "status";
  } else {
    statusEl.textContent = `\u26A0\uFE0F \u5BFC\u5165\u5931\u8D25\uFF1A${res?.error || "\u672A\u77E5\u9519\u8BEF"}`;
    statusEl.className = "status err";
  }
  await load();
};
tabs.forEach(
  (t) => t.addEventListener("click", () => {
    tabs.forEach((x) => x.classList.toggle("active", x === t));
    activeTab = t.dataset.tab;
    render();
  })
);
load().then(updateBadge);
