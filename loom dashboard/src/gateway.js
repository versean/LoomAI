// The Gateway: the single control point every managed request passes through.
//
//   identify  -> who is asking (agent token / human session / overseer / unknown)
//   authorize -> may this caller do this action on this project?   (server-side, never a prompt)
//   route     -> run the handler
//   record    -> one row per request: actor, action, project, resource, outcome, reason, latency
//
// Outcomes: allowed (succeeded) · denied (permission) · unauthenticated (no/invalid identity) · error (failed).
// Records never contain message/file/doc CONTENT, only safe metadata (names, sizes, recipients).

import { randomUUID } from "node:crypto";
import { sql, activity } from "./store/db.js";
import * as access from "./access.js";
import * as brain from "./store/brain.js";
import { emit } from "./bus.js";

sql.exec(`
  CREATE TABLE IF NOT EXISTS requests (
    seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT, at TEXT,
    actor TEXT, actorKind TEXT, channel TEXT, client TEXT,
    action TEXT, access TEXT, project TEXT, resource TEXT,
    outcome TEXT, status INTEGER, reason TEXT, ms INTEGER, detail TEXT
  );
  CREATE INDEX IF NOT EXISTS requests_at ON requests(at);
  CREATE INDEX IF NOT EXISTS requests_outcome ON requests(outcome);
`);

// What each action needs. access: none | read | write | message | admin (human-only).
export const ACTIONS = {
  // Agent (MCP) actions
  "session.connect": { access: "none", label: "Connected" },
  "hub.overview":    { access: "read", label: "Listed projects" },
  "context.pull":    { access: "read", label: "Pulled project context" },
  "knowledge.push":  { access: "write", label: "Pushed an update" },
  "conversation.save": { access: "write", label: "Saved a conversation recap" },
  "message.send":    { access: "message", label: "Sent a message" },
  "message.read":    { access: "message", label: "Read messages" },
  "file.read":       { access: "read", label: "Read a file" },
  "file.add":        { access: "write", label: "Uploaded a file" },
  "search":          { access: "read", label: "Searched" },
  "history.read":    { access: "read", label: "Read doc history" },
  "overseer.ask":    { access: "read", label: "Asked the Overseer" },
  "context.query":   { access: "read", label: "Asked the brain" },
  "source.fetch":    { access: "read", label: "Fetched an original source" },
  "project.create":  { access: "write", label: "Created a project" },
  "prompt.get":      { access: "none", label: "Loaded a slash command" },
  // Human (dashboard) actions
  "auth.login":      { access: "none", label: "Logged in" },
  "doc.edit":        { access: "write", label: "Edited a doc" },
  "decision.add":    { access: "write", label: "Recorded a decision" },
  "link.add":        { access: "write", label: "Added a link" },
  "link.remove":     { access: "admin", label: "Removed a link" },
  "file.delete":     { access: "admin", label: "Removed a file" },
  "file.restore":    { access: "admin", label: "Restored a file version" },
  "snapshot.create": { access: "write", label: "Took a snapshot" },
  "snapshot.restore":{ access: "admin", label: "Restored a snapshot" },
  "proposal.decide": { access: "admin", label: "Decided a proposal" },
  "project.update":  { access: "admin", label: "Updated project details" },
  "github.sync":     { access: "read", label: "Synced GitHub" },
  "token.create":    { access: "admin", label: "Issued an agent token" },
  "token.revoke":    { access: "admin", label: "Revoked an agent token" },
  "access.set":      { access: "admin", label: "Changed agent access" },
  // Overseer
  "overseer.update": { access: "write", label: "Updated project knowledge" },
  // Claude Code hooks
  "session.start":   { access: "read", label: "Started a session" },
  "tool.use":        { access: "none", label: "Tool call checked" },
  "session.nudge":   { access: "none", label: "Reminded to push" },
  "session.end":     { access: "none", label: "Ended a session" },
  "policy.change":   { access: "admin", label: "Changed tool policy" },
};

export class Denied extends Error {
  constructor(reason, status = 403) { super(reason); this.name = "Denied"; this.status = status; }
}

// ---------------------------------------------------------------------------------
// Authorization. Every rule here is enforced in code, outside any AI prompt.
// Per-agent project permissions plug in at projectAccess().
// ---------------------------------------------------------------------------------
const RANK = { none: 0, read: 1, message: 1, write: 2, admin: 3 };

function projectAccess(caller, project) {
  if (caller.kind === "human") return "admin";
  if (caller.kind === "overseer") return "write";
  if (caller.kind === "agent") return access.effective(caller.actor, project);
  return "none";
}

export function authorize(caller, action, project) {
  const spec = ACTIONS[action];
  if (!spec) return { allowed: false, reason: `Unknown action "${action}"` };
  if (spec.access === "none") return { allowed: true };
  if (spec.access === "admin" && caller.kind !== "human") return { allowed: false, reason: "Only a human on the dashboard can do this" };
  if (!project) return { allowed: true }; // non-project actions; their handlers filter results by access
  // Creating a project that doesn't exist yet is allowed; the creator gets write on it.
  if (action === "project.create" && !brain.getProject(project)) return { allowed: true };
  const have = projectAccess(caller, project);
  const need = spec.access === "message" ? "read" : spec.access;
  if (RANK[have] < RANK[need]) {
    return { allowed: false, reason: have === "none" ? `${caller.actor} has no access to project ${project}` : `${caller.actor} has ${have}-only access to project ${project}` };
  }
  return { allowed: true };
}

