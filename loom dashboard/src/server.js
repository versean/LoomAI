// Loom hub: one process serving
//   /mcp             MCP endpoint (agents)
//   /api/*           REST for the dashboard (the human side: full control)
//   /api/events      live Server-Sent Events
//   /kit/*.md        Claude Code slash-command files (/push, /pull, /handoff)
//   /                the dashboard

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import * as brain from "./store/brain.js";
import * as db from "./store/db.js";
import * as conductor from "./conductor.js";
import * as github from "./github.js";
import { buildServer, renderBriefing, PUSH_PROMPT, HANDOFF_PROMPT, pullPrompt } from "./mcp.js";
import { search } from "./search.js";
import { describeProvider } from "./llm.js";
import { subscribe } from "./bus.js";
import * as auth from "./auth.js";
import * as gateway from "./gateway.js";
import { runWith } from "./context.js";
import * as retrieval from "./retrieval.js";
import * as access from "./access.js";
import * as policy from "./policy.js";
import * as hooks from "./hooks.js";
import { hookTemplate, shScript, ps1Script } from "./installer.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(here, "..");
const PUBLIC = path.join(ROOT, "public");
const PORT = Number(process.env.PORT || 4100);
const PUBLIC_URL = (process.env.HIVEMIND_PUBLIC_URL || "").replace(/\/$/, "") || null;
const STARTED = Date.now();

await brain.init();
policy.seedDefaults();

// --- helpers -----------------------------------------------------------------------
const send = (res, status, body) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
function readRaw(req, limit = 25 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []; let n = 0;
    req.on("data", c => { n += c.length; if (n > limit) { reject(Object.assign(new Error("Body too large"), { status: 413 })); req.destroy(); } else chunks.push(c); });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}
const readJson = async (req) => { const b = await readRaw(req, 5 * 1024 * 1024); return b.length ? JSON.parse(b.toString("utf8")) : {}; };
function projectOr404(res, slug) { const p = brain.getProject(slug); if (!p) send(res, 404, { error: "No such project" }); return p; }

// --- MCP ----------------------------------------------------------------------------
const clientIp = (req) => String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();
const clientByAgent = new Map(); // agent -> MCP client name/version, learned at initialize

async function handleMcp(req, res, url) {
  const agent = auth.agentForMcp(req, url);
  if (!agent) {
    const hadToken = !!(req.headers.authorization || url.searchParams.get("token"));
    gateway.record({ actor: "unknown", actorKind: "unknown", channel: "mcp", action: "session.connect", outcome: "unauthenticated", status: 401,
      reason: hadToken ? "Invalid or revoked agent token" : "No agent token", detail: { ip: clientIp(req) } });
    res.writeHead(401, { "content-type": "application/json", "www-authenticate": 'Bearer realm="hivemind"' });
    return res.end(JSON.stringify({ error: "Missing or invalid agent token. Create one on the dashboard (Connect agent)." }));
  }
  if (req.method !== "POST") { res.writeHead(405, { allow: "POST" }).end("Stateless MCP: POST only"); return; }
  const body = await readJson(req);
  if (body?.method === "initialize") {
    const ci = body.params?.clientInfo;
    const client = ci ? `${ci.name || "client"}${ci.version ? " " + ci.version : ""}`.slice(0, 80) : null;
    if (client) clientByAgent.set(agent, client);
    db.touchAgent(agent);
    gateway.record({ actor: agent, actorKind: "agent", channel: "mcp", client, action: "session.connect", outcome: "allowed", status: 200, detail: { ip: clientIp(req), protocol: body.params?.protocolVersion } });
  }
  const server = buildServer(agent, { client: clientByAgent.get(agent) });
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on("close", () => { transport.close(); server.close(); });
  await server.connect(transport);
  await transport.handleRequest(req, res, body);
}

// --- Claude Code hooks ---------------------------------------------------------------
// Same identity rules as /mcp (agent token, or ?agent= in open mode). Always answer 2xx with a JSON
// decision or an empty body; an unidentified caller gets 401, which Claude Code treats as non-blocking.
const HOOK_EVENTS = new Set(["session-start", "pre-tool-use", "stop", "session-end"]);
async function handleHook(req, res, url) {
  const event = url.pathname.slice("/hooks/".length);
  if (!HOOK_EVENTS.has(event) || req.method !== "POST") return send(res, 404, { error: "Unknown hook" });
  const agent = auth.agentForMcp(req, url);
  if (!agent) {
    gateway.record({ actor: "unknown", actorKind: "unknown", channel: "hook", action: event === "pre-tool-use" ? "tool.use" : "session.start", outcome: "unauthenticated", status: 401, reason: "Hook call without a valid agent token", detail: { ip: clientIp(req) } });
    return send(res, 401, { error: "Missing or invalid agent token" });
  }
  let body = {};
  try { body = await readJson(req); } catch { return send(res, 400, { error: "Invalid JSON" }); }
  const out = await hooks.handle(event, agent, url, body && typeof body === "object" ? body : {});
  if (!out) { res.writeHead(200); return res.end(); }
  return send(res, 200, out);
}

