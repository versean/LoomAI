// Operational data that isn't "knowledge": the raw log of pushes and conversations,
// agent chat, the conductor queue, approvals, and run stats. SQLite (built into Node).

import path from "node:path";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { emit } from "../bus.js";
import { currentUser } from "../context.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.HIVEMIND_DATA_DIR || path.join(here, "..", "..", "data");
fs.mkdirSync(DATA_DIR, { recursive: true });

export const sql = new DatabaseSync(path.join(DATA_DIR, "hivemind.db"));
sql.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS agents (name TEXT PRIMARY KEY, project TEXT, task TEXT, connectedAt TEXT, lastSeen TEXT);
  CREATE TABLE IF NOT EXISTS log (id TEXT PRIMARY KEY, kind TEXT, project TEXT, agent TEXT, task TEXT, title TEXT, payload TEXT, summary TEXT, at TEXT);
  CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, sender TEXT, recipient TEXT, text TEXT, project TEXT, at TEXT, readAt TEXT, auto INTEGER DEFAULT 0);
  CREATE TABLE IF NOT EXISTS activity (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT, at TEXT, actor TEXT, type TEXT, text TEXT, refs TEXT);
  CREATE TABLE IF NOT EXISTS queue (id TEXT PRIMARY KEY, kind TEXT, refId TEXT, project TEXT, at TEXT, attempts INTEGER DEFAULT 0);
  CREATE TABLE IF NOT EXISTS proposals (id TEXT PRIMARY KEY, project TEXT, op TEXT, heading TEXT, content TEXT, reason TEXT, status TEXT, at TEXT, decidedAt TEXT, sha TEXT);
  CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, at TEXT, project TEXT, items INTEGER, notes TEXT, sha TEXT, ms INTEGER, tokensIn INTEGER, tokensOut INTEGER, ok INTEGER);
  CREATE TABLE IF NOT EXISTS github (project TEXT PRIMARY KEY, repo TEXT, data TEXT, fetchedAt TEXT, error TEXT);
