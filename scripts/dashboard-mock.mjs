// Local preview only. Fakes the Loom AI backend's dashboard API with sample data so the
// dashboard in packages/server/src/loom_server/static can be tried without Postgres. The real backend serves the same files.
// Run: node scripts/dashboard-mock.mjs   then open http://localhost:4300/#login=demo
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const PORT = +(process.env.PORT || 4300);
const STATIC = fileURLToPath(new URL("../packages/server/src/loom_server/static/", import.meta.url));
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".svg": "image/svg+xml" };
const TOKEN = "dev_dashboard_token";

const now = () => new Date();
const minsAgo = (m) => new Date(Date.now() - m * 60000).toISOString();
let auditId = 1000;

const members = [
  { id: "u1", name: "Alex Kim", email: "alex@team.dev", is_admin: true, projects: [{ slug: "hackathon-site", role: "owner" }, { slug: "api", role: "owner" }] },
  { id: "u2", name: "Sara Diaz", email: "sara@team.dev", is_admin: false, projects: [{ slug: "hackathon-site", role: "member" }, { slug: "api", role: "member" }] },
  { id: "u3", name: "Priya Shah", email: "priya@team.dev", is_admin: false, projects: [{ slug: "hackathon-site", role: "member" }] },
  { id: "u4", name: "Intern", email: "intern@team.dev", is_admin: false, projects: [{ slug: "hackathon-site", role: "viewer" }] },
];
const devices = [
  { id: "d1", user_id: "u1", name: "alex-mbp", agents: ["claude-code", "cursor"], online: true, revoked_at: null, last_seen_at: minsAgo(1) },
  { id: "d2", user_id: "u2", name: "sara-mbp", agents: ["claude-ai", "claude-code"], online: true, revoked_at: null, last_seen_at: minsAgo(2) },
  { id: "d3", user_id: "u3", name: "priya-thinkpad", agents: ["cursor"], online: false, revoked_at: null, last_seen_at: minsAgo(95) },
  { id: "d4", user_id: "u4", name: "lab-03", agents: ["claude-code"], online: false, revoked_at: null, last_seen_at: minsAgo(18) },
  { id: "d5", user_id: "u1", name: "Dashboard", agents: [], online: true, revoked_at: null, last_seen_at: minsAgo(0) },
];
const projects = [
  { slug: "hackathon-site", name: "Hackathon Site", description: "Landing page and waitlist signup. Next.js frontend, FastAPI backend, Postgres.", my_role: "owner", members: 4, documents: 6, chunks: 41 },
  { slug: "api", name: "API", description: "The public REST API and its rate limiting.", my_role: "owner", members: 2, documents: 3, chunks: 19 },
];
const files = {
  "hackathon-site": [
    ["README.md", "file", "# Hackathon Site\n\nLanding page and waitlist signup.\n\n## Stack\n- Next.js 15 frontend\n- FastAPI backend\n- Postgres 17\n\n## Run\n```\nnpm run dev\n```\n"],
    ["src/api/client.ts", "file", "export async function request(path: string) {\n  for (let attempt = 0; attempt < 4; attempt++) {\n    const res = await fetch(path);\n    if (res.status !== 429) return res;\n    await sleep(2 ** attempt * 250); // exponential backoff\n  }\n  throw new Error(\"rate limited\");\n}\n"],
    ["src/app/page.tsx", "file", "export default function Page() {\n  return <main className=\"hero\">One brain for all your AI agents</main>;\n}\n"],
    ["docs/style-guide.md", "file", "# Style guide\n\n- Brand blue: **#2A45E8**\n- Headlines: Instrument Serif\n- Body: Inter\n"],
    ["notes/we-chose-pgvector.md", "note", "# We chose pgvector\n\n_Saved by Alex Kim_\n\nOne database for rows and vectors; no extra service to run."],
    ["notes/retry-429s.md", "note", "# Retry 429s with backoff\n\n_Saved by Sara Diaz_\n\nRetry up to 4 times: 250 ms, 500 ms, 1 s, 2 s."],
  ],
  api: [
    ["README.md", "file", "# API\n\nREST API for the waitlist.\n"],
    ["app/limits.py", "file", "RATE_LIMIT = \"60/minute\"\n"],
    ["docs/decisions.md", "file", "# Decisions\n\n1. Rate limit per token, 60 requests a minute.\n"],
  ],
};
const briefs = {
  "hackathon-site": "# Hackathon Site\n\nA landing page with a waitlist signup, built for the hackathon demo.\n\n## What's here\n- **Frontend:** Next.js 15 in `src/app`\n- **API client:** `src/api/client.ts` retries 429s with exponential backoff\n- **Style guide:** brand blue `#2A45E8`, Instrument Serif headlines\n\n## Decisions the team saved\n- We chose pgvector: one database for rows and vectors.\n- Retry 429s up to 4 times with backoff.\n\n## Who's on it\nAlex (owner), Sara and Priya (members), Intern (viewer).",
  api: "# API\n\nThe public REST API. Rate limited per token at 60 requests a minute (`app/limits.py`).",
};
const inbox = [
  { id: "i1", kind: "skill", filename: "deploy-checklist/SKILL.md", install_path: null, note: "The checklist I use before every deploy.", project: "hackathon-site", from: "Priya Shah", from_email: "priya@team.dev", size_bytes: 1840, created_at: minsAgo(12), status: "new", content: "# Deploy checklist\n\n1. Run tests\n2. Check migrations" },
  { id: "i2", kind: "message", filename: "message.txt", install_path: null, note: "", project: "hackathon-site", from: "Sara Diaz", from_email: "sara@team.dev", size_bytes: 64, created_at: minsAgo(40), status: "new", content: "The new blue is in the style guide now: **#2A45E8**." },
  { id: "i3", kind: "file", filename: "signup-api-spec.md", install_path: null, note: "", project: "api", from: "Sara Diaz", from_email: "sara@team.dev", size_bytes: 3120, created_at: minsAgo(300), status: "accepted", content: "# Signup API" },
];
const ev = (m, user, device, client, action, decision, detail = {}, project = "hackathon-site", reason = null, latency = 40) =>
  ({ id: ++auditId, at: minsAgo(m), user, device, client, action, decision, reason, latency_ms: latency, detail, project });
