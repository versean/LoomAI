import { marked } from "/vendor/marked.js";
import DOMPurify from "/vendor/purify.js";

// ============================================================================
// State
// ============================================================================
const S = {
  st: null, d: null, slug: null, view: "overview", task: null,
  docMode: {}, docSel: {}, hist: {}, vcache: new Map(),
  filter: "all", seen: new Set(), firstPaint: true, sse: "connecting", token: 0, flashRel: null, snapAuto: false,
};
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const inline = (s) => esc(s).replace(/`([^`]+)`/g, "<code>$1</code>").replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>");
const ago = (iso) => { if (!iso) return ""; const s = (Date.now() - Date.parse(iso)) / 1000; if (s < 45) return "now"; if (s < 3600) return `${Math.round(s / 60)}m`; if (s < 86400) return `${Math.round(s / 3600)}h`; return `${Math.round(s / 86400)}d`; };
const clock = (iso) => new Date(iso).toTimeString().slice(0, 8);
const when = (iso) => new Date(iso).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
const hue = (n) => { let h = 7; for (const c of String(n)) h = (h * 31 + c.charCodeAt(0)) % 360; return h; };
const color = (n) => n === "conductor" ? "#9d93ff" : n === "human" ? "#fbbf24" : `hsl(${hue(n)} 60% 72%)`;
// Display name for an author/actor: the AI curator shows as "Overseer", the local human as "You".
const dn = (a) => a === "conductor" ? "Overseer" : a === "human" ? "You" : a;
const kindOf = (a) => ["conductor", "human", "github"].includes(a) ? a : a === "hivemind" || a === "system" ? "system" : "agent";
const online = (a) => Date.now() - Date.parse(a.lastSeen) < 10 * 60 * 1000;
const fmtK = (n) => n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1e3 ? (n / 1e3).toFixed(1) + "k" : String(n);
const avatar = (n, on) => `<div class="avatar${n === "conductor" || n === "Overseer" ? " ov" : ""}" style="background:${color(n)}">${esc(n.slice(0, 2).toUpperCase())}${on ? '<span class="on"></span>' : ""}</div>`;
const relPath = (kind, task) => `projects/${S.slug}/${kind === "brief" ? "brief.md" : kind === "instructions" ? "instructions.md" : `playbooks/${task}.md`}`;

async function api(path, opts = {}) {
  const r = await fetch(path, { ...opts, headers: { ...(opts.body && !(opts.body instanceof Blob) ? { "content-type": "application/json" } : {}), ...(opts.headers || {}) } });
  const data = r.headers.get("content-type")?.includes("json") ? await r.json() : await r.text();
  if (r.status === 401 && !path.startsWith("/api/login")) { showLogin(); throw new Error("Login required"); }
  if (!r.ok) throw new Error(data?.error || `HTTP ${r.status}`);
  return data;
}
const post = (p, body, method = "POST") => api(p, { method, body: body instanceof Blob ? body : JSON.stringify(body || {}) });

function toast(msg, err = false) {
  const t = document.createElement("div"); t.className = "toast" + (err ? " err" : ""); t.innerHTML = inline(msg);
  $("#toasts").append(t); setTimeout(() => t.remove(), 3200);
}

// ============================================================================
// Icons
// ============================================================================
const I = (d, extra = "") => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" ${extra}>${d}</svg>`;
const ICON = {
  overview: I('<circle cx="12" cy="12" r="3"/><circle cx="12" cy="12" r="8" stroke-dasharray="3 3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/>'),
  brief: I('<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h4"/>'),
  lock: I('<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>'),
  playbook: I('<path d="M4 19.5V5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2zM4 19.5A2 2 0 0 0 6 22h13"/><path d="M9 7h6"/>'),
  decisions: I('<path d="M12 3v18M5 7l7-4 7 4M5 7l-2 6a4 3 0 0 0 4 0zM19 7l-2 6a4 3 0 0 0 4 0zM8 21h8"/>'),
  links: I('<path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/>'),
  files: I('<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>'),
  log: I('<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>'),
  history: I('<circle cx="12" cy="12" r="3"/><path d="M12 3v6M12 15v6"/>'),
  snapshots: I('<path d="M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0L3 13V3h10l7.6 7.6a2 2 0 0 1 0 2.8z"/><circle cx="7.5" cy="7.5" r="1.5"/>'),
  approvals: I('<path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>'),
  plus: I('<path d="M12 5v14M5 12h14"/>'), upload: I('<path d="M12 16V4M7 9l5-5 5 5M4 20h16"/>'), trash: I('<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>'),
  restore: I('<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/>'), search: I('<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>'),
  repo: I('<path d="M9 19c-4.3 1.4-4.3-2.5-6-3m12 5v-3.5c0-1 .1-1.4-.5-2 2.8-.3 5.5-1.4 5.5-6a4.6 4.6 0 0 0-1.3-3.2 4.2 4.2 0 0 0-.1-3.2s-1.1-.3-3.5 1.3a12 12 0 0 0-6.2 0C6.5 2.8 5.4 3.1 5.4 3.1a4.2 4.2 0 0 0-.1 3.2A4.6 4.6 0 0 0 4 9.5c0 4.6 2.7 5.7 5.5 6-.6.6-.6 1.2-.5 2V21"/>'),
  pr: I('<circle cx="6" cy="6" r="2.5"/><circle cx="6" cy="18" r="2.5"/><circle cx="18" cy="18" r="2.5"/><path d="M6 8.5v7M18 15.5V9a3 3 0 0 0-3-3h-4M13 4l-2 2 2 2"/>'),
  branch: I('<circle cx="6" cy="6" r="2.5"/><circle cx="6" cy="18" r="2.5"/><circle cx="18" cy="6" r="2.5"/><path d="M6 8.5v7M18 8.5a6 6 0 0 1-6 6H8.5"/>'),
  deploy: I('<path d="M5 15c-1.5 1.3-2 5-2 5s3.7-.5 5-2M12 15l-3-3a12 12 0 0 1 8-8.5 6 6 0 0 1 3.5 3.5A12 12 0 0 1 12 15z"/><circle cx="15" cy="9" r="1.5"/>'),
  design: I('<circle cx="12" cy="12" r="9"/><circle cx="8.5" cy="10" r="1"/><circle cx="12" cy="7.5" r="1"/><circle cx="15.5" cy="10" r="1"/><path d="M12 21a3 3 0 0 1 0-6h2a3 3 0 0 0 0-6"/>'),
  doc: I('<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>'),
  issue: I('<circle cx="12" cy="12" r="9"/><path d="M12 8v4M12 16h.01"/>'), api: I('<path d="m8 9-4 3 4 3M16 9l4 3-4 3M14 5l-4 14"/>'),
  other: I('<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>'),
  bolt: I('<path d="M13 2 3 14h9l-1 8 10-12h-9z"/>'), users: I('<circle cx="9" cy="8" r="4"/><path d="M2 21a7 7 0 0 1 14 0M16 4a4 4 0 0 1 0 8M22 21a7 7 0 0 0-4-6.3"/>'),
  eye: I('<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>'), pin: I('<path d="M12 17v5M5 17h14l-2-5V5l1-2H6l1 2v7z"/>'),
  sync: I('<path d="M21 12a9 9 0 0 1-15 6.7L3 16M3 12a9 9 0 0 1 15-6.7L21 8M21 3v5h-5M3 21v-5h5"/>'),
};
const SECTIONS = [
  ["overview", "Overview", "overview"], ["brief", "Brief", "brief"], ["instructions", "Instructions", "lock"],
  ["playbooks", "Playbooks", "playbook"], ["decisions", "Decisions", "decisions"], ["links", "Links", "links"], ["files", "Files", "files"],
  ["log", "Log", "log"], ["access", "Access", "lock"], ["history", "History", "history"], ["snapshots", "Snapshots", "snapshots"], ["approvals", "Approvals", "approvals"],
];

// ============================================================================
// Markdown + diff
// ============================================================================
marked.setOptions({ gfm: true, breaks: false });
const PIN = /<!--\s*pin\s*-->([\s\S]*?)<!--\s*\/pin\s*-->/g;
function md(src) {
  let html = "", last = 0, m;
  const s = String(src || "");
  PIN.lastIndex = 0;
  while ((m = PIN.exec(s))) {
    html += marked.parse(s.slice(last, m.index));
    html += `<div class="pin"><span class="pin-tag">PINNED</span>${marked.parse(m[1].trim())}</div>`;
    last = m.index + m[0].length;
  }
  html += marked.parse(s.slice(last));
  return DOMPurify.sanitize(html);
}

function diffLines(a, b) {
  const A = String(a ?? "").replace(/\r/g, "").split("\n"), B = String(b ?? "").replace(/\r/g, "").split("\n");
  const n = A.length, m = B.length;
  if (n * m > 4e6) return [...A.map(l => ["del", l]), ...B.map(l => ["add", l])];
  const T = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) T[i][j] = A[i] === B[j] ? T[i + 1][j + 1] + 1 : Math.max(T[i + 1][j], T[i][j + 1]);
  const out = []; let i = 0, j = 0;
  while (i < n && j < m) { if (A[i] === B[j]) { out.push(["same", A[i], i + 1, j + 1]); i++; j++; } else if (T[i + 1][j] >= T[i][j + 1]) { out.push(["del", A[i], i + 1, null]); i++; } else { out.push(["add", B[j], null, j + 1]); j++; } }
  while (i < n) { out.push(["del", A[i], i + 1, null]); i++; } while (j < m) { out.push(["add", B[j], null, j + 1]); j++; }
  return out;
}
const diffStat = (rows) => { const a = rows.filter(r => r[0] === "add").length, d = rows.filter(r => r[0] === "del").length; return `<span class="diff-stat"><span class="a">+${a}</span> <span class="d">−${d}</span></span>`; };
function renderDiff(rows) {
  const sym = { add: "+", del: "−", same: " " };
  const line = ([t, l, o, n]) => `<div class="ln ${t}"><span class="n">${o ?? ""}</span><span class="n">${n ?? ""}</span><span class="s">${sym[t]}</span><span class="c">${esc(l) || " "}</span></div>`;
  const out = []; let run = [];
  const flush = (end) => {
    if (run.length > 7) { out.push(...run.slice(0, out.length ? 3 : 0).map(line), `<div class="gap">⋯ ${run.length - (out.length ? 3 : 0) - (end ? 0 : 3)} unchanged lines</div>`, ...(end ? [] : run.slice(-3).map(line))); }
    else out.push(...run.map(line));
    run = [];
  };
  for (const r of rows) { if (r[0] === "same") run.push(r); else { flush(false); out.push(line(r)); } }
  flush(true);
  return `<div class="diff">${out.join("")}</div>`;
}

// ============================================================================
// Data
// ============================================================================
async function loadState() {
  S.st = await api("/api/state");
  if (!S.slug || !S.st.projects.find(p => p.slug === S.slug)) {
    const first = S.st.projects[0]?.slug || null;
    if (first !== S.slug) { S.slug = first; if (first) await loadProject(); }
  }
  renderChrome();
}
async function loadProject() {
  if (!S.slug) { S.d = null; return; }
  S.d = await api(`/api/projects/${S.slug}`);
  S.hist = {};
}
async function getHist(rel) { if (!S.hist[rel]) S.hist[rel] = await api(`/api/history?path=${encodeURIComponent(rel)}`); return S.hist[rel]; }
async function getVersion(sha, rel) {
  const k = `${sha}:${rel}`;
  if (!S.vcache.has(k)) { try { S.vcache.set(k, (await api(`/api/version?sha=${sha}&path=${encodeURIComponent(rel)}`)).content); } catch { S.vcache.set(k, null); } }
  return S.vcache.get(k);
}

let refreshTimer = null, projTimer = null;
function scheduleRefresh(withProject) {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(async () => { await loadState(); }, 150);
  if (withProject) {
    clearTimeout(projTimer);
    projTimer = setTimeout(async () => { await loadProject(); renderMain(); renderSidebar(); }, 300);
  }
}

// ============================================================================
// Routing
// ============================================================================
function go(slug, view = "overview", task = null) { location.hash = `#/${slug}/${view}${task ? "/" + task : ""}`; }
async function onRoute() {
  const [, slug, view, task] = location.hash.split("/");
  const changed = slug && slug !== S.slug;
  if (slug) S.slug = decodeURIComponent(slug);
  S.view = view || "home"; S.view = VIEW_ALIAS[S.view] || S.view; S.task = task ? decodeURIComponent(task) : null; S.switcherOpen = false;
  if (changed || !S.d) await loadProject();
  renderChrome(); renderMain();
  $("#main").scrollTop = 0;
}

// ============================================================================
// Chrome: sidebar, crumbs, statusbar, stream, chat
// ============================================================================
function renderChrome() { renderTopNav(); renderSidebar(); renderCrumbs(); renderStatus(); renderStream(); renderChat(); }

function renderSidebar() {
  const st = S.st; if (!st) return;
  const p = st.projects.find(x => x.slug === S.slug);
  if (!p || !S.d || S.onb) { $("#sidebar").innerHTML = ""; return; }
  const sec = sectionFor(S.view);
  const blocked = (st.gateway?.denied || 0) + (st.gateway?.unauthenticated || 0);
  const btn = (view, label, icon, extra = "", on = S.view === view) => `<button class="nav-btn ${on ? "on" : ""}" data-act="nav" data-view="${view}">${icon}<span>${label}</span>${extra}</button>`;
  const kbOpen = S.kbOpen !== false;
  const main = btn("home", "Home", ICON.overview, "", sec === "home")
    + btn("ais", "Agents", I('<rect x="4" y="7" width="16" height="12" rx="3"/><path d="M12 3v4M9 12h.01M15 12h.01"/>'), "", sec === "ais")
    + btn("activity", "Activity", ICON.log, blocked ? `<span class="badge red">${blocked}</span>` : "", sec === "activity");
  const know = btn("brief", "Summary", ICON.brief) + btn("instructions", "Rules", ICON.lock) + btn("decisions", "Decisions", ICON.decisions)
    + btn("playbook", "Task guides", ICON.playbook) + btn("files", "Files", ICON.files) + btn("links", "Links", ICON.links) + btn("log", "Updates", ICON.history);
  $("#sidebar").innerHTML = `<div>${main}</div>
    <div class="kb ${kbOpen ? "open" : ""}"><button class="side-h kb-toggle" data-act="kbToggle" aria-expanded="${kbOpen}"><svg class="chev" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m9 6 6 6-6 6"/></svg>Knowledge base</button>${kbOpen ? `<div class="kb-items">${know}</div>` : ""}</div>`;
}

function renderCrumbs() {
  const p = S.st?.projects.find(x => x.slug === S.slug);
  const label = S.view === "playbook" ? `playbooks${S.task ? " / " + S.task : ""}` : S.view;
  if (S.view === "gateway" || S.view === "policies") { $("#crumbs").innerHTML = `<span class="sep">/</span><b>${S.view === "gateway" ? "Gateway" : "Tool policies"}</b>`; return; }
  $("#crumbs").innerHTML = p ?`<span class="sep">/</span><b>${esc(p.name)}</b><span class="sep">/</span><span>${esc(label[0].toUpperCase() + label.slice(1))}</span>` : "";
}

function conductorState() {
  const st = S.st; if (!st) return "idle";
  if (st.conductor.paused) return "paused";
  const lastC = st.activity.find(a => a.actor === "conductor");
  return lastC?.type === "thinking" || st.queue.length ? "working" : "idle";
}
function renderStatus() {
  const st = S.st; if (!st) return;
  const cs = conductorState();
  const on = st.agents.filter(online).length;
  const pausedWhy = cs === "paused" ? st.activity.find(a => a.actor === "conductor" && a.type === "error")?.text || "" : "";
  $("#statusbar").innerHTML = `
    <div class="sb state-${cs}" title="${esc(pausedWhy)}"><span class="pulse"></span>Conductor ${cs}${st.queue.length ? ` · ${st.queue.length} queued` : ""}</div>
    <div class="sb"><b>${esc(st.provider)}</b></div>
    <div class="sb">${on}/${st.agents.length} agents online</div>
    <div class="sb">${fmtK(st.stats.tokensIn + st.stats.tokensOut)} tokens · ${st.stats.runs} runs</div>
    <div class="sb right"><span class="mono">${esc(st.head)}</span></div>
    <div class="sb" style="padding-right:4px"><span style="width:6px;height:6px;border-radius:50%;background:${S.sse === "live" ? "var(--green)" : "var(--amber)"}"></span>${S.sse === "live" ? "Live" : "Reconnecting"}</div>`;
}

const EV_ICON = { thinking: "◌", commit: "◆", noop: "·", notify: "⚑", proposal: "⁇", error: "✕", push: "↑", pull: "↓", message: "✉", handoff: "⇄", file: "▤", github: "⎇", decision: "§", link: "⛓", snapshot: "⌖", restore: "↺", edit: "✎", project: "+", answer: "↩", question: "?" };
function renderStream() {
  const st = S.st; if (!st) return;
  let items = [...st.activity].reverse();
  if (S.filter === "project") items = items.filter(a => a.refs?.project === S.slug);
  if (S.filter === "conductor") items = items.filter(a => a.actor === "conductor");
  const el = $("#stream");
  const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
  el.innerHTML = items.map(a => {
    const k = kindOf(a.actor);
    const isNew = !S.firstPaint && !S.seen.has(a.id);
    S.seen.add(a.id);
    const click = a.refs?.request ? `data-act="toGateway"` : a.refs?.sha && a.refs?.project ? `data-act="openCommit" data-sha="${esc(a.refs.sha)}" data-slug="${esc(a.refs.project)}"` : a.refs?.project ? `data-act="project" data-slug="${esc(a.refs.project)}"` : "";
    const shownName = a.actor === "human" && a.refs?.user ? a.refs.user : a.actor; // signed-in person's name
    // Quiet feed: one neutral name, muted text, a small colored dot carries who-kind.
    const who = k === "conductor" ? `<span class="who conductor">Conductor</span> ` : !/^\*\*/.test(a.text) ? `<span class="nm">${esc(shownName)}</span> ` : "";
    return `<div class="ev ${k} ${a.type} ${isNew ? "new" : ""} ${click ? "click" : ""}" ${click}><span class="ic"></span><div class="tx">${who}${inline(a.text.replace(/\*\*\*\*\*/g, "**everyone**"))}<span class="ts">${clock(a.at).slice(0, 5)} · <span class="tag-k">${esc(a.type)}</span></span></div></div>`;
  }).join("") + `<div class="cursor-line ${conductorState() === "working" ? "working" : ""}">${conductorState() === "working" ? "Conductor is processing…" : "Listening for activity"}</div>`;
  if (atBottom || S.firstPaint) el.scrollTop = el.scrollHeight;
  S.firstPaint = false;
}