`);

const now = () => new Date().toISOString();
const J = (s) => { try { return s ? JSON.parse(s) : null; } catch { return null; } };

// --- Activity ---------------------------------------------------------------------
export function activity(actor, type, text, refs = {}) {
  // Human entries carry the signed-in person's name (refs.user) so the feed shows who did it.
  const u = currentUser();
  if (actor === "human" && u?.email && !refs.user) refs = { ...refs, user: u.name };
  const e = { id: randomUUID(), at: now(), actor, type, text, refs };
  sql.prepare("INSERT INTO activity (id, at, actor, type, text, refs) VALUES (?, ?, ?, ?, ?, ?)").run(e.id, e.at, actor, type, text, JSON.stringify(refs));
  emit("activity", e);
  return e;
}
export const listActivity = (limit = 150, project = null) =>
  (project
    ? sql.prepare("SELECT * FROM activity WHERE json_extract(refs, '$.project') = ? ORDER BY seq DESC LIMIT ?").all(project, limit)
    : sql.prepare("SELECT * FROM activity ORDER BY seq DESC LIMIT ?").all(limit)
  ).map(r => ({ ...r, refs: J(r.refs) || {} }));
export const lastActivity = (actor) => { const r = sql.prepare("SELECT * FROM activity WHERE actor = ? ORDER BY seq DESC LIMIT 1").get(actor); return r ? { ...r, refs: J(r.refs) || {} } : null; };

// --- Agents -----------------------------------------------------------------------
export function touchAgent(name, patch = {}) {
  const cur = sql.prepare("SELECT * FROM agents WHERE name = ?").get(name);
  const a = { name, project: null, task: null, connectedAt: now(), ...(cur || {}), ...patch, lastSeen: now() };
  sql.prepare("INSERT OR REPLACE INTO agents (name, project, task, connectedAt, lastSeen) VALUES (?, ?, ?, ?, ?)").run(a.name, a.project, a.task, a.connectedAt, a.lastSeen);
  emit("agent", a);
  return a;
}
export const getAgent = (name) => sql.prepare("SELECT * FROM agents WHERE name = ?").get(name) || null;
export const listAgents = () => sql.prepare("SELECT * FROM agents ORDER BY lastSeen DESC").all();

// --- Log (pushes, conversations): append-only raw record ------------------------------
export function addLog({ kind, project, agent, task = null, title = null, payload }) {
  const e = { id: randomUUID(), kind, project, agent, task, title, payload, summary: null, at: now() };
  sql.prepare("INSERT INTO log (id, kind, project, agent, task, title, payload, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(e.id, kind, project, agent, task, title, JSON.stringify(payload), e.at);
  enqueue(kind, e.id, project);
  emit("log", e);
  return e;
}
export const getLog = (id) => { const r = sql.prepare("SELECT * FROM log WHERE id = ?").get(id); return r ? { ...r, payload: J(r.payload) } : null; };
export const listLog = (project, limit = 100) =>
  (project ? sql.prepare("SELECT * FROM log WHERE project = ? ORDER BY at DESC LIMIT ?").all(project, limit) : sql.prepare("SELECT * FROM log ORDER BY at DESC LIMIT ?").all(limit))
    .map(r => ({ ...r, payload: J(r.payload) }));
export function setLogMeta(id, { summary, project }) {
  if (summary !== undefined) sql.prepare("UPDATE log SET summary = ? WHERE id = ?").run(summary, id);
  if (project) sql.prepare("UPDATE log SET project = ? WHERE id = ? AND project IS NULL").run(project, id);
  emit("log", { id });
}

// --- Messages -----------------------------------------------------------------------
export function addMessage({ from, to, text, project = null, auto = false, queue = true }) {
  const m = { id: randomUUID(), sender: from, recipient: to, text, project, at: now(), readAt: null, auto: auto ? 1 : 0 };
  sql.prepare("INSERT INTO messages (id, sender, recipient, text, project, at, auto) VALUES (?, ?, ?, ?, ?, ?, ?)").run(m.id, from, to, text, project, m.at, m.auto);
  if (queue) enqueue("message", m.id, project);
  emit("message", m);
  return m;
}
export const getMessage = (id) => sql.prepare("SELECT * FROM messages WHERE id = ?").get(id) || null;
export function inbox(agent, { unreadOnly = true } = {}) {
  return sql.prepare(`SELECT * FROM messages WHERE (recipient = ? OR recipient = '*') AND sender != ? ${unreadOnly ? "AND readAt IS NULL" : ""} ORDER BY at`).all(agent, agent);
}
export function markRead(ids) { const st = sql.prepare("UPDATE messages SET readAt = ? WHERE id = ? AND recipient != '*'"); for (const id of ids) st.run(now(), id); }
export const listMessages = (limit = 200) => sql.prepare("SELECT * FROM (SELECT * FROM messages ORDER BY at DESC LIMIT ?) ORDER BY at").all(limit);

// --- Queue ----------------------------------------------------------------------------
export function enqueue(kind, refId, project) {
  sql.prepare("INSERT INTO queue (id, kind, refId, project, at) VALUES (?, ?, ?, ?, ?)").run(randomUUID(), kind, refId, project, now());
  emit("queue", { length: queueLength() });
}
export const queueLength = () => sql.prepare("SELECT COUNT(*) AS n FROM queue").get().n;
export const peekQueue = (limit = 12) => sql.prepare("SELECT * FROM queue ORDER BY at LIMIT ?").all(limit);
export const oldestQueued = () => sql.prepare("SELECT MIN(at) AS at FROM queue").get().at;
export function dequeue(ids) { const st = sql.prepare("DELETE FROM queue WHERE id = ?"); for (const id of ids) st.run(id); emit("queue", { length: queueLength() }); }
export function setQueueProject(id, project) { sql.prepare("UPDATE queue SET project = ? WHERE id = ?").run(project, id); }
export function bumpAttempts(ids) { const st = sql.prepare("UPDATE queue SET attempts = attempts + 1 WHERE id = ?"); for (const id of ids) st.run(id); }

// --- Proposals (conductor -> instructions, needs human approval) ------------------------
export function addProposal({ project, op, heading, content, reason }) {
  const p = { id: randomUUID().slice(0, 8), project, op, heading, content, reason, status: "pending", at: now() };
  sql.prepare("INSERT INTO proposals (id, project, op, heading, content, reason, status, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(p.id, project, op, heading, content, reason, p.status, p.at);
  emit("proposal", p);
  return p;
}
export const getProposal = (id) => sql.prepare("SELECT * FROM proposals WHERE id = ?").get(id) || null;
export const listProposals = (project, status = null) =>
  sql.prepare(`SELECT * FROM proposals WHERE project = ? ${status ? "AND status = ?" : ""} ORDER BY at DESC`).all(...(status ? [project, status] : [project]));
export function decideProposal(id, status, sha = null) {
  sql.prepare("UPDATE proposals SET status = ?, decidedAt = ?, sha = ? WHERE id = ?").run(status, now(), sha, id);
  emit("proposal", { id, status });
}
export const pendingProposalCount = () => sql.prepare("SELECT project, COUNT(*) AS n FROM proposals WHERE status = 'pending' GROUP BY project").all();

// --- Conductor runs -----------------------------------------------------------------------
export function addRun(r) {
  sql.prepare("INSERT INTO runs (id, at, project, items, notes, sha, ms, tokensIn, tokensOut, ok) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(randomUUID(), now(), r.project, r.items, r.notes, r.sha, r.ms, r.tokensIn, r.tokensOut, r.ok ? 1 : 0);
  emit("run", r);
}
export const runStats = () => sql.prepare("SELECT COUNT(*) AS runs, COALESCE(SUM(items),0) AS items, COALESCE(SUM(tokensIn),0) AS tokensIn, COALESCE(SUM(tokensOut),0) AS tokensOut, COALESCE(AVG(ms),0) AS avgMs FROM runs WHERE ok = 1").get();
export const listRuns = (limit = 20) => sql.prepare("SELECT * FROM runs ORDER BY at DESC LIMIT ?").all(limit);

// --- GitHub cache ----------------------------------------------------------------------------
export function setGithub(project, repo, data, error = null) {
  sql.prepare("INSERT OR REPLACE INTO github (project, repo, data, fetchedAt, error) VALUES (?, ?, ?, ?, ?)").run(project, repo, JSON.stringify(data), now(), error);
  emit("github", { project });
}
export const getGithub = (project) => { const r = sql.prepare("SELECT * FROM github WHERE project = ?").get(project); return r ? { ...r, data: J(r.data) } : null; };

export function resetAll() {
  sql.exec("DELETE FROM agents; DELETE FROM log; DELETE FROM messages; DELETE FROM activity; DELETE FROM queue; DELETE FROM proposals; DELETE FROM runs; DELETE FROM github;");
}