// ---------------------------------------------------------------------------------
// Recording
// ---------------------------------------------------------------------------------
export function record(entry) {
  const r = {
    id: randomUUID(), at: new Date().toISOString(),
    actor: entry.actor || "unknown", actorKind: entry.actorKind || "unknown", channel: entry.channel || "internal", client: entry.client || null,
    action: entry.action, access: ACTIONS[entry.action]?.access || null,
    project: entry.project || null, resource: entry.resource ? String(entry.resource).slice(0, 160) : null,
    outcome: entry.outcome, status: entry.status ?? null, reason: entry.reason ? String(entry.reason).slice(0, 300) : null,
    ms: entry.ms ?? null, detail: entry.detail ? JSON.stringify(entry.detail).slice(0, 1000) : null,
  };
  sql.prepare(`INSERT INTO requests (id, at, actor, actorKind, channel, client, action, access, project, resource, outcome, status, reason, ms, detail)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(r.id, r.at, r.actor, r.actorKind, r.channel, r.client, r.action, r.access, r.project, r.resource, r.outcome, r.status, r.reason, r.ms, r.detail);
  emit("request", r);
  if (r.outcome === "denied" || r.outcome === "unauthenticated") {
    const who = r.actor === "unknown" ? "an unidentified client" : `**${r.actor}**`;
    activity("gateway", "denied", `Blocked ${who}: ${ACTIONS[r.action]?.label?.toLowerCase() || r.action}${r.project ? ` on **${r.project}**` : ""} (${r.reason})`, { project: r.project, request: r.id });
  }
  return r;
}

// Run a request through the gateway: authorize -> handler -> record. Returns the handler's result.
// The handler may return { isError } (MCP style) or throw; PermissionError/Denied count as denials.
export async function run(caller, action, target, handler) {
  const t0 = Date.now();
  const base = { actor: caller.actor, actorKind: caller.kind, channel: caller.channel, client: caller.client, action, project: target?.project || null, resource: target?.resource || null, detail: target?.detail };
  const auth = authorize(caller, action, target?.project);
  if (!auth.allowed) {
    record({ ...base, outcome: "denied", status: 403, reason: auth.reason, ms: Date.now() - t0 });
    throw new Denied(auth.reason);
  }
  try {
    const result = await handler();
    const failed = result && result.isError;
    record({ ...base, outcome: failed ? "error" : "allowed", status: failed ? 400 : 200, reason: failed ? errorText(result) : null, ms: Date.now() - t0 });
    return result;
  } catch (e) {
    const denied = e?.name === "PermissionError" || e?.name === "Denied";
    record({ ...base, outcome: denied ? "denied" : "error", status: e?.status || (denied ? 403 : 500), reason: e?.message, ms: Date.now() - t0 });
    throw e;
  }
}
const errorText = (r) => r?.content?.map?.(c => c.text).join(" ").slice(0, 300) || "Request failed";

// ---------------------------------------------------------------------------------
// Queries for the dashboard
// ---------------------------------------------------------------------------------
// scope (non-owners): only rows for projects they can see, or rows by their own agents / themselves.
function scopeSql(scope, where, args) {
  if (!scope) return;
  const ps = scope.projects.length ? scope.projects : ["\u0000"], as = scope.actors.length ? scope.actors : ["\u0000"];
  where.push(`(project IN (${ps.map(() => "?").join(",")}) OR (project IS NULL AND actor IN (${as.map(() => "?").join(",")})))`);
  args.push(...ps, ...as);
}

export function list({ limit = 200, outcome, actor, project, action, before, scope } = {}) {
  const where = [], args = [];
  scopeSql(scope, where, args);
  if (outcome) { where.push("outcome = ?"); args.push(outcome); }
  if (actor) { where.push("actor = ?"); args.push(actor); }
  if (project) { where.push("project = ?"); args.push(project); }
  if (action) { where.push("action LIKE ?"); args.push(action.replace(/\*$/, "%")); }
  if (before) { where.push("seq < ?"); args.push(Number(before)); }
  const rows = sql.prepare(`SELECT * FROM requests ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY seq DESC LIMIT ?`).all(...args, Math.min(Number(limit) || 200, 1000));
  return rows.map(r => ({ ...r, detail: r.detail ? JSON.parse(r.detail) : null, label: ACTIONS[r.action]?.label || r.action }));
}

export function stats(sinceHours = 24, scope = null) {
  const since = new Date(Date.now() - sinceHours * 3600e3).toISOString();
  const w = ["at >= ?"], a = [since];
  scopeSql(scope, w, a);
  const W = w.join(" AND ");
  const by = Object.fromEntries(sql.prepare(`SELECT outcome, COUNT(*) AS n FROM requests WHERE ${W} GROUP BY outcome`).all(...a).map(r => [r.outcome, r.n]));
  const agents = sql.prepare(`SELECT actor, COUNT(*) AS n, SUM(outcome = 'denied') AS denied FROM requests WHERE ${W} AND actorKind = 'agent' GROUP BY actor ORDER BY n DESC`).all(...a);
  // Latency of requests the gateway answers (the Overseer's background AI runs aren't request latency).
  // AI-backed work (asking the brain) takes seconds by design; it isn't gateway overhead.
  const avg = sql.prepare(`SELECT AVG(ms) AS ms FROM requests WHERE ${W} AND outcome = 'allowed' AND actorKind != 'overseer' AND action NOT IN ('context.query', 'overseer.ask')`).get(...a).ms;
  return { sinceHours, total: Object.values(by).reduce((a, b) => a + b, 0), allowed: by.allowed || 0, denied: by.denied || 0, unauthenticated: by.unauthenticated || 0, error: by.error || 0, avgMs: avg ? Math.round(avg) : 0, agents };
}