function renderChat() {
  const st = S.st; if (!st) return;
  const el = $("#msgs");
  const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
  el.innerHTML = st.messages.map(m => {
    const me = m.sender === "human", sys = m.auto === 1;
    return `<div class="msg ${me ? "me" : ""} ${sys ? "sys" : ""}"><div class="mh"><span style="color:${color(m.sender)}">${esc(m.sender)}</span><span>→ ${esc(m.recipient === "*" ? "everyone" : m.recipient)}</span><span>${clock(m.at).slice(0, 5)}</span>${m.readAt ? "<span title='read'>✓</span>" : ""}</div><div class="mb">${inline(m.text)}</div></div>`;
  }).join("") || `<div class="empty">Agents' messages to each other show up here. The conductor reads them too.</div>`;
  if (atBottom || S.rtab !== "chat") el.scrollTop = el.scrollHeight;
  const lastId = st.messages[st.messages.length - 1]?.id;
  if (S.lastMsgSeen === undefined) S.lastMsgSeen = lastId;
  if (S.rtab === "chat") S.lastMsgSeen = lastId;
  $("#chatUnread").hidden = !lastId || lastId === S.lastMsgSeen;
  const sel = $("#msgTo"), cur = sel.value;
  sel.innerHTML = `<option value="*">everyone</option>` + st.agents.map(a => `<option value="${esc(a.name)}">${esc(a.name)}</option>`).join("");
  if ([...sel.options].some(o => o.value === cur)) sel.value = cur;
}

// ============================================================================
// Main views
// ============================================================================
async function renderMain() {
  const token = ++S.token;
  const main = $("#main");
  if (!S.st) return;
  if (S.onb || !S.slug || !S.d) { main.innerHTML = `<div class="page">${onboardingHtml()}</div>`; bindOnboarding(); return; }
  const inner = { brief: () => vDoc("brief"), instructions: () => vDoc("instructions"), playbook: () => S.task ? vDoc("playbook", S.task) : vPlaybooks(), decisions: vDecisions, links: vLinks, files: vFiles, log: vLog, gateway: vGateway, policies: vPolicies, history: vHistory, snapshots: vSnapshots, approvals: vApprovals, overviewLegacy: vOverview };
  const section = sectionFor(S.view);
  // Skeleton if the page takes a moment (avoids a blank flash), then the real content.
  const skelTimer = setTimeout(() => { if (token === S.token) main.innerHTML = skeletonHtml(); }, 140);
  let html;
  if (section === "home") html = await vHome();
  else if (section === "ais") html = await vAIs();
  else if (section === "activity" && S.view !== "gateway") html = await vActivity();
  else { S.embedded = true; try { html = sectionShell(section, await (inner[S.view] || inner.brief)()); } finally { S.embedded = false; } }
  clearTimeout(skelTimer);
  if (token !== S.token) return;
  main.innerHTML = `<div class="page">${html}</div>`;
  renderSidebar(); renderTopNav();
  S.folds = S.folds || {}; document.querySelectorAll("details.fold").forEach(d => { if (S.folds[d.dataset.fold]) d.open = true; });
  if ($("#topo") && $("#topo").offsetWidth) drawTopo();
  bindDrop();
}

const skeletonHtml = () => `<div class="page"><div class="skel" style="height:30px;width:260px;margin-bottom:12px"></div><div class="skel" style="height:14px;width:440px;margin-bottom:30px"></div>
  <div class="grid g3" style="margin-bottom:16px">${'<div class="skel" style="height:96px;border-radius:14px"></div>'.repeat(3)}</div><div class="skel" style="height:280px;border-radius:14px"></div></div>`;
// ============================================================================
// Simple mode: four sections (Home, Knowledge, Agents, Activity) + Settings.
// The detailed views still exist; they render inside a section with sub-tabs.
// ============================================================================
const SECTION_OF = { home: "home", brief: "knowledge", instructions: "knowledge", playbook: "knowledge", decisions: "knowledge", files: "knowledge", links: "knowledge", log: "knowledge", ais: "ais", activity: "activity", gateway: "activity", policies: "settings", history: "settings", snapshots: "settings", approvals: "settings" };
const VIEW_ALIAS = { overview: "home", knowledge: "brief", settings: "policies", access: "ais" };
const sectionFor = (v) => SECTION_OF[v] || "home";
const NAV = [["home", "Home"], ["knowledge", "Knowledge", "brief"], ["ais", "Agents"], ["activity", "Activity"]];
const KNOW_TABS = [["brief", "Summary"], ["instructions", "Rules"], ["decisions", "Decisions"], ["playbook", "Task guides"], ["files", "Files"], ["links", "Links"], ["log", "Updates"]];
const SET_TABS = [["policies", "Tool rules"], ["approvals", "Approvals"], ["history", "History"], ["snapshots", "Backups"]];
const ACT_TABS = [["activity", "Feed"], ["gateway", "Technical log"]];

function renderTopNav() {
  const st = S.st; if (!st) return;
  const p = st.projects.find(x => x.slug === S.slug);
  const items = st.projects.map(x => `<button class="proj-btn ${x.slug === S.slug ? "on" : ""}" data-act="project" data-slug="${esc(x.slug)}"><span class="proj-glyph" style="background:${color(x.slug)}">${esc(x.name.slice(0, 1).toUpperCase())}</span><span class="name">${esc(x.name)}</span></button>`).join("");
  $("#projSwitch").innerHTML = st.projects.length ? `<div class="switcher"><button class="switch-btn ${S.switcherOpen ? "open" : ""}" data-act="switcher">${p ? `<span class="proj-glyph" style="background:${color(p.slug)}">${esc(p.name.slice(0, 1).toUpperCase())}</span><span class="name">${esc(p.name)}</span>` : `<span class="name faint">Choose project</span>`}<svg class="chev" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m7 15 5 5 5-5M7 9l5-5 5 5"/></svg></button>
    ${S.switcherOpen ? `<div class="switch-menu">${items}<div class="menu-sep"></div><button class="proj-btn" data-act="newProject">${ICON.plus.replace("<svg", '<svg width="15" height="15"')}<span class="name">New project</span></button></div>` : ""}</div>` : "";
  const sec = sectionFor(S.view);
  $("#settingsBtn")?.classList.toggle("on", sec === "settings");
  const cb = $("#connectBtn"); if (cb) cb.hidden = sec === "ais" && !!p && !S.onb;
  const blocked = (st.gateway?.denied || 0) + (st.gateway?.unauthenticated || 0);
  $("#topNav").innerHTML = p && !S.onb ? NAV.map(([k, label, target]) => `<a href="#/${esc(S.slug)}/${target || k}" class="${sec === k ? "on" : ""}">${label}${k === "activity" && blocked ? `<span class="nbadge" title="${blocked} blocked in the last 24h">${blocked}</span>` : ""}</a>`).join("") : "";
}

function sectionShell(section, inner) {
  const p = S.d.project, d = S.d;
  const pending = d.proposals.filter(x => x.status === "pending").length;
  const counts = { decisions: d.decisions.filter(x => x.status === "active").length, playbook: Object.keys(d.playbooks).length, files: d.files.length, links: d.links.length, log: d.log.length, approvals: pending };
  const meta = {
    knowledge: ["Knowledge", `Everything your agents know about ${esc(p.name)}. The Overseer keeps it up to date as they work.`, KNOW_TABS],
    settings: ["Settings", "What Agents are allowed to do on your computer, changes waiting for your OK, history and backups.", SET_TABS],
    activity: ["Activity", "Everything your agents did through Loom, and anything that was blocked.", ACT_TABS],
  }[section];
  const tabs = meta[2].map(([k, label]) => `<a href="#/${esc(S.slug)}/${k}" class="${S.view === k ? "on" : ""}">${label}${counts[k] ? `<span class="cnt">${counts[k]}</span>` : ""}</a>`).join("");
  return `<div class="sec-h shell-h shell-${section}"><h1>${meta[0]}</h1><p>${meta[1]}</p></div><nav class="subtabs subtabs-${section}">${tabs}</nav>${inner}`;
}

// ---------- Plain-English activity ----------
const whoOf = (r) => r.actorKind === "overseer" ? "Overseer" : r.actor === "unknown" ? "An unknown app" : r.actor === "human" ? "You" : r.actor;
function plainTool(res) {
  if (!res) return "use a tool";
  const i = res.indexOf(": "), tool = i < 0 ? res : res.slice(0, i), rest = i < 0 ? "" : res.slice(i + 2).replace(/ …$/, "");
  if (/^(Bash|PowerShell)$/.test(tool)) return `run <code>${esc(rest)}</code>`;
  if (tool === "Read") return `read <code>${esc(rest)}</code>`;
  if (/^(Edit|Write|MultiEdit|NotebookEdit)$/.test(tool)) return `edit <code>${esc(rest)}</code>`;
  if (/^Web/.test(tool)) return `open ${esc(rest || "a website")}`;
  return `use ${esc(tool)}${rest ? ` on <code>${esc(rest)}</code>` : ""}`;
}
// -> { kind: blocked|ask|ai|ok|info, html, why, routine } or null
function humanize(r) {
  const w = `<b>${esc(whoOf(r))}</b>`, det = r.detail || {}, res = r.resource || "";
  const cleanWhy = (s) => String(s || "").replace(/^P-\w+:\s*/, "").replace(/\s*\(.*escalated.*\)/, "");
  const after = (pfx) => res.startsWith(pfx) ? res.slice(pfx.length) : res;
  if (r.action === "tool.use") {
    if (det.decision === "deny") return { kind: "blocked", html: `Blocked ${w} from trying to ${plainTool(res)}`, why: cleanWhy(r.reason) };
    if (det.decision === "ask") return { kind: "ask", html: `${w} needed your OK to ${plainTool(res)}`, why: cleanWhy(String(r.reason || "").replace(/^.*?\(|\)$/g, "")) };
    return { kind: "ok", html: `${w} ${plainTool(res).replace(/^run/, "ran").replace(/^read/, "read").replace(/^edit/, "edited").replace(/^use/, "used").replace(/^open/, "opened")}`, routine: true };
  }
  if (r.outcome === "unauthenticated") return { kind: "blocked", html: r.channel === "api" ? "Blocked a visitor who wasn't signed in" : "Blocked an app without a valid key from connecting", why: r.reason, routine: r.channel === "api" && r.action === "api.read" };
  if (r.outcome === "denied") {
    if (r.action === "auth.login") return { kind: "blocked", html: "Someone entered a wrong password", why: null };
    if (r.actorKind === "overseer") return { kind: "info", html: `The Overseer ignored ${det.skipped || "some"} message(s) from an agent that can only read this project`, why: null };
    const PLAIN = { "context.pull": "read this project", "file.read": "read a file", "file.add": "add a file", "knowledge.push": "add updates", "conversation.save": "save a recap", "message.send": "send a message in this project", "context.query": "ask about this project", "source.fetch": "open a source", "search": "search this project", "history.read": "read the history", "project.create": "create a project", "api.write": "change something" };
    return { kind: "blocked", html: `Blocked ${w} from trying to ${esc(PLAIN[r.action] || (r.label || r.action).toLowerCase())}`, why: r.reason };
  }
  if (r.outcome === "error") return { kind: "info", html: `${w} tried to ${esc((r.label || r.action).toLowerCase())}, but it failed`, why: r.reason, routine: true };
  switch (r.action) {
    case "context.pull": return res.startsWith("session-start") ? { kind: "ok", html: `${w} started a session and got the project briefing automatically` } : { kind: "ok", html: `${w} got the <b>${esc(after("briefing:"))}</b> briefing` };
    case "knowledge.push": return { kind: "ok", html: `${w} shared an update${det.breaking ? ` · <b>breaking change</b>, teammates notified` : ""}` };
    case "conversation.save": return { kind: "ok", html: `${w} saved a session recap` };
    case "message.send": return { kind: "ok", html: `${w} messaged <b>${esc(after("to:") === "*" ? "everyone" : after("to:"))}</b>` };
    case "context.query": case "overseer.ask": return { kind: "ok", html: `${w} asked the team brain a question` };
    case "source.fetch": return { kind: "ok", html: `${w} opened an original source`, routine: true };
    case "file.read": return { kind: "ok", html: `${w} read <code>${esc(after("file:"))}</code>`, routine: true };
    case "file.add": return { kind: "ok", html: `${w} added the file <code>${esc(after("file:"))}</code>` };
    case "session.end": return { kind: "ok", html: `${w} finished a session${det.edits ? ` · edited ${det.edits} file${det.edits === 1 ? "" : "s"}` : ""}` };
    case "session.nudge": return { kind: "ai", html: `Reminded ${w} to share what it changed` };
    case "session.connect": return { kind: "ok", html: `${w} connected`, routine: true };
    case "overseer.update": {
      const parts = [det.brief && "the summary", det.playbooks?.length && `the ${det.playbooks.join(" & ")} guide${det.playbooks.length > 1 ? "s" : ""}`, det.decisions?.length && `${det.decisions.length} decision${det.decisions.length > 1 ? "s" : ""}`, det.notified && `notified ${det.notified} agent${det.notified > 1 ? "s" : ""}`].filter(Boolean);
      return parts.length || res.startsWith("commit:")
        ? { kind: "ai", html: `<b>Overseer</b> updated the project knowledge`, why: parts.length ? `Updated ${parts.join(", ")}` : null }
        : { kind: "ai", html: `<b>Overseer</b> checked the latest updates`, why: "Nothing needed to change", routine: true };
    }
    case "message.read": case "hub.overview": case "history.read": case "prompt.get": case "search": case "auth.login": case "api.read": return { kind: "ok", html: `${w} ${esc((r.label || r.action).toLowerCase())}`, routine: true };
    default: return { kind: "ok", html: `${w} ${esc((r.label || r.action).toLowerCase())}${res && !res.includes(":") ? ` · ${esc(res)}` : ""}` };
  }
}
const FEED_ICON = { blocked: "⛔", ask: "!", ai: "✦", ok: "✓", info: "·" };
const feedItem = (r, h) => `<li class="${h.kind}"><span class="fi ${h.kind}">${FEED_ICON[h.kind]}</span><div class="ft">${h.html}${h.why ? `<span class="why">${esc(h.why)}</span>` : ""}</div><span class="fw">${ago(r.at) === "now" ? "just now" : ago(r.at) + " ago"}</span></li>`;

// ---------- Home ----------
// First sentence white, the rest grey (brand two-tone statement).
const twoTone = (t) => { const m = String(t).match(/^(.+?[.!?])(\s+[\s\S]*)?$/); return m ? `<b>${esc(m[1])}</b>${esc(m[2] || "")}` : `<b>${esc(t)}</b>`; };
async function vHome() {
  const d = S.d, p = d.project;
  const reqs = await api(`/api/requests?project=${encodeURIComponent(S.slug)}&limit=200`).catch(() => []);
  const pin = (d.brief.match(/<!--\s*pin\s*-->([\s\S]*?)<!--\s*\/pin\s*-->/) || [])[1]?.replace(/^>\s*/gm, "").replace(/\*\*/g, "").trim();
  const bullets = sectionOf(d.brief, "Current state").split("\n").filter(l => /^\s*[-*]\s/.test(l)).map(l => l.replace(/^\s*[-*]\s+/, "")).slice(0, 4);
  const decisions = d.decisions.filter(x => x.status === "active").slice(-3).reverse();
  const short = (s) => { s = s.replace(/\*\*/g, "").replace(/\s*\([^)]*\)/g, "").trim(); return s.length > 120 ? s.slice(0, 117).replace(/\s+\S*$/, "") + "…" : s; };
  const facts = [...bullets.map(b => `<li><span>${inline(short(b))}</span></li>`), ...decisions.map(x => `<li class="decision"><span>${inline("Decided: " + x.title)}</span></li>`)].join("");
  const agents = S.st.agents.filter(a => a.project === S.slug || reqs.some(r => r.actor === a.name)).sort((a, b) => online(b) - online(a) || b.lastSeen.localeCompare(a.lastSeen)).slice(0, 5);
  const feed = reqs.map(r => [r, humanize(r)]).filter(([, h]) => h && !h.routine).slice(0, 6);
  const blocked24 = reqs.filter(r => (r.outcome === "denied" || r.detail?.decision === "deny") && Date.now() - Date.parse(r.at) < 864e5).length;
  const pending = d.proposals.filter(x => x.status === "pending").length;
  const nAIs = S.st.agents.filter(a => a.project === S.slug).length;
  return `<div class="home-title"><div class="eyebrow">Project · shared brain for ${nAIs || "your"} agent${nAIs === 1 ? "" : "s"}</div><h1>${esc(p.name)}</h1>${p.description ? `<p>${twoTone(p.description)}</p>` : ""}</div>
    ${pin || blocked24 || pending ? `<div class="attn">${pin ? `<span class="note">📌 ${esc(pin.slice(0, 120))}</span>` : ""}${blocked24 ? `<a class="red" href="#/${esc(S.slug)}/activity" data-act="actBlocked">⛔ ${blocked24} blocked in the last 24h</a>` : ""}${pending ? `<a class="amber" href="#/${esc(S.slug)}/approvals">${pending} rule change${pending > 1 ? "s" : ""} waiting for your OK</a>` : ""}</div>` : ""}
    <form class="ask-bar" style="margin:22px 0 18px" onsubmit="event.preventDefault()"><span class="ask-ic">${ICON.search}</span><input id="ovAsk" placeholder="Ask anything about ${esc(p.name)}…" autocomplete="off"><button class="btn primary sm" data-act="askFromOverview" type="submit">Ask</button></form>
    <div class="card"><div class="blk-h"><h3>Recent activity</h3><a href="#/${esc(S.slug)}/activity">See all →</a></div>
      ${feed.length ? `<ul class="feed">${feed.map(([r, h]) => feedItem(r, h)).join("")}</ul>` : `<div class="empty">Nothing yet. Connect an agent and its work shows up here.</div>`}</div>`;
}