const audit = [
  ev(240, "Alex Kim", "alex-mbp", "loom-cli", "ingest.upload", "allow", { files: 6, indexed: 6 }, "hackathon-site", null, 2140),
  ev(180, "Alex Kim", "alex-mbp", "loom-cli", "invite.create", "allow", { role: "member" }),
  ev(170, "Priya Shah", null, null, "team.join", "allow", { email: "priya@team.dev" }, null),
  ev(120, "Priya Shah", "priya-thinkpad", "cursor", "delivery.send", "allow", { to: "Alex Kim", filename: "deploy-checklist/SKILL.md", kind: "skill" }, "hackathon-site", null, 88),
  ev(64, "Intern", "lab-03", "claude-code", "note.save", "deny", { title: "Change brand blue" }, "hackathon-site", "Role 'viewer' cannot add knowledge to 'hackathon-site'", 6),
  ev(40, "Sara Diaz", "sara-mbp", "claude-ai", "delivery.send", "allow", { to: "Alex Kim", filename: "message.txt", kind: "message" }, "hackathon-site", null, 51),
  ev(22, "Alex Kim", "alex-mbp", "cursor", "agent.share_blocked", "deny", { to: "Sara Diaz", filename: ".env" }, "hackathon-site", "Credential files (.env, keys, certificates) can never be sent", 3),
  ev(14, "Sara Diaz", "sara-mbp", "claude-code", "note.save", "allow", { title: "Retry 429s with backoff", path: "notes/retry-429s.md" }, "hackathon-site", null, 312),
  ev(6, "Alex Kim", "alex-mbp", "claude-code", "knowledge.ask", "allow", { question: "How do we retry rate limits?", sources: ["src/api/client.ts", "notes/retry-429s.md"] }, "hackathon-site", null, 184),
  ev(3, "Priya Shah", "priya-thinkpad", "cursor", "agent.prompt_blocked", "deny", {}, "hackathon-site", "Prompt contained an AWS secret key", 2),
];