function baseUrl(req) {
  if (PUBLIC_URL) return PUBLIC_URL;
  const proto = req.headers["x-forwarded-proto"] || (req.socket.encrypted ? "https" : "http");
  return `${proto}://${req.headers.host || `localhost:${PORT}`}`;
}

// --- SSE ----------------------------------------------------------------------------
const clients = new Set();
subscribe((event, payload) => { const line = `event: ${event}\ndata: ${JSON.stringify(payload ?? {})}\n\n`; for (const r of clients) r.write(line); });
setInterval(() => { for (const r of clients) r.write(": ping\n\n"); }, 20000);

// --- Snapshot of everything the dashboard needs up top ------------------------------------
async function state(user) {
  const pending = Object.fromEntries(db.pendingProposalCount().map(r => [r.project, r.n]));
  const vis = new Set(visibleSlugs(user));
  const ok = (slug) => !slug || vis.has(slug);
  const projects = brain.listProjects().filter(p => vis.has(p.slug)).map(p => ({
    ...p, playbooks: brain.listPlaybooks(p.slug), decisions: brain.listDecisions(p.slug).length,
    files: brain.listFiles(p.slug).length, links: brain.listLinks(p.slug).length, pendingProposals: pending[p.slug] || 0,
    agents: db.listAgents().filter(a => a.project === p.slug).map(a => a.name), repo: github.repoOf(p.slug),
  }));
  return {
    provider: describeProvider(), conductor: conductor.status(), head: await brain.repo.head(),
    stats: db.runStats(), runs: db.listRuns(12).filter(r => ok(r.project)), projects, agents: db.listAgents(),
    messages: db.listMessages(150).filter(m => ok(m.project)), activity: db.listActivity(150).filter(a => ok(a.refs?.project)),
    queue: db.peekQueue(20).filter(q => ok(q.project)), secure: auth.isSecure(), tokenRequired: auth.isSecure(), publicUrl: PUBLIC_URL,
    gateway: gateway.stats(24, scopeFor(user)), defaultAccess: access.defaultAccess(),
    user, isOwner: isOwner(user), hasAccounts: auth.userCount() > 0,
  };
}

async function projectDetail(slug) {
  const p = brain.getProject(slug);
  return {
    project: p,
    brief: brain.readDoc(slug, "brief"),
    instructions: brain.readDoc(slug, "instructions"),
    playbooks: Object.fromEntries(brain.listPlaybooks(slug).map(t => [t, brain.readDoc(slug, "playbook", t)])),
    decisions: brain.listDecisions(slug), links: brain.listLinks(slug), files: brain.listFiles(slug),
    proposals: db.listProposals(slug).slice(0, 50), github: db.getGithub(slug), repo: github.repoOf(slug),
    log: db.listLog(slug, 60), commits: await brain.projectHistory(slug, 80), snapshots: await brain.listSnapshots(slug),
  };
}