// ---------- Agents ----------
async function vAIs() {
  const [acc, mem] = await Promise.all([api(`/api/projects/${S.slug}/access`), S.st.secure ? api(`/api/projects/${S.slug}/members`).catch(() => null) : null]);
  const ACC = { none: "Can't see this project", read: "Can read, can't change anything", write: "Can read and add updates" };
  const cards = acc.agents.map(x => {
    const seen = S.st.agents.find(a => a.name === x.agent), on = seen && online(seen);
    return `<div class="card ai-card"><div class="top">${avatar(x.agent, on)}<div style="min-width:0"><div class="nm">${esc(x.agent)}</div><div class="st ${on ? "live" : ""}">${on ? `Working${seen.task ? ` on ${esc(seen.task)}` : ""} · now` : x.lastSeen ? `Last seen ${ago(x.lastSeen)} ago` : "Not connected yet"}</div></div></div>
      <div><div class="seg" style="width:100%;display:grid;grid-template-columns:repeat(3,1fr)">${acc.levels.map(l => `<button class="${x.access === l ? "on" : ""}" data-act="setAccess" data-agent="${esc(x.agent)}" data-level="${l}">${{ none: "None", read: "Read", write: "Write" }[l]}</button>`).join("")}</div>
      <div class="faint" style="font-size:12px;margin-top:6px">${ACC[x.access]}${x.explicit ? "" : " (default)"}</div></div></div>`;
  }).join("");
  const msgs = S.st.messages.filter(m => !m.project || m.project === S.slug).slice(-30);
  const people = mem ? `<details class="fold" data-fold="people"><summary>People</summary><div class="card"><div class="blk-h"><h3>People</h3><span class="faint" style="font-size:13px">${mem.legacyOpen ? "Everyone signed in can see this project" : `${mem.members.length} member${mem.members.length === 1 ? "" : "s"}`}</span></div>
      <div class="ai-list">${mem.members.map(m => `<div class="ai-row">${avatar(m.name, false)}<div><div class="nm">${esc(m.name)}</div><div class="st">${esc(m.email)}</div></div><div class="row">${chip(m.role === "owner" ? "ai" : "", null, m.role)}${mem.canManage && m.role !== "owner" ? `<button class="btn ghost sm" data-act="removeMember" data-id="${esc(m.id)}">Remove</button>` : ""}</div></div>`).join("")}</div>
      ${mem.canManage ? `<div class="msg-form" style="grid-template-columns:minmax(0,1fr) 110px auto"><input id="memEmail" type="email" placeholder="teammate@team.dev"><select id="memRole"><option value="member">member</option><option value="owner">owner</option></select><button class="btn primary sm" data-act="addMember">Add person</button></div>` : ""}</div></details>` : "";
  return `<div class="sec-h with-action"><div><h1>Your agents</h1><p>The coding agents connected to Loom, what they're doing, and what each one can see in ${esc(S.d.project.name)}.</p></div>${cards ? `<button class="btn primary" data-act="connect">${ICON.plus}Connect agent</button>` : ""}</div>
    <div class="ai-cards">${cards}${cards ? "" : `<div class="card ai-card add" data-act="connect"><div style="font-size:26px;line-height:1">+</div><div style="font-weight:500">Connect an agent</div><div style="font-size:12.5px">Claude Code, Cursor, Codex…</div></div>`}</div>
    <details class="fold" data-fold="msgs"><summary>Messages between agents<span class="faint">${msgs.length}</span></summary><div class="card">
      <div class="msg-list">${msgs.map(m => `<div class="msg ${m.sender === "human" ? "me" : ""} ${m.auto ? "sys" : ""}"><div class="mh"><span>${esc(m.sender === "conductor" ? "Overseer" : m.sender)}</span><span>→ ${esc(m.recipient === "*" ? "everyone" : m.recipient)}</span><span>${ago(m.at)}</span></div><div class="mb">${inline(m.text)}</div></div>`).join("") || `<div class="empty">No messages yet.</div>`}</div>
      <form class="msg-form" onsubmit="event.preventDefault()"><select id="aiMsgTo"><option value="*">Everyone</option>${S.st.agents.map(a => `<option>${esc(a.name)}</option>`).join("")}</select><input id="aiMsgText" placeholder="Send your agents a message…" autocomplete="off"><button class="btn primary sm" data-act="aiSend" type="submit">Send</button></form></div></details>
    ${people}
    <details class="fold" data-fold="map"><summary>Live map</summary><div class="card topo" style="height:320px"><div id="topo" style="height:100%"></div></div></details>`;
}

// ---------- Activity (plain English) ----------
S.actF = { mode: "all", who: "", routine: false };
try { S.kbOpen = localStorage.getItem("loom.kbOpen") !== "0"; } catch {}
async function vActivity() {
  const rows = (await api("/api/requests?limit=400").catch(() => [])).filter(r => !r.project || r.project === S.slug);
  const f = S.actF;
  const whoList = [...new Set(rows.filter(r => r.actorKind === "agent").map(r => r.actor))];
  const items = rows.filter(r => !f.who || r.actor === f.who).map(r => [r, humanize(r)]).filter(([, h]) => h && (f.routine || !h.routine) && (f.mode !== "blocked" || h.kind === "blocked" || h.kind === "ask"));
  const nBlocked = rows.map(humanize).filter(h => h && h.kind === "blocked").length;
  return sectionShell("activity", `<div class="toggle-row">
      <button class="pill ${f.mode === "all" ? "on" : ""}" data-act="actMode" data-m="all">Everything</button>
      <button class="pill ${f.mode === "blocked" ? "on" : ""}" data-act="actMode" data-m="blocked">⛔ Blocked${nBlocked ? ` (${nBlocked})` : ""}</button>
      <span style="width:1px;height:18px;background:rgba(255,255,255,.08);margin:0 4px"></span>
      ${whoList.map(n => `<button class="pill ${f.who === n ? "on" : ""}" data-act="actWho" data-n="${esc(n)}">${esc(n)}</button>`).join("")}
      <label class="faint" style="margin-left:auto;font-size:12.5px;display:flex;gap:6px;align-items:center;cursor:pointer"><input type="checkbox" data-act="actRoutine" ${f.routine ? "checked" : ""}> Show routine events</label></div>
    <div class="card">${items.length ? `<ul class="feed">${items.slice(0, 150).map(([r, h]) => feedItem(r, h)).join("")}</ul>` : `<div class="empty">${f.mode === "blocked" ? "Nothing has been blocked. 👍" : "No activity yet."}</div>`}</div>
    <p class="faint" style="font-size:12.5px;margin-top:14px">Loom records what happened, never the content of messages, files or code. The <a href="#/${esc(S.slug)}/gateway">technical log</a> has every request in full.</p>`);
}
let liveTimer = null;
function liveRerender() {
  if (!["home", "activity", "ais"].includes(sectionFor(S.view)) || S.view === "gateway") return;
  if (document.activeElement && /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName) && $("#main").contains(document.activeElement)) return;
  clearTimeout(liveTimer); liveTimer = setTimeout(() => { if (!$("#overlay").classList.contains("open")) renderMain(); }, 900);
}

const header = (title, sub, chips = "", actions = "", path = "") => S.embedded
  ? `<div class="page-h embedded"><div style="min-width:0"><h2>${title}${chips}</h2>${sub ? `<div class="sub">${sub}</div>` : ""}</div>${actions ? `<div class="actions">${actions}</div>` : ""}</div>`
  : `<div class="page-h"><div style="min-width:0"><h1>${title}${chips}</h1>${sub ? `<div class="sub">${sub}</div>` : ""}${path ? `<div class="path">${esc(path)}</div>` : ""}</div>${actions ? `<div class="actions">${actions}</div>` : ""}</div>`;
const chip = (cls, ic, label) => `<span class="chip ${cls}">${ic ? ICON[ic] : ""}${label}</span>`;