// ── WebSocket (server-to-client text frames only) ────────────────────────────
const sockets = new Set();
function wsSend(sock, obj) {
  const data = Buffer.from(JSON.stringify(obj));
  const head = data.length < 126 ? Buffer.from([0x81, data.length]) : Buffer.from([0x81, 126, data.length >> 8, data.length & 255]);
  try { sock.write(Buffer.concat([head, data])); } catch { sockets.delete(sock); }
}
function broadcastAudit(e) { audit.push(e); for (const s of sockets) wsSend(s, { type: "audit", event: e }); }
const LIVE = [
  () => ({ user: "Sara Diaz", device: "sara-mbp", client: "claude-ai", action: "knowledge.ask", decision: "allow", detail: { question: "What blue do we use now?", sources: ["docs/style-guide.md"] }, latency_ms: 172 }),
  () => ({ user: "Priya Shah", device: "priya-thinkpad", client: "cursor", action: "knowledge.search", decision: "allow", detail: { query: "signup form validation" }, latency_ms: 64 }),
  () => ({ user: "Intern", device: "lab-03", client: "claude-code", action: "delivery.send", decision: "deny", reason: "Role 'viewer' cannot send files from this project", detail: { to: "Alex Kim", filename: "notes.md" }, latency_ms: 5 }),
  () => ({ user: "Alex Kim", device: "alex-mbp", client: "claude-code", action: "file.read", decision: "allow", detail: { path: "src/api/client.ts" }, latency_ms: 21 }),
];
let liveI = 0;
setInterval(() => {
  if (!sockets.size) return;
  const e = { id: ++auditId, at: now().toISOString(), project: "hackathon-site", reason: null, ...LIVE[liveI++ % LIVE.length]() };
  broadcastAudit(e);
}, 9000);