// --- REST ---------------------------------------------------------------------------
// Which gateway action a dashboard mutation is. Reads (GET) aren't logged: the dashboard polls them.
const API_ACTIONS = [
  ["POST", /^\/api\/projects$/, "project.create"],
  ["PATCH", /^\/api\/projects\/([\w-]+)$/, "project.update"],
  ["PUT", /^\/api\/projects\/([\w-]+)\/docs$/, "doc.edit"],
  ["POST", /^\/api\/projects\/([\w-]+)\/decisions$/, "decision.add"],
  ["POST", /^\/api\/projects\/([\w-]+)\/links$/, "link.add"],
  ["DELETE", /^\/api\/projects\/([\w-]+)\/links\/([\w-]+)$/, "link.remove"],
  ["POST", /^\/api\/projects\/([\w-]+)\/files$/, "file.add"],
  ["DELETE", /^\/api\/projects\/([\w-]+)\/files\/(.+)$/, "file.delete"],
  ["POST", /^\/api\/projects\/([\w-]+)\/snapshots$/, "snapshot.create"],
  ["POST", /^\/api\/projects\/([\w-]+)\/restore$/, "snapshot.restore"],
  ["POST", /^\/api\/projects\/([\w-]+)\/github\/sync$/, "github.sync"],
  ["POST", /^\/api\/proposals\/([\w-]+)\/(approve|reject)$/, "proposal.decide"],
  ["POST", /^\/api\/restore-file$/, "file.restore"],
  ["POST", /^\/api\/messages$/, "message.send"],
  ["POST", /^\/api\/push$/, "knowledge.push"],
  ["POST", /^\/api\/tokens$/, "token.create"],
  ["DELETE", /^\/api\/tokens\/([\w-]+)$/, "token.revoke"],
  ["PUT", /^\/api\/projects\/([\w-]+)\/access$/, "access.set"],
  ["POST", /^\/api\/ask$/, "context.query"],
  ["POST", /^\/api\/policies$/, "policy.change"],
  ["PATCH", /^\/api\/policies\/([\w-]+)$/, "policy.change"],
  ["DELETE", /^\/api\/policies\/([\w-]+)$/, "policy.change"],
];
const PROJECT_SCOPED = /^\/api\/projects\/([\w-]+)/;
const recentUnauth = new Map(); // throttle 401 logging from polling dashboards: ip -> last logged ms

// --- Who can see what (people) --------------------------------------------------------------
const isOwner = (u) => !!(u && (u.owner || u.admin || u.open));
const visibleSlugs = (u) => brain.listProjects().map(p => p.slug).filter(s => auth.canSeeProject(u, s));
const actorName = (u) => (u?.email ? u.name : "human");
const scopeFor = (u) => isOwner(u) ? null : { projects: visibleSlugs(u), actors: [...auth.listTokens(u).map(t => t.agent), actorName(u)] };
const notFound = (res) => send(res, 404, { error: "No such project" });

async function handleApi(req, res, url) {
  const p = url.pathname, M = req.method;
  const ip = clientIp(req);

  // Public auth endpoints.
  if (p === "/api/session" && M === "GET") {
    const u = auth.sessionUser(req);
    return send(res, 200, { secure: auth.isSecure(), loggedIn: !!u, user: u, hasAccounts: auth.userCount() > 0, passwordLogin: !!auth.PASSWORD });
  }
  if (p === "/api/signup" && M === "POST") {
    const b = await readJson(req);
    // The first account can be created by anyone (it secures the hub). After that, sign-up is open
    // unless HIVEMIND_SIGNUP=closed, in which case only a signed-in owner can create accounts.
    if (auth.userCount() > 0 && process.env.HIVEMIND_SIGNUP === "closed" && !isOwner(auth.sessionUser(req))) return send(res, 403, { error: "Sign-up is closed on this hub. Ask the owner to invite you." });
    const first = auth.userCount() === 0;
    const u = auth.signup(b);
    gateway.record({ actor: u.name, actorKind: "human", channel: "api", action: "auth.signup", outcome: "allowed", status: 201, detail: { ip, first } });
    db.activity("human", "account", first ? `**${u.name}** created the first account; this hub is now secured` : `**${u.name}** created an account`, { user: u.name });
    res.writeHead(201, { "content-type": "application/json", "set-cookie": auth.sessionCookie(req, u) }); return res.end(JSON.stringify({ user: u, first }));
  }
  if (p === "/api/login" && M === "POST") {
    const b = await readJson(req);
    if (!auth.isSecure()) return send(res, 200, { ok: true });
    const u = auth.login(b);
    if (!u) {
      gateway.record({ actor: "unknown", actorKind: "unknown", channel: "api", action: "auth.login", outcome: "denied", status: 401, reason: b.email ? "Wrong email or password" : "Wrong password", detail: { ip } });
      await new Promise(r => setTimeout(r, 800)); return send(res, 401, { error: b.email ? "Wrong email or password" : "Wrong password" });
    }
    gateway.record({ actor: actorName(u), actorKind: "human", channel: "api", action: "auth.login", outcome: "allowed", status: 200, detail: { ip } });
    res.writeHead(200, { "content-type": "application/json", "set-cookie": auth.sessionCookie(req, u) }); return res.end(JSON.stringify({ ok: true, user: u }));
  }
  if (p === "/api/logout" && M === "POST") { res.writeHead(200, { "content-type": "application/json", "set-cookie": auth.clearCookie }); return res.end("{}"); }

  // Everything else needs a signed-in person.
  const user = auth.sessionUser(req);
  if (!user) {
    const last = recentUnauth.get(ip) || 0;
    if (Date.now() - last > 60000) { recentUnauth.set(ip, Date.now()); gateway.record({ actor: "unknown", actorKind: "unknown", channel: "api", action: M === "GET" ? "api.read" : "api.write", resource: p, outcome: "unauthenticated", status: 401, reason: "No dashboard session", detail: { ip } }); }
    return send(res, 401, { error: "Login required" });
  }

  // Projects you're not a member of don't exist, as far as you can tell.
  const project = p.match(PROJECT_SCOPED)?.[1] || null;
  if (project && brain.getProject(project) && !auth.canSeeProject(user, project)) {
    if (M !== "GET") gateway.record({ actor: actorName(user), actorKind: "human", channel: "api", action: "api.write", project, outcome: "denied", status: 404, reason: "Not a member of this project" });
    return notFound(res);
  }

  // Mutations go through the gateway: authorize, run, record the outcome.
  const route = M !== "GET" && API_ACTIONS.find(([m, re]) => m === M && re.test(p));
  if (!route) return routeApi(req, res, url, user);
  const action = route[2];
  const who = actorName(user);
  const caller = { actor: who, kind: "human", channel: "api", client: "dashboard" };
  const t0 = Date.now();
  const verdict = gateway.authorize(caller, action, project);
  if (!verdict.allowed) {
    gateway.record({ actor: who, actorKind: "human", channel: "api", action, project, outcome: "denied", status: 403, reason: verdict.reason, ms: 0 });
    return send(res, 403, { error: verdict.reason });
  }
  let failure = null;
  try { await routeApi(req, res, url, user); } catch (e) { failure = e; }
  const status = failure ? (failure.status || 500) : res.statusCode;
  const outcome = status < 400 ? "allowed" : status === 403 || status === 404 && /member/i.test(failure?.message || "") ? "denied" : "error";
  const resource = action.startsWith("file.") ? decodeURIComponent(url.searchParams.get("name") || p.match(/\/files\/(.+)$/)?.[1] || "") || null : null;
  gateway.record({ actor: who, actorKind: "human", channel: "api", client: "dashboard", action, project, resource, outcome, status, reason: failure?.message || (status >= 400 ? `HTTP ${status}` : null), ms: Date.now() - t0 });
  if (failure) throw failure;
}