// ---------- Overview ----------
async function vOverview() {
  const d = S.d, st = S.st, p = d.project;
  const active = d.decisions.filter(x => x.status === "active").length;
  const conductorCommits = d.commits.filter(c => c.author === "conductor").slice(0, 7);
  const team = st.agents.filter(a => a.project === S.slug);
  const gh = d.github?.data;
  const pushes = d.log.filter(l => l.kind === "push").length;
  const cs = conductorState();
  const recentReqs = await api(`/api/requests?project=${encodeURIComponent(S.slug)}&limit=6`).catch(() => []);
  const projDenied = recentReqs.filter(r => r.outcome === "denied").length;
  const gwCard = `<div class="card" style="margin-bottom:16px"><div class="card-h">${I('<path d="M12 3 4 6v6c0 4.5 3.4 8.3 8 9 4.6-.7 8-4.5 8-9V6z"/><path d="m9 12 2 2 4-4"/>').replace("<svg", '<svg width="14" height="14"')}Gateway activity on this project<div class="right"><button class="btn ghost sm" data-act="toGateway" data-project="${esc(S.slug)}">Open gateway →</button></div></div>
    ${recentReqs.length ? `<table class="gw-table"><colgroup><col style="width:92px"><col style="width:170px"><col style="width:200px"><col><col style="width:150px"></colgroup><tbody>${recentReqs.map(r => `<tr class="${r.outcome}" data-act="toGateway" data-project="${esc(S.slug)}"><td class="t">${clock(r.at)}</td><td>${actorCell(r).replace(/<span class="code">.*<\/span>$/, "")}</td><td><div class="act">${esc(r.label)}</div></td><td><div class="res">${esc(r.resource || "")}</div></td><td><span class="outcome ${r.outcome}">${OUTCOME_LABEL[r.outcome]}</span></td></tr>`).join("")}</tbody></table>` : `<div class="empty">No requests on this project yet.</div>`}</div>`;
  return header(esc(p.name), esc(p.description || ""), "", `<span class="state-pill ${cs}"><span class="dot"></span>Conductor ${cs}</span><button class="btn" data-act="briefingPreview">${ICON.eye}Preview as agent</button><button class="btn" data-act="snapshot">${ICON.snapshots}Snapshot</button>`) + `
  <form class="ask-bar" onsubmit="event.preventDefault()"><span class="ask-ic">${ICON.search}</span><input id="ovAsk" placeholder="Ask anything about ${esc(p.name)}: “What did we decide about the signup API?”" autocomplete="off"><button class="btn primary sm" data-act="askFromOverview" type="submit">Ask</button></form>
  <div class="hero">
    <div class="card topo"><div class="card-h">The hive<div class="right"><span class="live-dot"></span><span class="faint" style="font-size:12px">live</span></div></div><div id="topo" style="height:calc(100% - 46px)"></div>
      <div class="topo-legend"><span><i style="background:var(--ai-1)"></i>Conductor</span><span><i style="background:var(--muted)"></i>Agent</span><span><i style="background:#fff"></i>Project</span></div></div>
    <div class="stat-col">
      <div class="stats">
        <div class="stat"><div class="k">commits</div><div class="v">${d.commits.length}</div></div>
        <div class="stat"><div class="k">decisions</div><div class="v">${active}<small>/${d.decisions.length}</small></div></div>
        <div class="stat"><div class="k">playbooks</div><div class="v">${Object.keys(d.playbooks).length}</div></div>
        <div class="stat"><div class="k">pushes</div><div class="v">${pushes}</div></div>
        <div class="stat"><div class="k">snapshots</div><div class="v">${d.snapshots.length}</div></div>
        <div class="stat"><div class="k">tokens</div><div class="v">${fmtK(st.stats.tokensIn + st.stats.tokensOut)}</div></div>
      </div>
      <div class="card" style="flex:1"><div class="card-h">${ICON.users.replace("<svg", '<svg width="13" height="13"')}Who's on what</div>
        ${team.length ? team.map(a => `<div class="team-row">${avatar(a.name, online(a))}<div><div style="font-weight:500">${esc(a.name)}</div><div class="faint" style="font-size:12px">${online(a) ? "active now" : `seen ${ago(a.lastSeen)} ago`}</div></div><span class="chip">${esc(a.task || "idle")}</span></div>`).join("") : `<div class="empty">No agents on this project yet.<br><button class="btn sm" style="margin-top:8px" data-act="connect">Connect one</button></div>`}
      </div>
    </div>
  </div>
  ${gwCard}
  <div class="grid g2">
    <div class="card"><div class="card-h">Conductor commits<div class="right"><button class="btn ghost sm" data-act="nav" data-view="history">all history →</button></div></div>
      <div class="commits">${conductorCommits.map(c => commitRow(c)).join("") || `<div class="empty">The conductor hasn't committed yet. Push something.</div>`}</div></div>
    <div class="card"><div class="card-h">${ICON.repo.replace("<svg", '<svg width="13" height="13"')}GitHub${d.repo ? ` · <span class="mono" style="text-transform:none;letter-spacing:0">${esc(d.repo)}</span>` : ""}<div class="right">${d.repo ? `<span class="faint mono" style="font-size:11px">${d.github?.fetchedAt ? "synced " + ago(d.github.fetchedAt) : ""}</span><button class="btn ghost sm" data-act="ghSync">${ICON.sync}</button>` : ""}</div></div>
      ${!d.repo ? `<div class="empty">Add a <b>repo</b> link to sync commits and PRs.<br><button class="btn sm" style="margin-top:8px" data-act="nav" data-view="links">Add link</button></div>` : d.github?.error ? `<div class="empty" style="color:var(--red)">${esc(d.github.error)}</div>` : !gh?.commits ? `<div class="empty">Not synced yet</div>` : `
        ${(gh.pulls || []).slice(0, 3).map(pr => `<div class="gh-pr"><span class="num">#${pr.number}</span><a href="${esc(pr.url)}" target="_blank" rel="noopener">${esc(pr.title)}</a></div>`).join("")}
        <div class="commits">${gh.commits.slice(0, 6).map(c => `<a class="commit" href="${esc(c.url)}" target="_blank" rel="noopener" style="color:inherit;text-decoration:none"><span class="node agent"></span><span class="sha" style="color:var(--green)">${esc(c.sha)}</span><span class="subj">${esc(c.message)}</span><span class="meta">${esc(c.author || "")} · ${ago(c.at)}</span></a>`).join("")}</div>`}
    </div>
  </div>`;
}

function commitRow(c, sel = false) {
  const k = kindOf(c.author);
  return `<div class="commit ${sel ? "sel" : ""}" data-act="openCommit" data-sha="${esc(c.sha)}"><span class="node ${k}"></span><span class="sha">${esc(c.short)}</span><span class="subj">${esc(c.subject)}</span><span class="meta"><span class="who ${k}">${esc(dn(c.author))}</span> · ${ago(c.at)}</span></div>`;
}

// ---------- Topology ----------
let topoGeom = null;
function drawTopo() {
  const host = $("#topo"); if (!host) return;
  const W = host.clientWidth || 600, H = host.clientHeight || 320, cx = W / 2, cy = H / 2 + 4;
  const projects = S.st.projects;
  const agents = S.st.agents;
  // Elliptical rings sized to the card: projects on the inner ring, agents fanned out on the outer ring.
  const r1x = W * 0.16, r1y = H * 0.3, r2x = W * 0.36, r2y = H * 0.34;
  const P = {}, A = {};
  // Projects evenly on the inner ring (one project sits straight above the conductor);
  // agents evenly around the whole outer ring so the graph stays balanced.
  projects.forEach((p, i) => { const t = -Math.PI / 2 + (i / Math.max(projects.length, 1)) * Math.PI * 2; P[p.slug] = { x: cx + Math.cos(t) * r1x, y: cy + Math.sin(t) * r1y, t }; });
  const ordered = [...agents].sort((a, b) => (P[a.project]?.t ?? 9) - (P[b.project]?.t ?? 9) || a.name.localeCompare(b.name));
  ordered.forEach((a, i) => { const n = ordered.length; const t = n === 1 ? Math.PI * 0.8 : Math.PI + 0.3 + (i / n) * Math.PI * 2; A[a.name] = { x: cx + Math.cos(t) * r2x, y: cy + Math.sin(t) * r2y, a, slug: a.project || "_" }; });
  const R1 = Math.max(r1x, r1y), R2 = Math.max(r2x, r2y);
  topoGeom = { cx, cy, P, A };
  // Monochrome graph; only the conductor carries color. Curved edges read calmer than straight ones.
  const curve = (x1, y1, x2, y2) => { const mx = (x1 + x2) / 2, my = (y1 + y2) / 2, dx = x2 - x1, dy = y2 - y1; return `M${x1},${y1} Q${mx - dy * .12},${my + dx * .12} ${x2},${y2}`; };
  const edge = (x1, y1, x2, y2, hot, dim) => `<path d="${curve(x1, y1, x2, y2)}" fill="none" stroke="${hot ? "url(#edgeHot)" : "rgba(255,255,255,.12)"}" stroke-width="${hot ? 1.4 : 1}" stroke-dasharray="${dim ? "2 5" : "none"}"/>`;
  let edges = "", nodes = "";
  for (const [slug, p] of Object.entries(P)) edges += edge(cx, cy, p.x, p.y, slug === S.slug, false);
  for (const [name, a] of Object.entries(A)) { const t = P[a.slug] || { x: cx, y: cy }; edges += edge(t.x, t.y, a.x, a.y, false, !online(a.a)); }
  for (const [slug, p] of Object.entries(P)) {
    const proj = projects.find(x => x.slug === slug), cur = slug === S.slug;
    nodes += `<g style="cursor:pointer" data-act="project" data-slug="${esc(slug)}"><circle cx="${p.x}" cy="${p.y}" r="${cur ? 6 : 5}" fill="${cur ? "#fff" : "var(--muted)"}"/>${cur ? `<circle cx="${p.x}" cy="${p.y}" r="11" fill="none" stroke="rgba(255,255,255,.18)"/>` : ""}
      <text class="label strong" x="${p.x}" y="${p.y - 18}" text-anchor="middle">${esc(proj.name)}</text></g>`;
  }
  for (const [name, a] of Object.entries(A)) {
    const on = online(a.a), c = color(name);
    nodes += `<g opacity="${on ? 1 : .55}"><circle cx="${a.x}" cy="${a.y}" r="17" fill="#121214" stroke="rgba(255,255,255,.14)"/>
      ${on ? `<circle cx="${a.x}" cy="${a.y}" r="17" fill="none" stroke="${c}" opacity=".5"><animate attributeName="r" values="17;25" dur="2.6s" repeatCount="indefinite"/><animate attributeName="opacity" values=".45;0" dur="2.6s" repeatCount="indefinite"/></circle>` : ""}
      <text x="${a.x}" y="${a.y + 4}" text-anchor="middle" font-family="Geist, Inter, sans-serif" font-size="11" font-weight="600" fill="${c}">${esc(name.slice(0, 2).toUpperCase())}</text>
      <text class="label" x="${a.x}" y="${a.y + 33}" text-anchor="middle"><tspan fill="var(--text)">${esc(name)}</tspan>${a.a.task ? ` · ${esc(a.a.task)}` : ""}</text></g>`;
  }
  const cs = conductorState();
  const coreR = cs === "working" ? 22 : 18;
  host.innerHTML = `<svg viewBox="0 0 ${W} ${H}">
    <defs>
      <linearGradient id="aiGrad" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#8b7cff"/><stop offset="1" stop-color="#5cb6ff"/></linearGradient>
      <linearGradient id="edgeHot" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#8b7cff" stop-opacity=".7"/><stop offset="1" stop-color="#5cb6ff" stop-opacity=".25"/></linearGradient>
      <radialGradient id="glow"><stop offset="0" stop-color="#8b7cff" stop-opacity=".55"/><stop offset=".5" stop-color="#6f8cff" stop-opacity=".15"/><stop offset="1" stop-color="#5cb6ff" stop-opacity="0"/></radialGradient>
    </defs>
    <ellipse cx="${cx}" cy="${cy}" rx="${r1x}" ry="${r1y}" fill="none" stroke="rgba(255,255,255,.05)"/>
    <ellipse cx="${cx}" cy="${cy}" rx="${r2x}" ry="${r2y}" fill="none" stroke="rgba(255,255,255,.035)"/>
    ${edges}
    <g id="pulses"></g>
    <circle cx="${cx}" cy="${cy}" r="${coreR * 3.4}" fill="url(#glow)">${cs === "working" ? `<animate attributeName="r" values="${coreR * 3};${coreR * 4};${coreR * 3}" dur="1.6s" repeatCount="indefinite"/>` : ""}</circle>
    <circle cx="${cx}" cy="${cy}" r="${coreR + 8}" fill="none" stroke="url(#aiGrad)" stroke-width="1" stroke-dasharray="2 6" opacity=".8"><animateTransform attributeName="transform" type="rotate" from="0 ${cx} ${cy}" to="360 ${cx} ${cy}" dur="${cs === "working" ? 4 : 20}s" repeatCount="indefinite"/></circle>
    <circle cx="${cx}" cy="${cy}" r="${coreR}" fill="${cs === "paused" ? "var(--amber)" : "url(#aiGrad)"}"/>
    <path d="M${cx},${cy - 7} L${cx + 6},${cy - 3.5} L${cx + 6},${cy + 3.5} L${cx},${cy + 7} L${cx - 6},${cy + 3.5} L${cx - 6},${cy - 3.5}Z" fill="none" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/>
    <text class="label strong" x="${cx}" y="${cy + coreR + 22}" text-anchor="middle">Conductor</text>
    ${nodes}
  </svg>`;
}
function pulse(from, to, col = "var(--accent)", delay = 0) {
  const g = $("#pulses"); if (!g || !from || !to) return;
  const ns = "http://www.w3.org/2000/svg";
  const c = document.createElementNS(ns, "circle");
  c.setAttribute("r", "3"); c.setAttribute("fill", col); c.setAttribute("style", `filter:drop-shadow(0 0 6px ${col})`);
  const m = document.createElementNS(ns, "animateMotion");
  m.setAttribute("dur", "0.9s"); m.setAttribute("begin", "indefinite"); m.setAttribute("fill", "freeze");
  m.setAttribute("path", `M${from.x},${from.y} L${to.x},${to.y}`);
  c.append(m); g.append(c);
  setTimeout(() => { try { m.beginElement(); } catch {} }, delay);
  setTimeout(() => c.remove(), delay + 1000);
}
function pulseFor(e) {
  if (!topoGeom) return;
  const { cx, cy, P, A } = topoGeom, core = { x: cx, y: cy };
  const agent = A[e.actor], proj = P[e.refs?.project];
  if (agent) { const mid = P[agent.slug] || core; pulse(agent, mid, color(e.actor)); pulse(mid, core, color(e.actor), 800); }
  else if (e.actor === "conductor" && e.type === "commit") Object.values(P).forEach((p, i) => pulse(core, p, "var(--accent)", i * 120));
  else if (e.actor === "conductor" && e.type === "notify") Object.values(A).forEach((a, i) => pulse(core, a, "var(--amber)", i * 120));
  else if (e.actor === "human" && proj) pulse(proj, core, "var(--amber)");
}

// ---------- Docs ----------
async function vDoc(kind, task) {
  const rel = relPath(kind, task);
  const current = kind === "brief" ? S.d.brief : kind === "instructions" ? S.d.instructions : S.d.playbooks[task];
  if (current === undefined || current === null) return header(`Playbook: ${esc(task)}`, "") + `<div class="card"><div class="empty">No playbook called "${esc(task)}".</div></div>`;
  const hist = await getHist(rel);
  const mode = S.docMode[rel] || "read";
  const selSha = S.docSel[rel] || hist[0]?.sha;
  const idx = Math.max(0, hist.findIndex(h => h.sha === selSha));
  const sel = hist[idx], parent = hist[idx + 1];
  const isHead = idx === 0;
  let body;
  if (mode === "edit") {
    body = `<textarea class="editor" id="editor" spellcheck="false">${esc(current)}</textarea>
      <div class="sp-between" style="margin-top:10px"><div class="row"><button class="btn sm" data-act="pinSel">${ICON.pin}Pin selection</button><span class="faint" style="font-size:12px">Pinned blocks are never changed by the conductor.</span></div>
      <div class="row"><input id="commitMsg" placeholder="Commit message (optional)" style="width:240px"><button class="btn" data-act="docMode" data-rel="${esc(rel)}" data-mode="read">Cancel</button><button class="btn primary" data-act="saveDoc" data-kind="${kind}" data-task="${esc(task || "")}">Commit</button></div></div>`;
  } else if (mode === "diff") {
    const a = parent ? await getVersion(parent.sha, rel) : "";
    const b = isHead ? current : await getVersion(sel.sha, rel);
    const rows = diffLines(a ?? "", b ?? "");
    body = `<div class="sp-between" style="margin-bottom:10px"><span class="mono faint" style="font-size:12px">${parent ? `${esc(parent.short)} → ${esc(sel.short)}` : `created in ${esc(sel?.short || "")}`}</span>${diffStat(rows)}</div>${renderDiff(rows)}`;
  } else {
    const content = isHead ? current : await getVersion(sel.sha, rel);
    body = `<div class="md">${md(content)}</div>`;
  }
  const chips = kind === "instructions" ? chip("lock", "lock", "only people can edit") : chip("ai", null, "kept up to date by the Overseer");
  const title = kind === "brief" ? "Project summary" : kind === "instructions" ? "Rules for every agent" : `Task guide: ${esc(task)}`;
  const pending = kind === "instructions" ? S.d.proposals.filter(p => p.status === "pending").length : 0;
  const sub = kind === "brief" ? "The big picture: what this project is, where it stands, and who is working on what. The Overseer updates it as your agents share their work." : kind === "instructions" ? `Every agent reads these before it starts. Only people can change them; The Overseer can suggest changes for you to approve${pending ? ` · <a href="#/${S.slug}/approvals">${pending} waiting</a>` : ""}.` : `What an agent is told when it starts working on ${esc(task)}.`;
  const actions = `<div class="seg"><button class="${mode === "read" ? "on" : ""}" data-act="docMode" data-rel="${esc(rel)}" data-mode="read">Read</button><button class="${mode === "diff" ? "on" : ""}" data-act="docMode" data-rel="${esc(rel)}" data-mode="diff" ${hist.length ? "" : "disabled"}>Changes</button><button class="${mode === "edit" ? "on" : ""}" data-act="docMode" data-rel="${esc(rel)}" data-mode="edit">Edit</button></div>`;
  const flash = S.flashRel === rel ? "flash" : ""; if (flash) S.flashRel = null;
  return header(title, sub, chips, actions, rel) + `
  <div class="doc-layout">
    <div class="card ${flash}">
      ${sel ? `<div class="reason"><span class="who ${kindOf(sel.author)}">${esc(dn(sel.author))}</span><span>${esc(sel.subject)}</span><span class="mono faint" style="margin-left:auto;white-space:nowrap">${esc(sel.short)} · ${ago(sel.at)}</span></div>` : ""}
      ${!isHead && mode !== "edit" ? `<div class="reason" style="background:var(--amber-bg)"><span style="color:var(--amber)">Viewing an older version.</span><span class="row" style="margin-left:auto"><button class="btn sm" data-act="selVer" data-rel="${esc(rel)}" data-sha="${esc(hist[0].sha)}">Back to latest</button><button class="btn sm" data-act="restoreFile" data-rel="${esc(rel)}" data-sha="${esc(sel.sha)}">${ICON.restore}Restore this version</button></span></div>` : ""}
      <div class="card-b" style="padding:20px 24px">${body}</div>
    </div>
    <div class="card"><div class="card-h">${ICON.history.replace("<svg", '<svg width="13" height="13"')}Versions<div class="right faint mono" style="font-size:11px">${hist.length}</div></div>
      <div class="timeline">${hist.map((h, i) => `<div class="tl-item ${h.sha === sel?.sha ? "sel" : ""}" data-act="selVer" data-rel="${esc(rel)}" data-sha="${esc(h.sha)}"><span class="dot ${kindOf(h.author)}"></span><div><div class="tl-head"><span class="mono" style="font-size:11.5px;color:var(--accent-2)">v${hist.length - i}</span><span class="who ${kindOf(h.author)}" style="font-size:11.5px">${esc(dn(h.author))}</span></div><div class="t1">${esc(h.subject)}</div><div class="t2">${esc(h.short)} · ${when(h.at)}</div></div></div>`).join("")}</div></div>
  </div>`;
}

function vPlaybooks() {
  const tasks = Object.keys(S.d.playbooks);
  return header("Task guides", "A short guide for each area of work, like website or api. When an agent starts on an area, it gets the matching guide. The Overseer writes new ones as new areas come up.", chip("ai", null, "kept up to date by the Overseer")) +
    `<div class="grid g3">${tasks.map(t => { const body = S.d.playbooks[t]; const lines = body.split("\n").filter(l => /^##\s/.test(l)).map(l => l.replace(/^##\s*/, "")); return `<div class="card file" data-act="nav" data-view="playbook" data-task="${esc(t)}"><div class="sp-between"><span class="mono" style="font-size:15px;color:var(--accent-2)">${esc(t)}</span>${ICON.playbook.replace("<svg", '<svg width="16" height="16" style="color:var(--faint)"')}</div><div class="faint" style="font-size:12px">${lines.slice(0, 4).map(esc).join(" · ") || "—"}</div><div class="mono faint" style="font-size:11px">${body.length} chars</div></div>`; }).join("") || `<div class="card"><div class="empty">No playbooks yet.</div></div>`}</div>`;
}

// ---------- Decisions ----------
function vDecisions() {
  const ds = [...S.d.decisions].reverse();
  return header("Decisions", "What the team decided, and why. Decisions are never edited; a newer decision can replace an older one.", chip("append", null, "permanent record"), `<button class="btn primary" data-act="toggle" data-target="#decForm">${ICON.plus}Record decision</button>`) + `
  <div class="card" id="decForm" style="display:none;margin-bottom:14px"><div class="card-b">
    <div class="field"><label>Title</label><input id="decTitle" placeholder="e.g. Use Postgres for the waitlist"></div>
    <div class="field"><label>Decision + why</label><textarea id="decBody" rows="4" placeholder="What we decided, and the reason."></textarea></div>
    <div class="row"><div class="field" style="flex:1;margin:0"><label>Replaces an earlier decision?</label><select id="decSup"><option value="">No</option>${S.d.decisions.filter(d => d.status === "active").map(d => `<option value="${d.id}">${d.id} ${esc(d.title)}</option>`).join("")}</select></div><button class="btn primary" style="align-self:flex-end" data-act="addDecision">Save decision</button></div>
  </div></div>
  <div class="ledger">${ds.map(d => `<div class="card dec ${d.status}"><div><div class="id">${esc(d.id)}</div>${d.status === "superseded" ? `<div style="margin-top:6px">${chip("", null, "replaced by " + esc(d.supersededBy))}</div>` : `<div style="margin-top:6px">${chip("ok", null, "current")}</div>`}</div>
    <div><h3>${esc(d.title)}</h3><div class="meta"><span class="who ${kindOf(d.by)}">${esc(dn(d.by))}</span><span>${d.date ? when(d.date) : ""}</span>${d.supersedes ? `<span>supersedes <b class="mono" style="color:var(--cyan)">${esc(d.supersedes)}</b></span>` : ""}</div><div class="md" style="margin-top:8px;font-size:13.5px">${md(d.body)}</div></div></div>`).join("") || `<div class="card"><div class="empty">No decisions yet.</div></div>`}</div>`;
}

// ---------- Links ----------
const KINDS = ["repo", "branch", "pr", "issue", "deploy", "design", "doc", "api", "other"];
function vLinks() {
  const by = {};
  for (const l of S.d.links) (by[l.kind] ||= []).push(l);
  return header("Links", "Repos, pull requests, deploys and designs. Agents can add links; only people can remove them.", "", "") + `
  <div class="card" style="margin-bottom:14px"><div class="card-b row">
    <select id="lkKind" style="width:110px">${KINDS.map(k => `<option>${k}</option>`).join("")}</select>
    <input id="lkLabel" placeholder="Label" style="width:200px"><input id="lkUrl" placeholder="https://…" style="flex:1;min-width:200px">
    <button class="btn primary" data-act="addLink">${ICON.plus}Add</button></div></div>
  ${KINDS.filter(k => by[k]).map(k => `<div class="card" style="margin-bottom:12px"><div class="card-h">${ICON[k] ? ICON[k].replace("<svg", '<svg width="13" height="13"') : ""}${k}<div class="right faint mono">${by[k].length}</div></div>
    ${by[k].map(l => `<div class="link-row"><div class="link-ic">${ICON[l.kind] || ICON.other}</div><div style="min-width:0"><a href="${esc(l.url)}" target="_blank" rel="noopener">${esc(l.label)}</a><div class="url">${esc(l.url)} · added by <span class="who ${kindOf(l.addedBy)}">${esc(dn(l.addedBy))}</span> ${ago(l.addedAt)} ago</div></div><button class="btn ghost sm" data-act="removeLink" data-id="${esc(l.id)}" title="Remove">${ICON.trash}</button></div>`).join("")}</div>`).join("") || `<div class="card"><div class="empty">No links yet.</div></div>`}`;
}

// ---------- Files ----------
function vFiles() {
  return header("Files", "Specs, schemas and notes your agents can read. Files are never overwritten.", chip("lock", "lock", "Agents can only read"), "") + `
  <div class="drop" id="drop" data-act="pickFile">${ICON.upload.replace("<svg", '<svg width="22" height="22" style="display:block;margin:0 auto 6px"')}Drop files here or click to upload<input type="file" id="fileInput" multiple hidden></div>
  <div class="files" style="margin-top:14px">${S.d.files.map(f => { const ext = (f.name.split(".").pop() || "").slice(0, 4); return `<div class="card file" data-act="viewFile" data-name="${esc(f.name)}"><div class="sp-between"><div class="fext">${esc(ext)}</div><button class="btn ghost sm" data-act="deleteFile" data-name="${esc(f.name)}" title="Remove (stays in history)">${ICON.trash}</button></div><div class="fname">${esc(f.name)}</div><div class="mono faint" style="font-size:11px">${f.size < 1024 ? f.size + " B" : (f.size / 1024).toFixed(1) + " KB"}</div></div>`; }).join("")}</div>`;
}
function bindDrop() {
  const drop = $("#drop"); if (!drop) return;
  const input = $("#fileInput");
  drop.addEventListener("dragover", e => { e.preventDefault(); drop.classList.add("over"); });
  drop.addEventListener("dragleave", () => drop.classList.remove("over"));
  drop.addEventListener("drop", e => { e.preventDefault(); drop.classList.remove("over"); uploadFiles(e.dataTransfer.files); });
  input.addEventListener("change", () => uploadFiles(input.files));
}
async function uploadFiles(list) {
  for (const f of list) { try { const r = await post(`/api/projects/${S.slug}/files?name=${encodeURIComponent(f.name)}`, f); toast(`Uploaded \`${r.name}\``); } catch (e) { toast(e.message, true); } }
}

// ---------- Log ----------
function vLog() {
  const grp = (k, arr, cls = "") => arr?.length ? `<div class="grp ${cls}"><div class="k">${k}</div><ul>${arr.map(x => `<li>${inline(x)}</li>`).join("")}</ul></div>` : "";
  return header("Updates", "Everything your agents shared, exactly as they sent it. The Overseer sums up each one.", chip("append", null, "permanent record"), `<button class="btn" data-act="push">${ICON.upload}Share an update</button>`) +
    `<div class="ledger">${S.d.log.map(e => { const p = e.payload || {}; const breaking = p.breaking_changes?.length; return `<div class="card log-item">${avatar(e.agent, false)}<div style="min-width:0">
      <div class="head"><span class="mono" style="color:${color(e.agent)}">${esc(e.agent)}</span>${chip(e.kind === "push" ? "" : "append", null, e.kind === "push" ? "update" : "recap")}${e.task ? chip("ai", null, esc(e.task)) : ""}${breaking ? chip("bad", null, "breaking") : ""}${p.branch ? `<span class="mono faint" style="font-size:11.5px">${ICON.branch.replace("<svg", '<svg width="11" height="11" style="vertical-align:-1px"')} ${esc(p.branch)}${p.commit ? "@" + esc(p.commit) : ""}</span>` : ""}<span class="faint mono" style="margin-left:auto;font-size:11.5px">${when(e.at)}</span></div>
      <div class="summary">${e.summary ? inline(e.summary) : `<span class="shimmer">conductor processing…</span>`}</div>
      <details><summary>${e.kind === "push" ? "structured push" : "transcript"}</summary><div class="payload">${e.kind === "push" ? `${p.summary ? `<div>${inline(p.summary)}</div>` : ""}${grp("Breaking changes", p.breaking_changes, "breaking")}${grp("Changes", p.changes)}${grp("Decisions", p.decisions)}${grp("Files touched", p.files_touched)}${grp("Next steps", p.next_steps)}${grp("Links", p.links)}${p.notes ? `<div class="md">${md(p.notes)}</div>` : ""}` : `<div class="md">${md(p.transcript)}</div>`}</div></details>
    </div></div>`; }).join("") || `<div class="card"><div class="empty">Nothing pushed yet.</div></div>`}</div>`;
}

// ---------- Access ----------
const ACCESS_HELP = { none: "Can't see this project at all", read: "Can pull context, search, read files and messages", write: "Can also push updates, save recaps and upload files" };
async function vAccess() {
  const [a, mem] = await Promise.all([api(`/api/projects/${S.slug}/access`), S.st.secure ? api(`/api/projects/${S.slug}/members`).catch(() => null) : null]);
  const people = !S.st.secure ? `<div class="card" style="margin-bottom:16px"><div class="card-h">${ICON.users.replace("<svg", '<svg width="14" height="14"')}People</div><div class="card-b row" style="justify-content:space-between"><span class="faint" style="font-size:13px">Open mode: anyone who can reach this hub sees every project. Create an account to give each project its own members.</span><button class="btn primary sm" data-act="secureHub">Secure this hub</button></div></div>`
    : mem ? `<div class="card" style="margin-bottom:16px"><div class="card-h">${ICON.users.replace("<svg", '<svg width="14" height="14"')}People<div class="right faint" style="font-size:12px">${mem.legacyOpen ? "No members yet: every signed-in person can see this project" : `${mem.members.length} member${mem.members.length === 1 ? "" : "s"}`}</div></div>
      ${mem.members.map(m => `<div class="link-row" style="grid-template-columns:30px minmax(0,1fr) auto">${avatar(m.name, false)}<div><div style="font-weight:500">${esc(m.name)}</div><div class="faint" style="font-size:12px">${esc(m.email)}</div></div><div class="row">${chip(m.role === "owner" ? "ai" : "", null, m.role)}${mem.canManage && m.role !== "owner" ? `<button class="btn ghost sm" data-act="removeMember" data-id="${esc(m.id)}">Remove</button>` : ""}</div></div>`).join("")}
      ${mem.canManage ? `<div class="card-b row" style="border-top:1px solid var(--line)"><input id="memEmail" type="email" placeholder="teammate@team.dev" style="flex:1;min-width:200px"><select id="memRole" style="width:120px"><option value="member">member</option><option value="owner">owner</option></select><button class="btn primary sm" data-act="addMember">Add person</button></div>` : ""}</div>` : "";
  const rows = a.agents.map(x => {
    const on = x.lastSeen && Date.now() - Date.parse(x.lastSeen) < 10 * 60 * 1000;
    return `<div class="link-row" style="grid-template-columns:30px minmax(0,1fr) auto">${avatar(x.agent, on)}
      <div style="min-width:0"><div style="font-weight:500;color:${color(x.agent)}">${esc(x.agent)}</div>
        <div class="faint" style="font-size:12px">${x.lastSeen ? `seen ${ago(x.lastSeen)} ago` : "never connected"}${x.hasToken ? " · has token" : ""} · ${x.explicit ? esc(ACCESS_HELP[x.access]) : `using default (${esc(a.default)})`}</div></div>
      <div class="row"><div class="seg">${a.levels.map(l => `<button class="${x.access === l ? "on" : ""}" data-act="setAccess" data-agent="${esc(x.agent)}" data-level="${l}" style="${x.access === l && l === "none" ? "color:var(--red)" : x.access === l && l === "write" ? "color:var(--green)" : ""}">${l[0].toUpperCase() + l.slice(1)}</button>`).join("")}</div>
        ${x.explicit ? `<button class="btn ghost sm" data-act="setAccess" data-agent="${esc(x.agent)}" data-level="default" title="Use the default">Reset</button>` : `<span style="width:52px"></span>`}</div></div>`;
  }).join("");
  return header("Access", "Who can see this project, and which agents can use it. Enforced by the server on every request; denied attempts are logged.", chip("lock", "lock", "gateway-enforced")) + people + `
  <div class="side-h" style="padding:0;margin:4px 0 8px">Agents</div>
  <div class="card" style="margin-bottom:16px"><div class="card-b row" style="justify-content:space-between">
    <div class="faint" style="font-size:13px">Default for agents without a rule: <b style="color:var(--text)">${esc(a.default)}</b>${a.secure ? " (secure mode: agents start with no access)" : " (open mode: create an account to start agents with no access)"}</div>
    <div class="row"><input id="accAgent" placeholder="agent name" style="width:160px"><select id="accLevel" style="width:110px">${a.levels.map(l => `<option ${l === "read" ? "selected" : ""}>${l}</option>`).join("")}</select><button class="btn primary sm" data-act="addAccess">Add rule</button></div>
  </div></div>
  <div class="card">${rows || `<div class="empty">No agents yet. Connect one, then decide what it can see.</div>`}</div>
  <div class="grid g3" style="margin-top:16px">${a.levels.map(l => `<div class="card card-b"><div style="font-weight:600;margin-bottom:4px">${l[0].toUpperCase() + l.slice(1)}</div><div class="faint" style="font-size:12.5px">${ACCESS_HELP[l]}</div></div>`).join("")}</div>`;
}

// ---------- Ask the brain (retrieval with sources) ----------
const KIND_LABEL_SRC = { brief: "Brief", instructions: "Rules", playbook: "Playbook", decision: "Decision", file: "File", push: "Push", conversation: "Recap", message: "Message", links: "Links" };
async function askModal(question = "", project = S.slug, mode = "answer", cached = null) {
  openModal(`<div class="modal-h"><h2>Ask the brain</h2><div class="seg" style="margin-left:8px"><button class="${mode === "answer" ? "on" : ""}" data-askmode="answer">Cited answer</button><button class="${mode === "sources" ? "on" : ""}" data-askmode="sources">Sources only</button></div><button class="x" data-act="close">×</button></div>
    <div class="modal-b"><form id="askForm" class="row" style="margin-bottom:14px"><input id="askQ" value="${esc(question)}" placeholder="What did we decide about the signup API?" style="flex:1;min-width:260px" autocomplete="off">
      <select id="askProj" style="width:180px"><option value="">All my projects</option>${S.st.projects.map(p => `<option value="${esc(p.slug)}" ${p.slug === project ? "selected" : ""}>${esc(p.name)}</option>`).join("")}</select>
      <button class="btn primary" type="submit">Ask</button></form><div id="askOut"><div class="faint" style="font-size:13px">Answers come only from your project knowledge. Every fact links to its original source.</div></div></div>`, true);
  const form = $("#askForm");
  form.onsubmit = (e) => { e.preventDefault(); runAsk($("#askQ").value, $("#askProj").value || null, mode); };
  document.querySelectorAll("[data-askmode]").forEach(b => b.onclick = () => askModal($("#askQ").value, $("#askProj").value || null, b.dataset.askmode));
  if (question.trim()) runAsk(question, project, mode, cached);
}
async function runAsk(question, project, mode, cached = null) {
  const out = $("#askOut"); if (!out || !question.trim()) return;
  let r = cached;
  if (!r) {
    out.innerHTML = `<span class="shimmer">${mode === "answer" ? "Searching sources, then the Overseer writes a cited answer…" : "Searching sources…"}</span>`;
    try { r = await post("/api/ask", { question, project: project || undefined, mode }); } catch (e) { out.innerHTML = `<div class="empty" style="color:var(--red)">${esc(e.message)}</div>`; return; }
  }
  S.lastAsk = { question, project, mode, r };
  if (!$("#askOut")) return;
  const chipFor = (n) => { const s = r.sources[n - 1]; return s ? `<button class="cite" data-act="openSource" data-ref="${esc(s.ref)}" title="${esc(s.title)}">S${n}</button>` : `[S${n}]`; };
  const answer = r.answer ? DOMPurify.sanitize(marked.parse(r.answer.replace(/\[S(\d+)\]/g, (_, n) => `@@S${n}@@`))).replace(/@@S(\d+)@@/g, (_, n) => chipFor(+n)) : "";
  const usedSet = new Set(r.used || []);
  const list = r.sources.map((s, i) => `<div class="src ${r.answer && !usedSet.has(i + 1) ? "unused" : ""}" data-act="openSource" data-ref="${esc(s.ref)}">
      <div class="src-h"><span class="cite static">S${i + 1}</span><span class="chip ${s.kind === "decision" ? (s.status === "superseded" ? "bad" : "ok") : ""}">${KIND_LABEL_SRC[s.kind] || s.kind}</span><span class="src-t">${esc(s.title)}</span><span class="faint mono" style="font-size:11px;margin-left:auto;white-space:nowrap">${esc(s.project)}${s.at ? " · " + esc(s.at.slice(0, 10)) : ""}</span></div>
      <div class="src-x">${esc(s.excerpt.replace(/\s+/g, " ").slice(0, 220))}</div><code class="mono src-ref">${esc(s.ref)}</code></div>`).join("");
  out.innerHTML = `${r.fallback ? `<div class="reason" style="background:var(--amber-bg);border-radius:8px;margin-bottom:12px"><span style="color:var(--amber)">Overseer unavailable:</span>${esc(r.fallback)} Showing ranked sources.</div>` : ""}
    ${answer ? `<div class="card" style="margin-bottom:14px"><div class="card-b md answer">${answer}</div>${r.confidence ? `<div class="reason" style="border-top:1px solid var(--line);border-bottom:none"><span class="faint">Confidence</span>${chip(r.confidence === "high" ? "ok" : r.confidence === "low" ? "bad" : "lock", null, r.confidence)}<span class="faint" style="margin-left:auto">${r.used.length} of ${r.sources.length} sources cited</span></div>` : ""}</div>` : ""}
    ${r.conflicts?.length ? `<div class="card" style="margin-bottom:14px;border-color:rgba(251,191,36,.3)"><div class="card-h" style="color:var(--amber)">Conflicts / outdated info</div><div class="card-b md" style="font-size:13.5px"><ul>${r.conflicts.map(c => `<li>${DOMPurify.sanitize(marked.parseInline(c)).replace(/\[S(\d+)\]/g, (_, n) => chipFor(+n))}</li>`).join("")}</ul></div></div>` : ""}
    ${r.sources.length ? `<div class="side-h" style="padding:0;margin:0 0 8px">Sources</div><div class="srcs">${list}</div>` : `<div class="empty">Nothing in your project knowledge matches that.</div>`}`;
}
async function sourceModal(ref) {
  const fromAsk = !!$("#askOut") && S.lastAsk;
  openModal(`<div class="modal-h">${fromAsk ? `<button class="btn ghost sm" data-act="backToAsk">← Back to answer</button>` : ""}<span class="chip">${esc(ref.split(":")[0])}</span><h2 id="srcTitle" style="font-size:14.5px">Loading…</h2><button class="x" data-act="close">×</button></div><div class="modal-b" id="srcBody"><span class="shimmer">loading original…</span></div>`, true);
  let s; try { s = await api(`/api/source?ref=${encodeURIComponent(ref)}`); } catch (e) { $("#srcBody").innerHTML = `<div class="empty" style="color:var(--red)">${esc(e.message)}</div>`; return; }
  $("#srcTitle").textContent = s.title;
  const meta = Object.entries(s.meta || {}).filter(([k, v]) => v !== null && v !== undefined && v !== "" && v !== false && k !== "note").map(([k, v]) => `<span><span class="faint">${esc(k)}</span> ${esc(Array.isArray(v) ? v.join(", ") : String(v))}</span>`).join("");
  const isMd = ["brief", "instructions", "playbook", "decision", "push", "conversation", "links"].includes(s.kind) || /\.md$/i.test(s.title);
  $("#srcBody").innerHTML = `<div class="row mono" style="font-size:11.5px;gap:14px;margin-bottom:12px">${meta}<span class="faint">ref</span> ${esc(s.ref)}</div>
    ${s.meta?.note ? `<div class="reason" style="background:var(--amber-bg);border-radius:8px;margin-bottom:12px"><span style="color:var(--amber)">${esc(s.meta.note)}</span></div>` : ""}
    ${s.content === null ? `<div class="empty">Binary file. Download it from the Files page.</div>` : isMd ? `<div class="md">${md(s.content)}</div>` : `<pre class="diff" style="margin:0;padding:14px;background:var(--bg-2);border-radius:10px;border:1px solid var(--line);max-height:65vh;overflow:auto">${esc(s.content)}</pre>`}`;
}

// ---------- First-run onboarding ----------
// 1. name your project  2. connect Claude Code with one command  3. wait for the agent's first request (live)
// S.onb = { step, slug, name, agent, token, connected: requestRecord | null }
function onboardingHtml() {
  const o = S.onb || { step: 1 };
  const me = S.st.user?.name && S.st.user.name !== "human" ? S.st.user.name.split(" ")[0] : null;
  const dot = (n) => `<span class="step-n" style="${o.step > n ? "background:var(--green-bg);color:var(--green);border-color:rgba(74,222,128,.35)" : o.step === n ? "" : "opacity:.4"}">${o.step > n ? "✓" : n}</span>`;
  const s1 = o.step === 1 ? `<div class="row" style="margin-top:4px"><input id="onbName" placeholder="e.g. Fitness app" style="flex:1;min-width:220px" autocomplete="off"><input id="onbDesc" placeholder="One line about it (optional)" style="flex:2;min-width:240px"><button class="btn primary" data-act="onbCreate">Create project</button></div>` : `<div class="faint" style="font-size:13px">${esc(o.name)}</div>`;
  const s2 = o.step === 2 || o.step === 3 ? installStep("→", { token: o.token, agent: o.agent, project: o.slug }).replace(/<div class="step"><span class="step-n">→<\/span><div><h4>[^<]*<\/h4>/, "<div><div>") : "";
  const s3 = o.step === 3 ? (o.connected
    ? `<div class="reason" style="border:1px solid rgba(74,222,128,.3);background:var(--green-bg);border-radius:10px;margin-top:6px"><span style="color:var(--green);font-weight:600">✓ ${esc(o.agent)} is connected</span><span>First request through the gateway: <b>${esc(o.connected.label)}</b>${o.connected.resource ? ` · <code class="mono">${esc(o.connected.resource)}</code>` : ""}</span><button class="btn primary sm" style="margin-left:auto" data-act="onbDone">Open project</button></div>`
    : `<div class="row" style="margin-top:6px"><span class="shimmer" style="font-size:13.5px">Waiting for ${esc(o.agent)}'s first request through the gateway…</span><span class="faint" style="font-size:12.5px">Run the command, then start Claude Code in that folder.</span></div>`) : "";
  return `<div style="max-width:760px;margin:6vh auto 0">
    <div style="margin-bottom:28px"><img src="/assets/loom-mark.png" alt="" style="width:44px;height:44px;display:block;margin-bottom:16px">
      <h1 style="font-size:30px;letter-spacing:-.03em;margin:0">${me ? `Welcome, ${esc(me)}.` : "Welcome to Loom."} Let's connect your first agent.</h1>
      <p class="muted" style="margin:8px 0 0;font-size:15px">Give your agents one shared brain. Every session starts with the project's context, and every request goes through a gateway you control.</p></div>
    <div class="card"><div class="card-b" style="padding:22px">
      <div class="step">${dot(1)}<div><h4>Name your project</h4>${s1}</div></div>
      <div class="step" style="${o.step < 2 ? "opacity:.45" : ""}">${dot(2)}<div><h4>Connect Claude Code: run this once in your project folder</h4>${o.step >= 2 ? s2 + (o.step === 2 ? `<div class="row" style="margin-top:10px"><button class="btn primary" data-act="onbRan">I ran it</button><button class="btn ghost" data-act="onbSkip">Skip for now</button></div>` : "") : `<div class="faint" style="font-size:13px">One command sets up the MCP connection, automatic context and tool-call checks.</div>`}</div></div>
      <div class="step" style="margin-bottom:0;${o.step < 3 ? "opacity:.45" : ""}">${dot(3)}<div><h4>Start a Claude Code session</h4>${o.step === 3 ? s3 : `<div class="faint" style="font-size:13px">We'll watch the gateway and tell you the moment your agent connects.</div>`}</div></div>
    </div></div>
    ${S.st.projects.length && !S.onb ? "" : S.st.projects.length ? `<p style="text-align:center;margin-top:16px"><a href="#" data-act="onbSkip">Skip setup, go to my projects</a></p>` : ""}
  </div>`;
}
function bindOnboarding() { setTimeout(() => $("#onbName")?.focus(), 30); if (S.onb?.step === 3 && !S.onb.connected) checkOnboardingConnection(); }
async function checkOnboardingConnection() {
  const o = S.onb; if (!o || o.connected) return;
  const rows = await api(`/api/requests?actor=${encodeURIComponent(o.agent)}&limit=20`).catch(() => []);
  const first = rows.filter(r => r.outcome === "allowed" && r.action !== "session.connect").pop() || rows.find(r => r.outcome === "allowed");
  if (first) { o.connected = first; renderMain(); toast(`**${o.agent}** connected through the gateway`); }
}

// ---------- Gateway ----------
// Every managed request: who, what, which project, the outcome, why, and how long it took.
S.gw = { outcome: "", actor: "", project: "", q: "", rows: [], maxSeq: 0, limit: 150 };
const KIND_LABEL = { agent: "agent", human: "human", overseer: "overseer", unknown: "unidentified" };
const OUTCOME_LABEL = { allowed: "Allowed", denied: "Denied", unauthenticated: "Unauthenticated", error: "Error" };
const fmtMs = (ms) => ms == null ? "" : ms >= 1000 ? `${(ms / 1000).toFixed(ms >= 10000 ? 0 : 1)} s` : `${ms} ms`;
function actorCell(r) {
  const c = r.actorKind === "overseer" ? "var(--accent-2)" : r.actorKind === "human" ? "var(--amber)" : r.actorKind === "unknown" ? "var(--faint)" : color(r.actor);
  const name = r.actorKind === "overseer" ? "Overseer" : r.actor === "unknown" ? "Unknown client" : r.actor;
  return `<span class="actor"><span class="dot" style="background:${c}"></span><span style="color:var(--text);font-weight:500;overflow:hidden;text-overflow:ellipsis">${esc(name)}</span></span><span class="code">${esc(KIND_LABEL[r.actorKind] || r.actorKind)} · ${esc(r.channel)}</span>`;
}
function gwRow(r, isNew) {
  return `<tr class="${r.outcome} ${isNew ? "new" : ""}" data-act="gwDetail" data-id="${esc(r.id)}">
    <td class="t">${clock(r.at)}<span class="code">${new Date(r.at).toLocaleDateString([], { month: "short", day: "numeric" })}</span></td>
    <td>${actorCell(r)}</td>
    <td><div class="act">${esc(r.label)}</div><span class="code">${esc(r.action)}</span></td>
    <td><div class="res">${r.project ? esc(r.project) : '<span class="faint">—</span>'}</div>${r.resource ? `<span class="code" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(r.resource)}</span>` : ""}</td>
    <td>${r.detail?.decision === "ask" ? `<span class="outcome unauthenticated">Asked user</span>` : `<span class="outcome ${r.outcome}">${OUTCOME_LABEL[r.outcome] || r.outcome}</span>`}${r.reason ? `<span class="why" title="${esc(r.reason)}">${esc(r.reason)}</span>` : ""}</td>
    <td class="ms">${fmtMs(r.ms)}</td></tr>`;
}
async function loadGateway() {
  const g = S.gw, qs = new URLSearchParams({ limit: g.limit });
  if (g.outcome) qs.set("outcome", g.outcome);
  if (g.actor) qs.set("actor", g.actor);
  if (g.project) qs.set("project", g.project);
  const [rows, stats] = await Promise.all([api(`/api/requests?${qs}`), api("/api/requests/stats")]);
  g.rows = rows; g.stats = stats;
}
function gwTableHtml() {
  const g = S.gw, ql = g.q.toLowerCase();
  const rows = g.rows.filter(r => !ql || [r.actor, r.action, r.label, r.project, r.resource, r.reason].some(v => v && String(v).toLowerCase().includes(ql)));
  const html = rows.map(r => gwRow(r, g.maxSeq && r.seq > g.maxSeq)).join("");
  g.maxSeq = Math.max(g.maxSeq, ...g.rows.map(r => r.seq), 0);
  return rows.length ? `<table class="gw-table"><colgroup><col style="width:84px"><col style="width:16%"><col style="width:22%"><col style="width:22%"><col><col style="width:78px"></colgroup>
    <thead><tr><th>Time</th><th>Who</th><th>Action</th><th>Project · resource</th><th>Outcome</th><th style="text-align:right">Latency</th></tr></thead><tbody>${html}</tbody></table>
    ${g.rows.length >= g.limit ? `<div class="pager"><button class="btn sm" data-act="gwMore">Load older</button></div>` : ""}`
    : `<div class="empty">No requests match. Connect an agent and they'll appear here live.</div>`;
}
function gwStatsHtml() {
  const s = S.gw.stats || {}, o = S.gw.outcome;
  const tile = (key, label, v, cls = "") => `<div class="stat ${o === key ? "on" : ""}" data-act="gwOutcome" data-o="${key}"><div class="k">${label}</div><div class="v ${cls}">${v ?? 0}</div></div>`;
  return tile("", "Requests · 24h", s.total) + tile("allowed", "Allowed", s.allowed, "ok") + tile("denied", "Denied", s.denied, s.denied ? "no" : "") +
    tile("unauthenticated", "Unauthenticated", s.unauthenticated, s.unauthenticated ? "warn" : "") + tile("error", "Errors", s.error) +
    `<div class="stat" title="Average time the gateway takes to answer (excludes asked questions, which take seconds by design)"><div class="k">Gateway latency</div><div class="v">${s.avgMs ?? 0}<small>ms</small></div></div>`;
}
async function vGateway() {
  await loadGateway();
  const g = S.gw, s = g.stats;
  const actors = [...new Set([...S.st.agents.map(a => a.name), "human", "conductor", "unknown", ...g.rows.map(r => r.actor)])];
  const agentChips = (s.agents || []).map(a => `<button class="agent-chip ${g.actor === a.actor ? "on" : ""}" data-act="gwActor" data-actor="${esc(a.actor)}"><span class="dot ${S.st.agents.some(x => x.name === a.actor && online(x)) ? "on" : ""}"></span><span style="color:${color(a.actor)};font-weight:500">${esc(a.actor)}</span><span class="faint">${a.n} req</span>${a.denied ? `<span class="outcome denied">${a.denied} denied</span>` : `<span class="outcome allowed">clean</span>`}</button>`).join("");
  return header(`Technical log <span class="live-dot" style="margin-left:2px"></span>`, "Every request your agents and this dashboard made: who, what, whether it was allowed, and how long it took. Only names and sizes are recorded, never content.", "", `<button class="btn" data-act="gwRefresh">${ICON.sync}Refresh</button>`) + `
  <div class="gw-flow"><span class="step">Identify caller</span><span class="arrow">→</span><span class="step">Check access</span><span class="arrow">→</span><span class="step">Route request</span><span class="arrow">→</span><span class="step">Record outcome</span></div>
  <div class="gw-stats" id="gwStats">${gwStatsHtml()}</div>
  ${agentChips ? `<div class="row" style="margin-bottom:14px"><span class="faint" style="font-size:12.5px;margin-right:2px">Agents · 24h</span>${agentChips}</div>` : ""}
  <div>
    <div>
      <div class="gw-bar">
        <select id="gwActor" data-gw="actor"><option value="">Everyone</option>${actors.map(a => `<option value="${esc(a)}" ${g.actor === a ? "selected" : ""}>${esc(a === "unknown" ? "Unknown clients" : a === "conductor" ? "Overseer" : a)}</option>`).join("")}</select>
        <select id="gwProject" data-gw="project"><option value="">All projects</option>${S.st.projects.map(p => `<option value="${esc(p.slug)}" ${g.project === p.slug ? "selected" : ""}>${esc(p.name)}</option>`).join("")}</select>
        <input id="gwQ" placeholder="Filter by action, resource, reason…" value="${esc(g.q)}" style="flex:1;min-width:200px">
        ${g.outcome || g.actor || g.project || g.q ? `<button class="btn ghost sm" data-act="gwClear">Clear filters</button>` : ""}
      </div>
      <div class="card" id="gwTable" style="overflow:hidden">${gwTableHtml()}</div>
    </div>
  </div>`;
}
let gwTimer = null;
function refreshGatewayLive() {
  clearTimeout(gwTimer);
  gwTimer = setTimeout(async () => {
    if (S.view !== "gateway") return;
    await loadGateway();
    const t = $("#gwTable"), st = $("#gwStats");
    if (t) t.innerHTML = gwTableHtml();
    if (st) st.innerHTML = gwStatsHtml();
  }, 200);
}
function gwDetail(id) {
  const r = S.gw.rows.find(x => x.id === id); if (!r) return;
  const row = (k, v) => v === null || v === undefined || v === "" ? "" : `<dt>${k}</dt><dd>${v}</dd>`;
  openModal(`<div class="modal-h"><span class="outcome ${r.outcome}">${OUTCOME_LABEL[r.outcome]}</span><h2>${esc(r.label)}</h2><button class="x" data-act="close">×</button></div>
    <div class="modal-b"><dl class="kv">
      ${row("When", `${new Date(r.at).toLocaleString()} <span class="faint mono">(${esc(r.at)})</span>`)}
      ${row("Caller", `${esc(r.actorKind === "overseer" ? "Overseer" : r.actor)} <span class="faint">· ${esc(KIND_LABEL[r.actorKind] || r.actorKind)}</span>`)}
      ${row("Channel", esc(r.channel))}${row("Client", r.client ? `<code>${esc(r.client)}</code>` : "")}
      ${row("Action", `${esc(r.label)} · <code>${esc(r.action)}</code>`)}
      ${row("Access needed", r.access ? `<code>${esc(r.access)}</code>` : "")}
      ${row("Project", r.project ? `<a href="#/${esc(r.project)}/overview" data-act="close">${esc(r.project)}</a>` : "")}
      ${row("Resource", r.resource ? `<code>${esc(r.resource)}</code>` : "")}
      ${row("Status", r.status ? `<code>${r.status}</code>` : "")}
      ${row("Reason", r.reason ? esc(r.reason) : "")}
      ${row("Latency", r.ms != null ? `${r.ms} ms` : "")}
      ${row("Metadata", r.detail ? `<code>${esc(JSON.stringify(r.detail))}</code>` : "")}
      ${row("Request id", `<code>${esc(r.id)}</code>`)}
    </dl><p class="faint" style="font-size:12px;margin:16px 0 0">The gateway records metadata only. Message text, file contents and document bodies are never stored in this log.</p></div>`);
}

// ---------- Tool policies ----------
async function vPolicies() {
  const { rules } = await api("/api/policies");
  const row = (r) => `<tr class="${r.enabled ? "" : "off"}" style="${r.enabled ? "" : "opacity:.45"}">
    <td class="t">${esc(r.id)}</td>
    <td><span class="outcome ${r.decision === "deny" ? "denied" : "unauthenticated"}">${r.decision === "deny" ? "Block" : "Ask me first"}</span></td>
    <td><div class="res">${esc(r.tools)}</div>${r.project ? `<span class="code">${esc(r.project)} only</span>` : `<span class="code">all projects</span>`}</td>
    <td><div style="color:var(--text)">${esc(r.reason)}</div><span class="code" title="${esc(r.pattern)}" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(r.pattern)}</span></td>
    <td style="text-align:right;white-space:nowrap"><button class="btn ghost sm" data-act="policyToggle" data-id="${esc(r.id)}" data-on="${r.enabled ? 0 : 1}">${r.enabled ? "Disable" : "Enable"}</button>${r.builtIn ? "" : `<button class="btn ghost sm" data-act="policyDelete" data-id="${esc(r.id)}" title="Delete">${ICON.trash}</button>`}</td></tr>`;
  return header("Tool rules", "Before a connected Claude Code runs a command, edits a file or opens a website, it checks these rules. <b>Block</b> stops it. <b>Ask me first</b> makes it ask you. Everything else works as normal. These rules only add limits; they never remove yours.", chip("lock", "lock", "enforced by Loom")) + `
  <div class="card" style="margin-bottom:16px"><div class="card-h">Test a command</div><div class="card-b row">
    <select id="ptTool" style="width:130px"><option>Bash</option><option>PowerShell</option><option>Read</option><option>Edit</option><option>Write</option></select>
    <input id="ptText" placeholder="e.g. git push --force origin main   or   .env" style="flex:1;min-width:240px">
    <button class="btn primary sm" data-act="policyTest">Check</button>
    <div id="ptOut" style="width:100%;font-size:13px"></div></div></div>
  <div class="card" style="overflow:hidden;margin-bottom:16px"><table class="gw-table"><colgroup><col style="width:80px"><col style="width:100px"><col style="width:20%"><col><col style="width:150px"></colgroup>
    <thead><tr><th>Rule</th><th>What happens</th><th>Applies to</th><th>Why, and what it matches</th><th></th></tr></thead><tbody>${rules.map(row).join("")}</tbody></table></div>
  <div class="card"><div class="card-h">${ICON.plus.replace("<svg", '<svg width="14" height="14"')}Add a rule</div><div class="card-b">
    <div class="row" style="margin-bottom:10px"><select id="prDecision" style="width:120px"><option value="deny">Block</option><option value="ask">Ask me first</option></select>
      <input id="prTools" value="Bash|PowerShell" placeholder="Tools, e.g. Bash|Edit or *" style="width:190px">
      <select id="prProject" style="width:180px"><option value="">All projects</option>${S.st.projects.map(p => `<option value="${esc(p.slug)}">${esc(p.name)} only</option>`).join("")}</select></div>
    <div class="row" style="margin-bottom:10px"><input id="prPattern" placeholder="Regex on the command or file path, e.g. \\bprisma\\s+migrate\\s+reset\\b" style="flex:1;min-width:280px;font-family:var(--mono);font-size:12.5px"></div>
    <div class="row"><input id="prReason" placeholder="Reason shown to the agent" style="flex:1;min-width:280px"><button class="btn primary" data-act="policyAdd">Add rule</button></div>
  </div></div>`;
}

// ---------- History ----------
function vHistory() {
  return header("History", "Every change to this project: who made it and why. Nothing is ever deleted.", chip("append", null, "permanent")) +
    `<div class="card"><div class="commits">${S.d.commits.map(c => commitRow(c)).join("")}</div></div>`;
}

async function openCommit(sha, slug) {
  if (slug && slug !== S.slug) { go(slug, "history"); await new Promise(r => setTimeout(r, 300)); }
  const commits = S.d.commits;
  const i = commits.findIndex(c => c.sha.startsWith(sha) || sha.startsWith(c.short));
  const c = commits[i]; if (!c) return toast("Commit not found in this project", true);
  const parent = commits[i + 1];
  openModal(`<div class="modal-h"><span class="sha mono" style="color:var(--accent-2)">${esc(c.short)}</span><h2>${esc(c.subject)}</h2><button class="x" data-act="close">×</button></div><div class="modal-b" id="commitBody"><div class="shimmer">computing diff…</div></div>`, true);
  const base = `projects/${S.slug}`;
  const paths = [`${base}/brief.md`, `${base}/instructions.md`, `${base}/links.json`, ...Object.keys(S.d.playbooks).map(t => `${base}/playbooks/${t}.md`), ...S.d.decisions.map(d => `${base}/decisions/${d.id}.md`), ...S.d.files.map(f => `${base}/files/${f.name}`)];
  const results = await Promise.all(paths.map(async p => { const [a, b] = await Promise.all([parent ? getVersion(parent.sha, p) : null, getVersion(c.sha, p)]); return { p, a, b }; }));
  const changed = results.filter(r => r.a !== r.b && !(r.a === null && r.b === null));
  const el = $("#commitBody"); if (!el) return;
  el.innerHTML = `<div class="row" style="margin-bottom:14px"><span class="who ${kindOf(c.author)}">${esc(dn(c.author))}</span><span class="faint mono" style="font-size:12px">${when(c.at)} · ${esc(c.sha)}</span><span style="margin-left:auto" class="faint">${changed.length} file${changed.length === 1 ? "" : "s"} changed</span></div>` +
    (changed.map(r => { const rows = diffLines(r.a ?? "", r.b ?? ""); return `<div class="card" style="margin-bottom:12px"><div class="card-h" style="text-transform:none;letter-spacing:0;font-weight:500"><span class="mono" style="color:var(--text)">${esc(r.p.replace(base + "/", ""))}</span>${r.a === null ? chip("ok", null, "new") : r.b === null ? chip("bad", null, "deleted") : ""}<div class="right">${diffStat(rows)}</div></div><div style="padding:6px 0">${renderDiff(rows)}</div></div>`; }).join("") || `<div class="empty">No content changes in tracked docs (e.g. project creation or metadata).</div>`);
}

// ---------- Snapshots ----------
function vSnapshots() {
  const list = S.d.snapshots.filter(s => S.snapAuto || !s.auto);
  const autoCount = S.d.snapshots.filter(s => s.auto).length;
  return header("Backups", "Saved copies of the whole project. Loom makes one automatically before every update. No agent can change or delete them, and restoring one never loses anything.", chip("lock", "lock", "can't be deleted"), `<input id="snapLabel" placeholder="Name, e.g. before demo" style="width:200px"><button class="btn primary" data-act="snapshot">${ICON.snapshots}Back up now</button>`) + `
  <div class="row" style="margin-bottom:10px"><label class="row faint" style="font-size:12.5px;cursor:pointer"><input type="checkbox" data-act="snapAuto" ${S.snapAuto ? "checked" : ""}> Show ${autoCount} automatic backups</label></div>
  <div class="card">${list.map(s => `<div class="snap"><span class="tag ${s.auto ? "auto" : ""}">${ICON.snapshots}${esc(s.name.split("/").slice(2).join("/"))}</span><div style="min-width:0"><div>${esc(s.message)}</div><div class="mono faint" style="font-size:11.5px">${esc(s.name)} → ${esc(s.commit)} · <span class="who ${kindOf(s.by)}">${esc(dn(s.by))}</span> · ${when(s.at)}</div></div><button class="btn sm" data-act="restoreSnap" data-tag="${esc(s.name)}">${ICON.restore}Restore</button></div>`).join("") || `<div class="empty">No snapshots yet.</div>`}</div>`;
}

// ---------- Approvals ----------
function vApprovals() {
  const pending = S.d.proposals.filter(p => p.status === "pending"), done = S.d.proposals.filter(p => p.status !== "pending");
  const card = (p) => `<div class="card prop"><div class="sp-between"><div class="row"><span class="who conductor">conductor</span><span>proposes to <b>${esc(p.op)}</b> section <b>${esc(p.heading)}</b> in Instructions</span></div>${p.status === "pending" ? `<div class="row"><button class="btn danger sm" data-act="decide" data-id="${p.id}" data-d="reject">Reject</button><button class="btn ok sm" data-act="decide" data-id="${p.id}" data-d="approve">Approve & commit</button></div>` : chip(p.status === "approved" ? "ok" : "bad", null, p.status)}</div>
    <div class="faint" style="margin-top:6px;font-size:12.5px">Why: ${inline(p.reason)}</div>
    <div class="prop-body"><div class="ph">## ${esc(p.heading)} · ${esc(p.op)}</div>${p.op === "delete" ? `<div class="empty">Remove this section</div>` : renderDiff(diffLines(sectionOf(S.d.instructions, p.heading), p.op === "append" ? (sectionOf(S.d.instructions, p.heading) + "\n" + p.content).trim() : p.content))}</div></div>`;
  return header("Approvals", "The Overseer can't change your Rules on its own. When it thinks a rule should change, the suggestion waits here for your OK.", chip("lock", "lock", "you decide")) +
    `<div class="ledger">${pending.map(card).join("") || `<div class="card"><div class="empty">Nothing waiting. ✓</div></div>`}</div>${done.length ? `<div class="side-h" style="margin:22px 0 8px;padding:0">Decided</div><div class="ledger">${done.map(card).join("")}</div>` : ""}`;
}
function sectionOf(mdText, heading) {
  const lines = String(mdText || "").split("\n"); const n = (h) => h.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const i = lines.findIndex(l => /^##\s/.test(l) && n(l.replace(/^##\s*/, "")) === n(heading)); if (i < 0) return "";
  const j = lines.findIndex((l, k) => k > i && /^##\s/.test(l));
  return lines.slice(i + 1, j < 0 ? undefined : j).join("\n").trim();
}

// ============================================================================
// Modals
// ============================================================================
function openModal(html, wide = false) {
  const o = $("#overlay"); o.innerHTML = `<div class="modal ${wide ? "wide" : ""}">${html}</div>`; o.classList.add("open");
  setTimeout(() => o.querySelector("input:not([type=checkbox]),textarea")?.focus(), 30);
}
function closeModal() { const lf = $("#loginForm"); if (lf && lf.dataset.dismiss !== "1") return; $("#overlay").classList.remove("open"); $("#overlay").innerHTML = ""; }
function confirmBox(title, text, okLabel = "Confirm", danger = false) {
  return new Promise(res => {
    openModal(`<div class="modal-h"><h2>${title}</h2><button class="x" data-act="close">×</button></div><div class="modal-b">${text}</div><div class="modal-f"><button class="btn" id="cNo">Cancel</button><button class="btn ${danger ? "danger" : "primary"}" id="cYes">${okLabel}</button></div>`);
    $("#cNo").onclick = () => { closeModal(); res(false); }; $("#cYes").onclick = () => { closeModal(); res(true); };
  });
}
const codebox = (txt) => `<div class="codebox">${esc(txt)}<button class="btn sm copy" data-act="copy" data-text="${esc(txt)}">Copy</button></div>`;

const origin = () => S.st?.publicUrl || location.origin;

// The one-command Claude Code setup: MCP + hooks + slash commands, for this project folder.
function installStep(n, { token, agent, project }) {
  const o = origin();
  const who = token ? { sh: `HIVEMIND_TOKEN="${token}"`, ps: `$env:HIVEMIND_TOKEN="${token}"` } : { sh: `HIVEMIND_AGENT="${agent}"`, ps: `$env:HIVEMIND_AGENT="${agent}"` };
  const proj = project ? { sh: ` HIVEMIND_PROJECT="${project}"`, ps: ` $env:HIVEMIND_PROJECT="${project}";` } : { sh: "", ps: "" };
  return `<div class="step"><span class="step-n">${n}</span><div><h4>Run this once in your project folder</h4>
    <div class="faint" style="font-size:12px;margin-bottom:6px">macOS / Linux / Git Bash</div>
    ${codebox(`${who.sh}${proj.sh} sh -c "$(curl -fsSL ${o}/install/claude-code.sh)"`)}
    <div class="faint" style="font-size:12px;margin:10px 0 6px">Windows PowerShell</div>
    ${codebox(`${who.ps};${proj.ps} irm ${o}/install/claude-code.ps1 | iex`)}
    <ul class="what-it-does"><li>Claude Code gets the project briefing automatically every time it starts</li><li>Every command it runs is checked against your Tool rules</li><li>You get <code class="mono">/pull</code>, <code class="mono">/push</code> and <code class="mono">/handoff</code> to load context, share progress and hand off</li></ul><div class="faint" style="font-size:12px;margin-top:6px">${project ? `This folder is linked to <b>${esc(project)}</b>. ` : ""}Your existing Claude Code settings are kept.</div></div></div>`;
}
function manualSetup(url, headers) {
  return `<details style="margin:-6px 0 18px 36px"><summary>Other apps (Cursor, Claude Desktop) or manual setup</summary><div style="margin-top:10px">
    ${codebox(`claude mcp add --transport http hivemind "${url}"${headers ? ` --header "Authorization: ${headers.Authorization}"` : ""}`)}<div style="height:6px"></div>
    ${codebox(JSON.stringify({ mcpServers: { hivemind: { type: "http", url, ...(headers ? { headers } : {}) } } }, null, 2))}
    <div class="faint" style="font-size:12px;margin-top:6px">MCP-only clients get the tools and gateway checks on every request, but not automatic session context or tool-call policy (those need Claude Code hooks).</div></div></details>`;
}

async function connectModal() {
  const secure = S.st.secure;
  let issued = null;
  const render = async () => {
    const name = ($("#agName")?.value || "alice").trim().replace(/[^\w.@-]/g, "-") || "agent";
    let step1;
    if (secure) {
      const url = `${origin()}/mcp`;
      const tok = issued?.token || "<create a token first>";
      const tokens = await api("/api/tokens").catch(() => []);
      step1 = `<div class="step"><span class="step-n">1</span><div><h4>Create a key for <b>${esc(name)}</b></h4>
        <div class="row" style="margin-bottom:8px">${S.d ? `<span class="faint" style="font-size:12.5px">Access to <b style="color:var(--text)">${esc(S.d.project.name)}</b>:</span><select id="tokAccess" style="width:100px"><option>write</option><option>read</option><option>none</option></select>` : ""}<button class="btn primary sm" id="mkTok">${ICON.plus}Create token</button></div>
        <div class="faint" style="font-size:12px;margin-bottom:8px">The key proves which agent is connecting. It's shown once, so keep it private. You can change what it can see on the Agents page.</div>
        ${issued ? `<div class="reason" style="border:1px solid rgba(62,224,143,.3);background:var(--green-bg);border-radius:8px;margin-bottom:8px"><span style="color:var(--green)">Token for ${esc(issued.agent)}:</span><code class="mono" style="word-break:break-all">${esc(issued.token)}</code></div>` : ""}
        ${tokens.length ? `<div class="card" style="margin-top:6px">${tokens.map(t => `<div class="link-row" style="padding:7px 12px"><span class="mono" style="color:${color(t.agent)}">${esc(t.agent)}</span><span class="mono faint" style="font-size:11.5px">${t.revokedAt ? "revoked" : t.lastUsed ? "used " + ago(t.lastUsed) + " ago" : "never used"} · ${esc(t.id)}</span>${t.revokedAt ? "<span></span>" : `<button class="btn ghost sm" data-revoke="${esc(t.id)}">Revoke</button>`}</div>`).join("")}</div>` : ""}</div></div>
        ${installStep(2, { token: tok, project: S.slug })}
        ${manualSetup(url, { Authorization: `Bearer ${tok}` })}`;
    } else {
      const url = `${origin()}/mcp?agent=${encodeURIComponent(name)}`;
      step1 = `${installStep(1, { agent: name, project: S.slug })}
        <div class="faint" style="font-size:12px;margin:-8px 0 16px 36px;color:var(--amber)">Open mode: Agents are identified by name only. Create an account (lock icon, top right) before putting this online.</div>
        ${manualSetup(url, null)}`;
    }
    $("#cmBody").innerHTML = `${step1}
      <div class="step"><span class="step-n">${secure ? 3 : 2}</span><div><h4>Start Claude Code in that folder</h4><div class="md" style="font-size:13px"><ul>
        <li><b>Automatic context:</b> every new session gets the project briefing through the gateway. No need to explain the project again.</li>
        <li><b>Controlled tools:</b> every tool call is checked against your <a href="#/${esc(S.slug || "")}/policies" data-act="close">tool policies</a> and recorded on the Gateway page.</li>
        <li><code>/pull website</code> for a task briefing · <code>/push</code> to share progress · <code>/handoff</code> before you stop. If the session edited files without pushing, Loom reminds it once.</li></ul></div></div></div>`;
    const mk = $("#mkTok");
    if (mk) mk.onclick = async () => { try { issued = await post("/api/tokens", { agent: name, project: S.slug, access: $("#tokAccess")?.value }); toast(`Token created for **${issued.agent}**`); render(); } catch (e) { toast(e.message, true); } };
    document.querySelectorAll("[data-revoke]").forEach(b => b.onclick = async () => { await api(`/api/tokens/${b.dataset.revoke}`, { method: "DELETE" }); toast("Token revoked"); render(); });
  };
  openModal(`<div class="modal-h"><h2>Connect an agent</h2>${secure ? chip("ok", "lock", "keys required") : chip("lock", null, "open: no keys needed")}<button class="x" data-act="close">×</button></div><div class="modal-b"><div class="field"><label>Give this agent a name</label><input id="agName" value="alice" autocomplete="off" placeholder="e.g. alice-laptop"><div class="faint" style="font-size:12px;margin-top:5px">You'll see this name in Activity. Use one per person and computer, like <i>alice-laptop</i>.</div></div><div id="cmBody"></div></div>`, true);
  render(); $("#agName").addEventListener("input", () => { issued = null; render(); });
}

// ---------- Sign in / create account ----------
// mode: "signin" | "signup". dismissable = shown over a working dashboard (open mode) rather than as a gate.
let SESSION = null;
function showLogin(mode = SESSION && !SESSION.hasAccounts ? "signup" : "signin", dismissable = false) {
  const o = $("#overlay");
  const signup = mode === "signup";
  const teamPw = mode === "team";
  const first = SESSION && !SESSION.hasAccounts;
  o.innerHTML = `<form class="modal" id="loginForm" data-dismiss="${dismissable ? 1 : 0}" style="width:min(420px,100%);margin-top:8vh"><div class="modal-b" style="padding:30px 28px">
    <div class="brand" style="justify-content:center;margin-bottom:8px"><img class="brand-mark" src="/assets/loom-mark.png" alt="">Loom</div>
    <p class="faint" style="text-align:center;margin:0 0 22px;font-size:13px">${signup ? (first ? "Create the first account. This secures the hub: from now on people sign in and agents need tokens." : "Create your account") : teamPw ? "Sign in with the hub's team password" : "Sign in to your workspace"}</p>
    ${signup ? `<div class="field"><label>Name</label><input id="auName" autocomplete="name" placeholder="Alex Chen"></div>` : ""}
    ${teamPw ? "" : `<div class="field"><label>Email</label><input id="auEmail" type="email" autocomplete="email" placeholder="you@team.dev"></div>`}
    <div class="field"><label>Password</label><input id="auPw" type="password" autocomplete="${signup ? "new-password" : "current-password"}" placeholder="${signup ? "At least 8 characters" : ""}"></div>
    <div id="loginErr" style="color:var(--red);font-size:12.5px;min-height:18px"></div>
    <button class="btn primary" style="width:100%;justify-content:center;padding:10px" type="submit">${signup ? "Create account" : "Sign in"}</button>
    <div style="text-align:center;margin-top:16px;font-size:13px" class="faint">
      ${signup ? (first ? "" : `Already have an account? <a href="#" data-auth="signin">Sign in</a>`) : `New here? <a href="#" data-auth="signup">Create an account</a>`}
      ${!signup && SESSION?.passwordLogin ? `<div style="margin-top:6px"><a href="#" data-auth="${teamPw ? "signin" : "team"}">${teamPw ? "Sign in with email" : "Use the team password"}</a></div>` : ""}
      ${dismissable ? `<div style="margin-top:6px"><a href="#" data-auth="close">Not now</a></div>` : ""}
    </div></div></form>`;
  o.classList.add("open");
  setTimeout(() => (o.querySelector("#auName") || o.querySelector("#auEmail") || o.querySelector("#auPw"))?.focus(), 30);
  o.querySelectorAll("[data-auth]").forEach(a => a.onclick = (e) => { e.preventDefault(); if (a.dataset.auth === "close") { o.innerHTML = ""; o.classList.remove("open"); return; } showLogin(a.dataset.auth, dismissable); });
  $("#loginForm").onsubmit = async (e) => {
    e.preventDefault();
    const body = { email: $("#auEmail")?.value, password: $("#auPw").value, name: $("#auName")?.value };
    try { await post(signup ? "/api/signup" : "/api/login", body); location.reload(); }
    catch (err) { $("#loginErr").textContent = err.message; }
  };
}

function renderUserMenu() {
  const host = $("#userSlot"); if (!host || !SESSION) return;
  const u = SESSION.user;
  if (!SESSION.secure) { host.innerHTML = `<button class="btn ghost" data-act="secureHub" title="Anyone who can reach this hub can use it. Create an account to require sign-in." aria-label="Secure this hub">${ICON.lock}<span class="lbl">Secure this hub</span></button>`; return; }
  host.innerHTML = `<div class="switcher" style="position:relative"><button class="btn ghost" data-act="userMenu"><span class="proj-glyph" style="background:${color(u?.name || "you")};width:20px;height:20px;border-radius:50%">${esc((u?.name || "?").slice(0, 1).toUpperCase())}</span>${esc(u?.name || "Team")}</button>
    ${S.userMenuOpen ? `<div class="switch-menu" style="left:auto;right:0;width:220px"><div style="padding:8px 10px 6px"><div style="font-weight:500">${esc(u?.name || "Team admin")}</div><div class="faint" style="font-size:12px">${esc(u?.email || "team password session")}</div>${u?.owner ? `<div style="margin-top:6px">${chip("ai", null, "workspace owner")}</div>` : ""}</div><div class="menu-sep"></div><button class="proj-btn" data-act="logout">Sign out</button></div>` : ""}</div>`;
}

function newProjectModal() {
  openModal(`<div class="modal-h"><h2>New project</h2><button class="x" data-act="close">×</button></div><div class="modal-b">
    <div class="field"><label>Name</label><input id="npName" placeholder="e.g. Hackathon Site"></div>
    <div class="field"><label>Description</label><textarea id="npDesc" rows="2" placeholder="One or two sentences"></textarea></div>
    <div class="field"><label>GitHub repo (optional)</label><input id="npRepo" placeholder="https://github.com/org/repo"></div></div>
    <div class="modal-f"><button class="btn" data-act="close">Cancel</button><button class="btn primary" data-act="createProject">Create</button></div>`);
}

function pushModal() {
  const tasks = S.d ? Object.keys(S.d.playbooks) : [];
  openModal(`<div class="modal-h"><h2>Share an update${S.d ? ` with ${esc(S.d.project.name)}` : ""}</h2><button class="x" data-act="close">×</button></div><div class="modal-b">
    <div class="field"><label>Summary</label><input id="puSum" placeholder="What changed?"></div>
    <div class="field"><label>Details (markdown)</label><textarea id="puNotes" rows="5" placeholder="Decisions, breaking changes, links…"></textarea></div>
    <div class="field"><label>Task area</label><input id="puTask" list="puTasks" placeholder="e.g. website"><datalist id="puTasks">${tasks.map(t => `<option value="${esc(t)}">`).join("")}</datalist></div></div>
    <div class="modal-f"><button class="btn" data-act="close">Cancel</button><button class="btn primary" data-act="doPush">Share</button></div>`);
}

async function briefingModal(task = "") {
  const tasks = Object.keys(S.d.playbooks);
  openModal(`<div class="modal-h"><h2>What an agent sees</h2><select id="bpTask" style="margin-left:8px;width:auto"><option value="">general</option>${tasks.map(t => `<option ${t === task ? "selected" : ""}>${esc(t)}</option>`).join("")}</select><button class="x" data-act="close">×</button></div><div class="modal-b"><div class="faint" style="font-size:12px;margin-bottom:12px">This is exactly the briefing an agent gets when it starts working${task ? ` on ${esc(task)}` : ""}.</div><div class="md" id="bpBody"><span class="shimmer">assembling briefing…</span></div></div>`, true);
  $("#bpTask").onchange = (e) => briefingModal(e.target.value);
  const r = await api(`/api/projects/${S.slug}/briefing?task=${encodeURIComponent(task)}`);
  const el = $("#bpBody"); if (el) el.innerHTML = md(r.markdown);
}

async function fileModal(name) {
  const url = `/api/projects/${S.slug}/files/${encodeURIComponent(name)}`;
  const isImg = /\.(png|jpe?g|gif|webp|svg)$/i.test(name);
  openModal(`<div class="modal-h"><h2 class="mono" style="font-size:14px">${esc(name)}</h2><a class="btn sm" href="${url}" download style="margin-left:8px">Download</a><button class="x" data-act="close">×</button></div><div class="modal-b" id="fvBody">${isImg ? `<img src="${url}" style="max-width:100%;border-radius:8px">` : `<span class="shimmer">loading…</span>`}</div>`, true);
  if (isImg) return;
  const t = await (await fetch(url)).text();
  const el = $("#fvBody"); if (!el) return;
  el.innerHTML = /\.md$/i.test(name) ? `<div class="md">${md(t)}</div>` : `<pre class="diff" style="margin:0;padding:12px;background:var(--bg-2);border-radius:8px;border:1px solid var(--line-2);max-height:70vh;overflow:auto">${esc(t)}</pre>`;
}

// ---------- Command palette ----------
let palIdx = 0, palItems = [], palTimer = null;
function openPalette() {
  const o = $("#overlay");
  o.innerHTML = `<div class="modal palette"><input id="palQ" placeholder="Ask, search the brain, jump anywhere…" autocomplete="off"><div class="pal-list" id="palList"></div>
    <div class="pal-foot"><span><kbd>↑</kbd><kbd>↓</kbd>navigate</span><span><kbd>Enter</kbd>open</span><span><kbd>Esc</kbd>close</span><span style="margin-left:auto">Type a question to ask the brain</span></div></div>`;
  o.classList.add("open");
  const q = $("#palQ"); q.focus();
  q.addEventListener("input", () => { palIdx = 0; buildPalette(q.value); });
  q.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") { e.preventDefault(); palIdx = Math.min(palItems.length - 1, palIdx + 1); paintPalette(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); palIdx = Math.max(0, palIdx - 1); paintPalette(); }
    else if (e.key === "Enter") { e.preventDefault(); palItems[palIdx]?.run(); }
  });
  buildPalette("");
}
function buildPalette(q) {
  const ql = q.toLowerCase().trim();
  const match = (s) => !ql || s.toLowerCase().includes(ql);
  const items = [];
  const act = (sec, icon, t, s, run, r = "") => items.push({ sec, icon, t, s, run: () => { closeModal(); run(); }, r });
  if (ql.length >= 3) act("Ask", "bolt", `Ask the brain: “${q.trim()}”`, "Cited answer from your project knowledge", () => askModal(q.trim(), S.slug), "Enter");
  act("Actions", "plus", "New project", "", newProjectModal);
  act("Actions", "users", "Connect an agent", "MCP + slash commands", connectModal);
  if (S.d) {
    act("Actions", "upload", "Share an update", S.d.project.name, pushModal);
    act("Actions", "snapshots", "Back up now", S.d.project.name, () => takeSnapshot());
    act("Actions", "eye", "Preview briefing as agent", S.d.project.name, () => briefingModal());
    for (const [k, label, ic] of SECTIONS) if (k !== "playbooks") act("Go to", ic, label, S.d.project.name, () => go(S.slug, k));
    for (const t of Object.keys(S.d.playbooks)) act("Go to", "playbook", `Playbook: ${t}`, S.d.project.name, () => go(S.slug, "playbook", t));
  }
  for (const p of S.st.projects) act("Projects", "overview", p.name, p.slug, () => go(p.slug));
  palItems = items.filter(i => match(i.t + " " + i.s));
  paintPalette();
  clearTimeout(palTimer);
  if (ql.length >= 2) palTimer = setTimeout(async () => {
    const hits = await api(`/api/search?q=${encodeURIComponent(q)}`);
    if ($("#palQ")?.value !== q) return;
    palItems = palItems.concat(hits.map(h => ({
      sec: "Brain", icon: { brief: "brief", instructions: "lock", playbook: "playbook", decision: "decisions", file: "files", push: "log", conversation: "log", message: "log" }[h.type] || "doc",
      t: h.title, s: h.snippet, r: `${h.type}${h.project ? " · " + h.project : ""}`,
      run: () => { closeModal(); if (!h.project) return; const v = h.type === "brief" ? "brief" : h.type === "instructions" ? "instructions" : h.type === "playbook" ? "playbook" : h.type === "decision" ? "decisions" : h.type === "file" ? "files" : h.type === "message" ? "overview" : "log"; go(h.project, v, h.type === "playbook" ? h.title : null); },
    })));
    paintPalette();
  }, 160);
}
function paintPalette() {
  const el = $("#palList"); if (!el) return;
  let sec = null, html = "";
  palItems.forEach((it, i) => { if (it.sec !== sec) { sec = it.sec; html += `<div class="pal-sec">${esc(sec)}</div>`; } html += `<div class="pal-item ${i === palIdx ? "on" : ""}" data-pal="${i}">${ICON[it.icon] || ICON.doc}<div style="min-width:0"><span class="t">${esc(it.t)}</span>${it.s ? `<span class="s">${esc(it.s)}</span>` : ""}</div><span class="r">${esc(it.r || "")}</span></div>`; });
  el.innerHTML = html || `<div class="empty">No matches</div>`;
  el.querySelector(".pal-item.on")?.scrollIntoView({ block: "nearest" });
}

// ============================================================================
// Actions
// ============================================================================
async function takeSnapshot() {
  const label = $("#snapLabel")?.value || prompt("Snapshot label", "manual") || "manual";
  try { const r = await post(`/api/projects/${S.slug}/snapshots`, { label }); toast(`Snapshot \`${r.name.split("/").pop()}\` created`); } catch (e) { toast(e.message, true); }
}

document.addEventListener("click", async (e) => {
  const pi = e.target.closest("[data-pal]"); if (pi) { palItems[+pi.dataset.pal]?.run(); return; }
  if (e.target.id === "overlay") { closeModal(); return; }
  const t = e.target.closest("[data-act]"); if (!t) return;
  const a = t.dataset.act, ds = t.dataset;
  try {
    switch (a) {
      case "project": S.switcherOpen = false; go(ds.slug); break;
      case "switcher": S.switcherOpen = !S.switcherOpen; renderSidebar(); renderTopNav(); break;
      case "nav": go(S.slug, ds.view, ds.task || null); break;
      case "kbToggle": S.kbOpen = S.kbOpen === false; try { localStorage.setItem("loom.kbOpen", S.kbOpen ? "1" : "0"); } catch {} renderSidebar(); break;
      case "close": closeModal(); break;
      case "connect": connectModal(); break;
      case "newProject": newProjectModal(); break;
      case "push": pushModal(); break;
      case "copy": { e.stopPropagation(); await navigator.clipboard.writeText(ds.text); t.textContent = "Copied"; setTimeout(() => (t.textContent = "Copy"), 1200); break; }
      case "toggle": { const el = $(ds.target); el.style.display = el.style.display === "none" ? "" : "none"; el.querySelector("input")?.focus(); break; }
      case "docMode": S.docMode[ds.rel] = ds.mode; renderMain(); break;
      case "selVer": S.docSel[ds.rel] = ds.sha; if (S.docMode[ds.rel] === "edit") S.docMode[ds.rel] = "read"; renderMain(); break;
      case "pinSel": { const ta = $("#editor"); const [s0, s1] = [ta.selectionStart, ta.selectionEnd]; if (s0 === s1) return toast("Select the text to pin first", true); ta.setRangeText(`<!-- pin -->\n${ta.value.slice(s0, s1)}\n<!-- /pin -->`, s0, s1, "end"); ta.focus(); break; }
      case "saveDoc": { const r = await post(`/api/projects/${S.slug}/docs`, { kind: ds.kind, task: ds.task || undefined, content: $("#editor").value, message: $("#commitMsg").value || undefined }, "PUT"); const rel = relPath(ds.kind, ds.task); S.docMode[rel] = "diff"; delete S.docSel[rel]; toast(r.sha ? `Committed \`${r.sha.slice(0, 7)}\`` : "No changes"); break; }
      case "restoreFile": if (await confirmBox("Restore this version?", `This writes version <code class="mono">${esc(ds.sha.slice(0, 7))}</code> of <code class="mono">${esc(ds.rel)}</code> as a <b>new commit</b>. Nothing is deleted; you can always go back.`, "Restore")) { await post("/api/restore-file", { path: ds.rel, ref: ds.sha }); delete S.docSel[ds.rel]; S.docMode[ds.rel] = "diff"; toast("Restored as a new commit"); } break;
      case "addDecision": { const title = $("#decTitle").value.trim(), body = $("#decBody").value.trim(); if (!title) return toast("Title required", true); const r = await post(`/api/projects/${S.slug}/decisions`, { title, body, supersedes: $("#decSup").value || null }); toast(`Recorded **${r.id}**`); break; }
      case "addLink": { const url = $("#lkUrl").value.trim(); if (!/^https?:\/\//.test(url)) return toast("Enter a full https:// URL", true); const r = await post(`/api/projects/${S.slug}/links`, { kind: $("#lkKind").value, label: $("#lkLabel").value.trim() || url, url }); toast(r.length ? "Link added" : "Already linked"); break; }
      case "removeLink": if (await confirmBox("Remove link?", "It stays in git history.", "Remove", true)) await api(`/api/projects/${S.slug}/links/${ds.id}`, { method: "DELETE" }); break;
      case "pickFile": if (e.target.closest("button")) return; $("#fileInput").click(); break;
      case "viewFile": if (e.target.closest("[data-act=deleteFile]")) return; fileModal(ds.name); break;
      case "deleteFile": e.stopPropagation(); if (await confirmBox("Remove file?", `<code class="mono">${esc(ds.name)}</code> is removed from the project but stays in git history and every snapshot.`, "Remove", true)) await api(`/api/projects/${S.slug}/files/${encodeURIComponent(ds.name)}`, { method: "DELETE" }); break;
      case "openCommit": openCommit(ds.sha, ds.slug); break;
      case "snapshot": await takeSnapshot(); break;
      case "snapAuto": S.snapAuto = t.checked; renderMain(); break;
      case "restoreSnap": if (await confirmBox("Restore snapshot?", `Every doc in <b>${esc(S.d.project.name)}</b> goes back to <code class="mono">${esc(ds.tag)}</code>.<br><br>This is <b>non-destructive</b>: the current state is snapshotted first, and the restore is a new commit.`, "Restore project")) { await post(`/api/projects/${S.slug}/restore`, { tag: ds.tag }); toast("Project restored"); } break;
      case "policyToggle": await post(`/api/policies/${ds.id}`, { enabled: ds.on === "1" }, "PATCH"); renderMain(); break;
      case "policyDelete": if (await confirmBox("Delete rule?", `Rule <code class="mono">${esc(ds.id)}</code> stops applying immediately.`, "Delete", true)) { await api(`/api/policies/${ds.id}`, { method: "DELETE" }); renderMain(); } break;
      case "policyAdd": { const pattern = $("#prPattern").value.trim(); if (!pattern) return toast("Pattern required", true); await post("/api/policies", { decision: $("#prDecision").value, tools: $("#prTools").value, project: $("#prProject").value || null, pattern, reason: $("#prReason").value.trim() || undefined }); toast("Rule added"); renderMain(); break; }
      case "policyTest": { const r = await post("/api/policies/test", { tool: $("#ptTool").value, text: $("#ptText").value, project: S.slug }); $("#ptOut").innerHTML = r.decision === "pass" ? `<span class="outcome allowed">No rule matched</span> <span class="faint">Claude Code's normal permissions apply · logged as <code class="mono">${esc(r.logged)}</code></span>` : `<span class="outcome ${r.decision === "deny" ? "denied" : "unauthenticated"}">${r.decision === "deny" ? "Denied" : "Ask user"}</span> <b>${esc(r.rule)}</b>: ${esc(r.reason)} <span class="faint">· logged as <code class="mono">${esc(r.logged)}</code></span>`; break; }
      case "onbCreate": {
        const name = $("#onbName").value.trim(); if (!name) return toast("Give your project a name", true);
        const p = await post("/api/projects", { name, description: $("#onbDesc").value.trim() });
        const first = (S.st.user?.name && S.st.user.name !== "human" ? S.st.user.name.split(" ")[0] : "my").toLowerCase().replace(/[^\w-]/g, "");
        const agent = `claude-${first}`;
        let token = null;
        if (S.st.secure) token = (await post("/api/tokens", { agent, project: p.slug, access: "write" })).token;
        else await post(`/api/projects/${p.slug}/access`, { agent, access: "write" }, "PUT");
        S.onb = { step: 2, slug: p.slug, name: p.name, agent, token, connected: null };
        S.slug = p.slug; await loadState(); await loadProject(); renderMain(); break;
      }
      case "onbRan": S.onb.step = 3; renderMain(); break;
      case "onbSkip": case "onbDone": { const slug = S.onb?.slug || S.slug; S.onb = null; await loadState(); go(slug); break; }
      case "openSource": sourceModal(ds.ref); break;
      case "actMode": S.actF.mode = ds.m; renderMain(); break;
      case "actWho": S.actF.who = S.actF.who === ds.n ? "" : ds.n; renderMain(); break;
      case "actRoutine": S.actF.routine = t.checked; renderMain(); break;
      case "actBlocked": S.actF.mode = "blocked"; break;
      case "aiSend": { const text = $("#aiMsgText").value.trim(); if (!text) return; await post("/api/messages", { to: $("#aiMsgTo").value, text, project: S.slug }); await loadState(); renderMain(); toast("Message sent"); break; }
      case "backToAsk": { const a = S.lastAsk; if (a) askModal(a.question, a.project, a.mode, a.r); break; }
      case "askFromOverview": { const q = $("#ovAsk").value.trim(); if (q) askModal(q, S.slug); break; }
      case "secureHub": showLogin("signup", true); break;
      case "userMenu": S.userMenuOpen = !S.userMenuOpen; renderUserMenu(); break;
      case "logout": await post("/api/logout"); location.reload(); break;
      case "addMember": { const email = $("#memEmail").value.trim(); if (!email) return toast("Email required", true); await post(`/api/projects/${S.slug}/members`, { email, role: $("#memRole").value }); toast(`Added **${email}**`); renderMain(); break; }
      case "removeMember": if (await confirmBox("Remove member?", "They'll lose access to this project immediately.", "Remove", true)) { await api(`/api/projects/${S.slug}/members/${ds.id}`, { method: "DELETE" }); renderMain(); } break;
      case "gwOutcome": S.gw.outcome = ds.o; S.gw.maxSeq = 0; renderMain(); break;
      case "gwActor": S.gw.actor = S.gw.actor === ds.actor ? "" : ds.actor; S.gw.maxSeq = 0; renderMain(); break;
      case "gwDetail": gwDetail(ds.id); break;
      case "gwRefresh": S.gw.maxSeq = 0; renderMain(); break;
      case "gwMore": S.gw.limit += 150; refreshGatewayLive(); break;
      case "gwClear": Object.assign(S.gw, { outcome: "", actor: "", project: "", q: "", maxSeq: 0 }); renderMain(); break;
      case "toGateway": Object.assign(S.gw, { outcome: ds.o || "", actor: "", project: ds.project || "", q: "", maxSeq: 0 }); go(S.slug, "gateway"); break;
      case "setAccess": { const r = await post(`/api/projects/${S.slug}/access`, { agent: ds.agent, access: ds.level === "default" ? null : ds.level }, "PUT"); toast(`**${r.agent}** now has **${r.access}** access`); renderMain(); break; }
      case "addAccess": { const agent = $("#accAgent").value.trim(); if (!agent) return toast("Agent name required", true); await post(`/api/projects/${S.slug}/access`, { agent, access: $("#accLevel").value }, "PUT"); toast(`Rule added for **${agent}**`); renderMain(); break; }
      case "decide": await post(`/api/proposals/${ds.id}/${ds.d}`); toast(ds.d === "approve" ? "Approved and committed" : "Rejected"); break;
      case "ghSync": toast("Syncing GitHub…"); await post(`/api/projects/${S.slug}/github/sync`); break;
      case "briefingPreview": briefingModal(); break;
      case "createProject": { const name = $("#npName").value.trim(); if (!name) return toast("Name required", true); const p = await post("/api/projects", { name, description: $("#npDesc").value, repo: $("#npRepo").value.trim() || undefined }); closeModal(); await loadState(); go(p.slug); break; }
      case "doPush": { const summary = $("#puSum").value.trim(); if (!summary) return toast("Summary required", true); await post("/api/push", { summary, notes: $("#puNotes").value, task: $("#puTask").value || undefined, project: S.slug }); closeModal(); toast("Pushed. The conductor will process it shortly"); break; }
    }
  } catch (err) { toast(err.message, true); }
});

document.addEventListener("change", (e) => {
  const k = e.target.dataset?.gw; if (!k) return;
  S.gw[k] = e.target.value; S.gw.maxSeq = 0; renderMain();
});
document.addEventListener("input", (e) => {
  if (e.target.id !== "gwQ") return;
  S.gw.q = e.target.value; const t = $("#gwTable"); if (t) t.innerHTML = gwTableHtml();
});
$("#rpTabs").addEventListener("click", (e) => {
  const b = e.target.closest("button"); if (!b) return;
  S.rtab = b.dataset.tab;
  [...$("#rpTabs").children].forEach(x => x.classList.toggle("on", x === b));
  $("#paneStream").classList.toggle("on", S.rtab === "stream");
  $("#paneChat").classList.toggle("on", S.rtab === "chat");
  renderChat(); if (S.rtab === "chat") $("#msgText").focus();
});
document.addEventListener("click", (e) => {
  if (S.switcherOpen && !e.target.closest(".switcher")) { S.switcherOpen = false; renderSidebar(); renderTopNav(); }
  if (S.userMenuOpen && !e.target.closest("#userSlot")) { S.userMenuOpen = false; renderUserMenu(); }
}, true);
$("#streamFilter").addEventListener("click", (e) => { const b = e.target.closest("button"); if (!b) return; S.filter = b.dataset.f; [...$("#streamFilter").children].forEach(x => x.classList.toggle("on", x === b)); renderStream(); });
$("#composer").addEventListener("submit", async (e) => { e.preventDefault(); const text = $("#msgText").value.trim(); if (!text) return; $("#msgText").value = ""; try { await post("/api/messages", { to: $("#msgTo").value, text, project: S.slug }); } catch (err) { toast(err.message, true); } });
$("#searchBtn").onclick = openPalette;
$("#connectBtn").onclick = connectModal;
$("#settingsBtn").onclick = () => S.slug ? go(S.slug, "policies") : toast("Create a project first", true);
$("#pushBtn").onclick = () => S.d ? pushModal() : toast("Create a project first", true);
// Activity panel: collapsible, remembered per browser.
const store = { get: (k) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch {} } };
function setPanel(open) {
  $(".app").classList.toggle("rp-closed", !open);
  $("#panelToggle").classList.toggle("on", open);
  $("#panelToggle").setAttribute("aria-pressed", String(open));
  store.set("hm.panel", open ? "1" : "0");
  if ($("#topo")) setTimeout(drawTopo, 0);
}
setPanel(store.get("hm.panel") !== "0");
$("#panelToggle").onclick = () => setPanel($(".app").classList.contains("rp-closed"));
document.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === ".") { e.preventDefault(); setPanel($(".app").classList.contains("rp-closed")); return; }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") { e.preventDefault(); $("#overlay").classList.contains("open") ? closeModal() : openPalette(); }
  else if (e.key === "Escape" && $("#overlay").classList.contains("open")) closeModal();
});
window.addEventListener("hashchange", onRoute);
document.addEventListener("toggle", (e) => { const d = e.target; if (!d.matches?.("details.fold")) return; S.folds = S.folds || {}; S.folds[d.dataset.fold] = d.open; if (d.open && d.dataset.fold === "map") drawTopo(); }, true);
window.addEventListener("resize", () => { if ($("#topo")) drawTopo(); });