// ── HTTP ─────────────────────────────────────────────────────────────────────
const send = (res, code, body) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); };
const deny = (res, reason, code = 403) => send(res, code, { reason });
async function bodyOf(req) { let s = ""; for await (const c of req) s += c; try { return JSON.parse(s || "{}"); } catch { return {}; } }
function series(match) {
  const buckets = Array(24).fill(0);
  for (const e of audit) { const h = Math.min(23, Math.floor((Date.now() - new Date(e.at)) / 3600000)); if (match(e)) buckets[23 - h]++; }
  return { total: buckets.reduce((a, b) => a + b, 0), series: buckets };
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;
  if (!p.startsWith("/api/")) {
    const file = normalize(join(STATIC, p === "/" ? "index.html" : p));
    if (!file.startsWith(normalize(STATIC))) return deny(res, "nope", 404);
    try { const data = await readFile(file); res.writeHead(200, { "Content-Type": TYPES[extname(file)] || "application/octet-stream", "Cache-Control": "no-store" }); return res.end(data); }
    catch { return deny(res, "Not found", 404); }
  }
  if (p === "/api/dashboard/session" && req.method === "POST") return send(res, 200, { token: TOKEN });
  if (req.headers.authorization !== `Bearer ${TOKEN}`) return deny(res, "Unknown or revoked token", 401);
  const providers = { status: "ok", embedder: "bedrock:cohere.embed-multilingual-v3", reranker: "bedrock:cohere.rerank-v3-5", llm: "bedrock:claude-sonnet" };
  const fam = () => ({ team: "Momentis", me: "Alex Kim", is_admin: true, providers, projects,
    members: members.map((m) => ({ ...m, devices: devices.filter((d) => d.user_id === m.id) })) });
  let m;
  if (p === "/api/team") return send(res, 200, fam());
  if (p === "/api/me") return send(res, 200, { user: "Alex Kim", email: "alex@team.dev", is_admin: true, team: "Momentis", device: "Dashboard", scopes: ["read"], projects, inbox_waiting: inbox.filter((i) => i.status === "new").length, providers });
  if (p === "/api/stats") return send(res, 200, {
    questions: series((e) => /^knowledge\./.test(e.action) && e.decision === "allow"),
    delivered: series((e) => e.action === "delivery.send" && e.decision === "allow"),
    stopped: series((e) => e.decision === "deny"), agents: 6 });
  if (p === "/api/audit") return send(res, 200, audit.slice(-(+url.searchParams.get("limit") || 50)));
  if (p === "/api/inbox") return send(res, 200, inbox.filter((i) => url.searchParams.get("all") === "true" || i.status === "new").map(({ content, ...i }) => i));
  if ((m = p.match(/^\/api\/inbox\/([\w-]+)\/(accept|decline)$/))) {
    const item = inbox.find((i) => i.id === m[1]);
    if (!item) return deny(res, "No such item in your inbox", 404);
    item.status = m[2] === "accept" ? "accepted" : "declined";
    broadcastAudit({ id: ++auditId, at: now().toISOString(), user: "Alex Kim", device: "Dashboard", client: "dashboard", action: `delivery.${m[2]}`, decision: "allow", reason: null, latency_ms: 12, detail: { filename: item.filename, sender: item.from }, project: item.project });
    return send(res, 200, item);
  }
  if ((m = p.match(/^\/api\/devices\/([\w-]+)\/revoke$/))) {
    const d = devices.find((x) => x.id === m[1]);
    if (!d) return deny(res, "No such device", 404);
    d.revoked_at = now().toISOString(); d.online = false;
    broadcastAudit({ id: ++auditId, at: now().toISOString(), user: "Alex Kim", device: "Dashboard", client: "dashboard", action: "device.revoke", decision: "allow", reason: null, latency_ms: 9, detail: { device: d.id }, project: null });
    return send(res, 200, { revoked: d.name, user: "x" });
  }
  if (p === "/api/invites" && req.method === "POST") { const b = await bodyOf(req); return send(res, 200, { code: `inv_${randomUUID().slice(0, 12)}`, expires_in_days: 7, max_uses: b.max_uses || 20 }); }
  if (p === "/api/invites/cancel") return send(res, 200, { cancelled: true, used_by: 0 });
  if ((m = p.match(/^\/api\/projects\/([\w-]+)\/(brief|files|file|notes)$/))) {
    const slug = m[1];
    if (!files[slug]) return deny(res, `No project '${slug}' in this team`, 404);
    if (m[2] === "brief") return send(res, 200, { project: slug, brief: briefs[slug] });
    if (m[2] === "files") return send(res, 200, { project: slug, files: files[slug].map(([path, kind, c], i) => ({ path, kind, size_bytes: c.length, updated_at: minsAgo(30 + i * 50) })) });
    if (m[2] === "file") { const f = files[slug].find(([path]) => path === url.searchParams.get("path")); return f ? send(res, 200, { project: slug, path: f[0], content: f[2], updated_at: minsAgo(30) }) : deny(res, "No such file", 404); }
    if (m[2] === "notes") {
      const b = await bodyOf(req);
      if (/AKIA[0-9A-Z]{16}|sk-[a-zA-Z0-9]{20,}/.test(b.content || "")) return deny(res, "Note not saved, it contains secrets: AWS access key");
      const path = `notes/${String(b.title).toLowerCase().replace(/[^a-z0-9]+/g, "-")}.md`;
      files[slug].push([path, "note", `# ${b.title}\n\n_Saved by Alex Kim_\n\n${b.content}`]);
      projects.find((x) => x.slug === slug).documents++;
      broadcastAudit({ id: ++auditId, at: now().toISOString(), user: "Alex Kim", device: "Dashboard", client: "dashboard", action: "note.save", decision: "allow", reason: null, latency_ms: 240, detail: { title: b.title, path }, project: slug });
      return send(res, 200, { path, project: slug, chunks: 1 });
    }
  }
  if (p === "/api/ask") {
    const b = await bodyOf(req);
    await new Promise((r) => setTimeout(r, 700));
    if (/capital|weather|france/i.test(b.query)) return send(res, 200, { answer: "Not in project knowledge.", grounded: false, citations: [], top_score: 0.08, threshold: 0.3, reranker: "bedrock:cohere.rerank-v3-5", standalone_query: b.query, needs_clarification: false });
    return send(res, 200, {
      answer: "Retry a 429 up to four times with exponential backoff: 250 ms, 500 ms, 1 s, then 2 s [1]. The team saved this as a decision [2], and the API allows 60 requests a minute per token [3].",
      grounded: true, standalone_query: b.query, needs_clarification: false, top_score: 0.874, threshold: 0.3, reranker: "bedrock:cohere.rerank-v3-5",
      citations: [
        { n: 1, project: "hackathon-site", path: "src/api/client.ts", lines: "1-8", section: null, score: 0.874 },
        { n: 2, project: "hackathon-site", path: "notes/retry-429s.md", lines: "1-5", section: "Retry 429s with backoff", score: 0.812 },
        { n: 3, project: "api", path: "app/limits.py", lines: "1-1", section: null, score: 0.455 },
      ],
    });
  }
  return deny(res, `Mock has no ${req.method} ${p}`, 404);
});

server.on("upgrade", (req, sock) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname !== "/api/ws") return sock.destroy();
  const accept = createHash("sha1").update(req.headers["sec-websocket-key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
  sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  if (url.searchParams.get("token") !== TOKEN) { sock.end(Buffer.from([0x88, 2, 0x11, 0x31])); return; } // close 4401
  sockets.add(sock);
  wsSend(sock, { type: "hello", user: "Alex Kim", device: "Dashboard" });
  sock.on("data", (buf) => { if ((buf[0] & 0x0f) === 8) { sockets.delete(sock); sock.end(); } });
  sock.on("close", () => sockets.delete(sock));
  sock.on("error", () => sockets.delete(sock));
});
server.listen(PORT, () => console.log(`Mock Loom backend on http://localhost:${PORT}/#login=demo`));