async function routeApi(req, res, url, user) {
  const p = url.pathname, M = req.method;
  let m;
  const can = (slug) => !!slug && !!brain.getProject(slug) && auth.canSeeProject(user, slug);

  if (p === "/api/me" && M === "GET") return send(res, 200, { user, projects: visibleSlugs(user) });

  // Retrieval with sources (same pipeline agents use via the ask / get_source tools).
  if (p === "/api/ask" && M === "POST") {
    const b = await readJson(req);
    if (!String(b.question || "").trim()) return send(res, 400, { error: "question required" });
    if (b.project && !can(b.project)) return notFound(res);
    const projects = b.project ? [b.project] : visibleSlugs(user);
    return send(res, 200, await retrieval.ask(String(b.question), { projects, scope: null, mode: b.mode === "sources" ? "sources" : "answer" }));
  }
  if (p === "/api/source" && M === "GET") {
    const ref = url.searchParams.get("ref");
    const r = retrieval.parseRef(ref);
    if (!r) return send(res, 400, { error: "Invalid ref" });
    if (r.project ? !can(r.project) : r.kind !== "message") return send(res, 404, { error: "No such source" });
    try { return send(res, 200, await retrieval.getSource(ref)); } catch (e) { return send(res, e.status || 500, { error: e.message }); }
  }

  if (p === "/api/requests" && M === "GET") {
    const q = Object.fromEntries(url.searchParams);
    if (q.project && !can(q.project)) return send(res, 200, []);
    return send(res, 200, gateway.list({ ...q, scope: scopeFor(user) }));
  }
  if (p === "/api/requests/stats" && M === "GET") return send(res, 200, gateway.stats(Number(url.searchParams.get("hours")) || 24, scopeFor(user)));

  if (p === "/api/tokens" && M === "GET") return send(res, 200, auth.listTokens(user));
  if (p === "/api/tokens" && M === "POST") {
    const b = await readJson(req);
    if (b.project && !can(b.project)) return notFound(res);
    const t = auth.createToken(b.agent, user.open || user.admin ? null : user.id);
    if (b.project && access.LEVELS.includes(b.access)) access.set(t.agent, brain.getProject(b.project).slug, b.access, "human");
    db.activity("human", "token", `Issued an access token for **${t.agent}**${b.project && b.access ? ` with **${b.access}** access to **${b.project}**` : ""}`, { project: b.project || null });
    return send(res, 201, t);
  }

  // Project members (people). Any member can see the list; owners/project owners manage it.
  if ((m = p.match(/^\/api\/projects\/([\w-]+)\/members(?:\/([\w-]+))?$/))) {
    const slug = m[1]; if (!projectOr404(res, slug)) return;
    const manage = isOwner(user) || auth.memberRole(slug, user.id) === "owner";
    if (M === "GET") return send(res, 200, { members: auth.projectMembers(slug), canManage: manage, legacyOpen: auth.projectMembers(slug).length === 0 });
    if (!manage) return send(res, 403, { error: "Only project owners can manage members" });
    if (M === "POST") {
      const b = await readJson(req);
      const target = auth.findUserByEmail(b.email);
      if (!target) return send(res, 404, { error: "No account with that email. Ask them to sign up first." });
      auth.addMember(slug, target.id, b.role === "owner" ? "owner" : "member");
      db.activity("human", "member", `Added **${target.name}** to **${slug}**`, { project: slug });
      return send(res, 201, { ok: true });
    }
    if (M === "DELETE" && m[2]) { auth.removeMember(slug, m[2]); db.activity("human", "member", `Removed a member from **${slug}**`, { project: slug }); return send(res, 200, {}); }
  }

  // Tool-call policy (what connected CLI agents may do on the user's machine).
  // Global rules are owner-only; members can manage rules scoped to their projects.
  if (p === "/api/policies" && M === "GET") return send(res, 200, { rules: policy.list().filter(r => !r.project || can(r.project)), secure: auth.isSecure(), canEditGlobal: isOwner(user) });
  if (p === "/api/policies" && M === "POST") { const b = await readJson(req);
    if (!b.project && !isOwner(user)) return send(res, 403, { error: "Only the workspace owner can add rules for all projects" });
    if (b.project && !can(b.project)) return notFound(res);
    const id = policy.add(b); db.activity("human", "policy", `Added tool policy **${id}**: ${b.decision} ${b.tools || "*"} matching \`${String(b.pattern).slice(0, 60)}\``); return send(res, 201, { id }); }
  if (p === "/api/policies/test" && M === "POST") { const b = await readJson(req); const tool = b.tool || "Bash"; const input = b.input || (tool === "Bash" || tool === "PowerShell" ? { command: b.text || "" } : { file_path: b.text || "" }); return send(res, 200, { ...policy.evaluate(tool, input, b.project || null), logged: policy.describe(tool, input) }); }
  if ((m = p.match(/^\/api\/policies\/([\w-]+)$/)) && (M === "PATCH" || M === "DELETE")) {
    const rule = policy.list().find(r => r.id === m[1]);
    if (!rule || (rule.project && !can(rule.project))) return send(res, 404, { error: "No such rule" });
    if (!rule.project && !isOwner(user)) return send(res, 403, { error: "Only the workspace owner can change rules for all projects" });
  }
  if ((m = p.match(/^\/api\/policies\/([\w-]+)$/)) && M === "PATCH") { const b = await readJson(req); policy.setEnabled(m[1], !!b.enabled); db.activity("human", "policy", `${b.enabled ? "Enabled" : "Disabled"} tool policy **${m[1]}**`); return send(res, 200, {}); }
  if ((m = p.match(/^\/api\/policies\/([\w-]+)$/)) && M === "DELETE") { policy.remove(m[1]); db.activity("human", "policy", `Removed tool policy **${m[1]}**`); return send(res, 200, {}); }

  if ((m = p.match(/^\/api\/projects\/([\w-]+)\/access$/))) {
    const slug = m[1]; if (!projectOr404(res, slug)) return;
    if (M === "GET") {
      const tokens = auth.listTokens().filter(t => !t.revokedAt);
      const seen = Object.fromEntries(db.listAgents().map(a => [a.name, a]));
      const names = [...new Set([...Object.keys(seen), ...tokens.map(t => t.agent), ...access.knownAgents()])].sort();
      return send(res, 200, {
        default: access.defaultAccess(), levels: access.LEVELS, secure: auth.isSecure(),
        agents: names.map(n => ({ agent: n, access: access.effective(n, slug), explicit: access.explicit(n, slug), lastSeen: seen[n]?.lastSeen || null, hasToken: tokens.some(t => t.agent === n) })),
      });
    }
    if (M === "PUT") {
      const b = await readJson(req);
      const agent = String(b.agent || "").trim().slice(0, 40).replace(/[^\w.@-]/g, "-");
      if (!agent) return send(res, 400, { error: "agent required" });
      if (b.access === null || b.access === "default") access.clear(agent, slug); else access.set(agent, slug, b.access, "human");
      const now = access.effective(agent, slug);
      db.activity("human", "access", `Set **${agent}** to **${now}** on **${slug}**${b.access === null || b.access === "default" ? " (default)" : ""}`, { project: slug });
      return send(res, 200, { agent, access: now, explicit: access.explicit(agent, slug) });
    }
  }
  if ((m = p.match(/^\/api\/tokens\/([\w-]+)$/)) && M === "DELETE") { auth.revokeToken(m[1], user); db.activity("human", "token", "Revoked an agent token"); return send(res, 200, {}); }

  if (p === "/api/events") {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    res.write(": connected\n\n"); clients.add(res); req.on("close", () => clients.delete(res)); return;
  }
  if (p === "/api/state" && M === "GET") return send(res, 200, await state(user));
  if (p === "/api/search" && M === "GET") {
    const hits = await search(url.searchParams.get("q"), url.searchParams.get("project"));
    return send(res, 200, isOwner(user) ? hits : hits.filter(h => !h.project || can(h.project)));
  }
  // Brain paths look like projects/<slug>/...; only members may read or restore them.
  const pathProject = (rel) => String(rel || "").match(/^projects\/([\w-]+)/)?.[1];
  if ((p === "/api/version" || p === "/api/history") && M === "GET" && !can(pathProject(url.searchParams.get("path")))) return send(res, 404, { error: "Not found" });
  if (p === "/api/version" && M === "GET") {
    const content = await brain.versionAt(url.searchParams.get("sha"), url.searchParams.get("path"));
    return content === null ? send(res, 404, { error: "Not found" }) : send(res, 200, { content });
  }
  if (p === "/api/history" && M === "GET") return send(res, 200, await brain.history(url.searchParams.get("path"), 100));
  if (p === "/api/restore-file" && M === "POST") { const b = await readJson(req); if (!can(pathProject(b.path))) return send(res, 404, { error: "Not found" }); const sha = await brain.restoreFile(b.path, b.ref, "human"); db.activity("human", "restore", `Restored \`${b.path.split("/").slice(2).join("/")}\` to \`${b.ref.slice(0, 7)}\``, { project: b.path.split("/")[1], sha }); return send(res, 200, { sha }); }

  if (p === "/api/projects" && M === "POST") {
    const b = await readJson(req); if (!b.name) return send(res, 400, { error: "name required" });
    if (brain.getProject(b.name) && !can(brain.slugify(b.name))) return send(res, 409, { error: "That project name is taken" });
    const proj = await brain.createProject({ name: b.name, description: b.description || "", actor: "human" });
    if (user.email && !auth.memberRole(proj.slug, user.id)) auth.addMember(proj.slug, user.id, "owner"); // creator owns it
    if (b.repo) await brain.addLinks(proj.slug, [{ label: "Repository", url: b.repo, kind: "repo" }], "human");
    db.activity("human", "project", `Created project **${proj.name}**`, { project: proj.slug });
    if (b.repo) github.sync(proj.slug).catch(() => {});
    return send(res, 201, proj);
  }

  if ((m = p.match(/^\/api\/projects\/([\w-]+)$/)) && M === "GET") { if (!projectOr404(res, m[1])) return; return send(res, 200, await projectDetail(m[1])); }
  if ((m = p.match(/^\/api\/projects\/([\w-]+)$/)) && M === "PATCH") { const b = await readJson(req); await brain.updateProjectMeta(m[1], { name: b.name, description: b.description }, "human"); return send(res, 200, {}); }

  if ((m = p.match(/^\/api\/projects\/([\w-]+)\/briefing$/)) && M === "GET") { if (!projectOr404(res, m[1])) return; return send(res, 200, { markdown: renderBriefing(m[1], url.searchParams.get("task") || null, null) }); }

  if ((m = p.match(/^\/api\/projects\/([\w-]+)\/docs$/)) && M === "PUT") {
    const b = await readJson(req);
    const r = await brain.writeDoc(m[1], b.kind, { task: b.task, content: b.content, actor: "human", message: b.message || `Edit ${b.kind === "playbook" ? `playbook ${b.task}` : b.kind} (dashboard)` });
    db.activity("human", "edit", `Edited **${b.kind === "playbook" ? `playbook ${b.task}` : b.kind}**${r.sha ? ` \`${r.sha.slice(0, 7)}\`` : " (no change)"}`, { project: m[1], sha: r.sha });
    return send(res, 200, r);
  }

  if ((m = p.match(/^\/api\/projects\/([\w-]+)\/decisions$/)) && M === "POST") {
    const b = await readJson(req); const d = await brain.addDecision(m[1], { title: b.title, body: b.body, supersedes: b.supersedes || null, actor: "human" });
    db.activity("human", "decision", `Recorded **${d.id}**: ${b.title}`, { project: m[1], sha: d.sha }); return send(res, 201, d);
  }

  if ((m = p.match(/^\/api\/projects\/([\w-]+)\/links$/)) && M === "POST") {
    const b = await readJson(req); const added = await brain.addLinks(m[1], [b], "human");
    if (added.length) db.activity("human", "link", `Added link **${added[0].label}**`, { project: m[1] });
    if (b.kind === "repo") github.sync(m[1]).catch(() => {});
    return send(res, 201, added);
  }
  if ((m = p.match(/^\/api\/projects\/([\w-]+)\/links\/([\w-]+)$/)) && M === "DELETE") { await brain.removeLink(m[1], m[2], "human"); return send(res, 200, {}); }

  if ((m = p.match(/^\/api\/projects\/([\w-]+)\/files$/)) && M === "POST") {
    const buf = await readRaw(req); const f = await brain.addFile(m[1], url.searchParams.get("name") || "upload", buf, "human");
    db.activity("human", "file", `Attached \`${f.name}\``, { project: m[1], sha: f.sha }); return send(res, 201, f);
  }
  if ((m = p.match(/^\/api\/projects\/([\w-]+)\/files\/(.+)$/))) {
    const name = decodeURIComponent(m[2]);
    if (M === "GET") { const buf = brain.readFile(m[1], name); if (!buf) return send(res, 404, { error: "No such file" }); res.writeHead(200, { "content-type": buf.includes(0) ? "application/octet-stream" : "text/plain; charset=utf-8" }); return res.end(buf); }
    if (M === "DELETE") { await brain.deleteFile(m[1], name, "human"); db.activity("human", "file", `Removed \`${name}\` (still in history)`, { project: m[1] }); return send(res, 200, {}); }
  }

  if ((m = p.match(/^\/api\/projects\/([\w-]+)\/snapshots$/)) && M === "POST") {
    const b = await readJson(req); const name = await brain.snapshot(m[1], b.label || "manual", "human");
    db.activity("human", "snapshot", `Snapshot \`${name}\``, { project: m[1] }); return send(res, 201, { name });
  }
  if ((m = p.match(/^\/api\/projects\/([\w-]+)\/restore$/)) && M === "POST") {
    const b = await readJson(req); const sha = await brain.restoreSnapshot(m[1], b.tag, "human");
    db.activity("human", "restore", `Restored project to \`${b.tag}\``, { project: m[1], sha }); return send(res, 200, { sha });
  }

  if ((m = p.match(/^\/api\/projects\/([\w-]+)\/github\/sync$/)) && M === "POST") {
    try { return send(res, 200, await github.sync(m[1])); } catch (e) { return send(res, 502, { error: e.message }); }
  }

  if ((m = p.match(/^\/api\/proposals\/([\w-]+)\/(approve|reject)$/)) && M === "POST") {
    const pr = db.getProposal(m[1]); if (!pr || pr.status !== "pending" || !can(pr.project)) return send(res, 404, { error: "No pending proposal" });
    if (m[2] === "reject") { db.decideProposal(pr.id, "rejected"); db.activity("human", "proposal", `Rejected proposal **${pr.heading}**`, { project: pr.project }); return send(res, 200, {}); }
    const r = await brain.editDoc(pr.project, "instructions", { edits: [pr], actor: "human", message: `Approve conductor proposal: ${pr.op} "${pr.heading}"` });
    db.decideProposal(pr.id, "approved", r.sha);
    db.activity("human", "proposal", `Approved proposal **${pr.heading}** \`${r.sha?.slice(0, 7)}\``, { project: pr.project, sha: r.sha });
    return send(res, 200, r);
  }

  if (p === "/api/messages" && M === "POST") {
    const b = await readJson(req); if (!b.to || !b.text) return send(res, 400, { error: "to and text required" });
    if (b.project && !can(b.project)) return notFound(res);
    db.addMessage({ from: "human", to: b.to, text: b.text, project: b.project || null });
    db.activity("human", "message", `**${actorName(user)}** → **${b.to}**: ${b.text}`, { project: b.project }); return send(res, 201, {});
  }
  if (p === "/api/push" && M === "POST") {
    const b = await readJson(req); if (!b.summary) return send(res, 400, { error: "summary required" });
    if (b.project && !can(b.project)) return notFound(res);
    const e = db.addLog({ kind: "push", project: b.project || null, agent: "human", task: b.task ? brain.slugify(b.task) : null, payload: { summary: b.summary, notes: b.notes } });
    db.activity("human", "push", `**human** pushed: ${b.summary}`, { project: b.project, log: e.id }); return send(res, 201, e);
  }

  return send(res, 404, { error: "Not found" });
}