// ============================================================================
// Live
// ============================================================================
function connectSSE() {
  const es = new EventSource("/api/events");
  es.onopen = () => { S.sse = "live"; renderStatus(); };
  es.onerror = () => { S.sse = "reconnecting"; renderStatus(); };
  es.addEventListener("activity", (ev) => {
    const a = JSON.parse(ev.data);
    if (a.id && S.st && !S.st.activity.find(x => x.id === a.id)) { S.st.activity.unshift(a); renderStream(); }
    if ($("#topo") && a.id) pulseFor(a);
    scheduleRefresh(!!a.refs?.project && a.refs.project === S.slug);
  });
  es.addEventListener("doc", (ev) => {
    const d = JSON.parse(ev.data);
    if (d.slug === S.slug && ["brief", "instructions", "playbook"].includes(S.view)) {
      const rel = relPath(S.view, S.task); S.flashRel = rel; delete S.docSel[rel];
      if (d.actor === "conductor" && S.docMode[rel] !== "edit") S.docMode[rel] = "diff";
    }
    scheduleRefresh(true);
  });
  es.addEventListener("access", () => { if (S.view === "ais") renderMain(); });
  es.addEventListener("policy", () => { if (S.view === "policies") renderMain(); });
  es.addEventListener("request", (ev) => {
    if (S.view === "gateway") refreshGatewayLive(); else liveRerender();
    if (S.onb?.step >= 2 && !S.onb.connected) { try { if (JSON.parse(ev.data).actor === S.onb.agent) { S.onb.step = 3; checkOnboardingConnection(); } } catch {} }
    scheduleRefresh(false);
  });
  for (const name of ["agent", "message", "log", "queue", "decision", "links", "files", "snapshot", "proposal", "project", "run", "github", "conductor"])
    es.addEventListener(name, () => scheduleRefresh(!["agent", "message", "queue"].includes(name)));
}

// ============================================================================
// Boot
// ============================================================================
(async () => {
  SESSION = await api("/api/session");
  if (SESSION.secure && !SESSION.loggedIn) return showLogin();
  const slot = document.createElement("div"); slot.id = "userSlot"; $("#connectBtn").after(slot);
  renderUserMenu();
  await loadState();
  if (!location.hash && S.slug) history.replaceState(null, "", `#/${S.slug}/overview`);
  await onRoute();
  connectSSE();
  setInterval(() => { if (S.st) { renderStatus(); renderSidebar(); } }, 30000);
})();