// --- Static, vendor, kit ---------------------------------------------------------------
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".md": "text/markdown; charset=utf-8" };
const VENDOR = { "marked.js": "node_modules/marked/lib/marked.esm.js", "purify.js": "node_modules/dompurify/dist/purify.es.mjs" };
const KIT = {
  "push.md": () => `---\ndescription: Push your recent work to the Loom team brain\n---\n${PUSH_PROMPT}\n\n$ARGUMENTS\n`,
  "pull.md": () => `---\ndescription: Load your Loom briefing for a task (usage: /pull <task> [project])\nargument-hint: <task> [project]\n---\n${pullPrompt("$1", "$2").replace(" on project **$2**", " (project: $2, if given)")}\n`,
  "handoff.md": () => `---\ndescription: Save a handoff recap to Loom\n---\n${HANDOFF_PROMPT}\n`,
};

function serveFile(res, file) {
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404).end("Not found"); return; }
  res.writeHead(200, { "content-type": TYPES[path.extname(file)] || "application/octet-stream", "cache-control": "no-cache" });
  fs.createReadStream(file).pipe(res);
}

// --- Boot ------------------------------------------------------------------------------
const server = http.createServer((req, res) => {
  // Dashboard requests run with the signed-in person in context (git authorship, activity names).
  const user = req.url.startsWith("/api/") ? auth.sessionUser(req) : null;
  return runWith({ user }, () => route(req, res));
});

async function route(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  try {
    if (url.pathname === "/health") return send(res, 200, { ok: true, uptimeSec: Math.round((Date.now() - STARTED) / 1000), queue: db.queueLength(), conductor: conductor.status() });
    if (url.pathname === "/mcp") return await handleMcp(req, res, url);
    if (url.pathname.startsWith("/hooks/")) return await handleHook(req, res, url);
    if (url.pathname === "/install/claude-code.sh") { res.writeHead(200, { "content-type": "text/x-shellscript; charset=utf-8" }); return res.end(shScript(baseUrl(req), auth.isSecure())); }
    if (url.pathname === "/install/claude-code.ps1") { res.writeHead(200, { "content-type": "text/plain; charset=utf-8" }); return res.end(ps1Script(baseUrl(req), auth.isSecure())); }
    if (url.pathname === "/install/claude-code-hooks.json") {
      const project = url.searchParams.get("project"), agent = url.searchParams.get("agent");
      return send(res, 200, hookTemplate(baseUrl(req), { project: project && brain.getProject(project) ? brain.getProject(project).slug : null, agent: agent ? agent.replace(/[^\w.@-]/g, "-").slice(0, 40) : null, strict: url.searchParams.get("strict") === "1", secure: auth.isSecure(), windows: url.searchParams.get("os") === "windows" }));
    }
    if (url.pathname.startsWith("/api/")) return await handleApi(req, res, url);
    if (url.pathname.startsWith("/vendor/")) { const f = VENDOR[url.pathname.slice(8)]; return f ? serveFile(res, path.join(ROOT, f)) : res.writeHead(404).end(); }
    if (url.pathname.startsWith("/kit/")) { const k = KIT[url.pathname.slice(5)]; if (!k) return res.writeHead(404).end(); res.writeHead(200, { "content-type": TYPES[".md"] }); return res.end(k()); }
    const rel = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
    const file = path.normalize(path.join(PUBLIC, rel));
    if (!file.startsWith(PUBLIC)) return res.writeHead(403).end();
    return serveFile(res, file);
  } catch (e) {
    if (!(e instanceof brain.PermissionError)) console.error(e);
    if (!res.headersSent) send(res, e.status || 500, { error: e.message });
  }
}

server.listen(PORT, () => {
  console.log(`\n  LOOM AI hub`);
  const base = PUBLIC_URL || `http://localhost:${PORT}`;
  console.log(`  dashboard  ${base}`);
  console.log(`  mcp        ${base}/mcp${auth.isSecure() ? "   (agent tokens required)" : "?agent=<name>   (OPEN MODE: create an account on the dashboard before exposing this publicly)"}`);
  console.log(`  conductor  ${describeProvider()}`);
  console.log(`  data       ${process.env.HIVEMIND_DATA_DIR || "./data"}\n`);
  conductor.start();
  github.startPolling();
});
