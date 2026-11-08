// Accounts, sessions, project membership, and agent tokens.
//
// Modes:
//   open mode    no accounts exist and no HIVEMIND_PASSWORD: local dev. No login; agents identify
//                with ?agent=NAME. The dashboard invites you to create the first account.
//   secure mode  as soon as one account exists (or HIVEMIND_PASSWORD is set):
//                - dashboard + /api need a signed-in user (HttpOnly session cookie)
//                - agents need a per-agent token (Authorization: Bearer hm_…); the agent's name comes
//                  from the token, so nobody can impersonate an agent by editing a URL
//
// Users see only projects they're members of. The first account is the workspace owner and sees
// everything. HIVEMIND_PASSWORD still works as an admin login ("human"), mainly for scripts/tests.

import crypto from "node:crypto";
import { sql } from "./store/db.js";

export const PASSWORD = process.env.HIVEMIND_PASSWORD || null;
const SESSION_DAYS = 14;

sql.exec(`
  CREATE TABLE IF NOT EXISTS tokens (id TEXT PRIMARY KEY, hash TEXT UNIQUE, agent TEXT, createdAt TEXT, lastUsed TEXT, revokedAt TEXT);
  CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT UNIQUE, name TEXT, hash TEXT, salt TEXT, owner INTEGER DEFAULT 0, createdAt TEXT, lastLogin TEXT);
  CREATE TABLE IF NOT EXISTS members (project TEXT, userId TEXT, role TEXT, addedAt TEXT, PRIMARY KEY (project, userId));
  CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
`);
try { sql.exec("ALTER TABLE tokens ADD COLUMN ownerId TEXT"); } catch { /* already there */ }

// Session signing secret: env, else persisted in the DB so sessions survive restarts.
const SECRET = process.env.HIVEMIND_SECRET || (() => {
  const row = sql.prepare("SELECT value FROM settings WHERE key = 'session_secret'").get();
  if (row) return row.value;
  const s = crypto.randomBytes(32).toString("hex");
  sql.prepare("INSERT INTO settings (key, value) VALUES ('session_secret', ?)").run(s);
  return s;
})();

const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");
const hmac = (s) => crypto.createHmac("sha256", SECRET).update(s).digest("base64url");
const safeEq = (a, b) => { const A = Buffer.from(String(a)), B = Buffer.from(String(b)); return A.length === B.length && crypto.timingSafeEqual(A, B); };
const now = () => new Date().toISOString();
const err = (msg, status) => Object.assign(new Error(msg), { status });

// --- Mode ---------------------------------------------------------------------------
export const userCount = () => sql.prepare("SELECT COUNT(*) AS n FROM users").get().n;
export const isSecure = () => !!PASSWORD || userCount() > 0;

// --- Users ----------------------------------------------------------------------------
const OPEN_USER = { id: "open", name: "human", email: null, owner: true, open: true };
const ADMIN_USER = { id: "admin", name: "human", email: null, owner: true, admin: true };
const publicUser = (u) => u && ({ id: u.id, email: u.email, name: u.name, owner: !!u.owner, admin: !!u.admin, open: !!u.open });

function hashPassword(pw, salt) { return crypto.scryptSync(String(pw), salt, 64).toString("hex"); }

export function signup({ email, name, password }) {
  email = String(email || "").trim().toLowerCase();
  name = String(name || "").trim().slice(0, 60) || email.split("@")[0];
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw err("Enter a valid email", 400);
  if (String(password || "").length < 8) throw err("Password must be at least 8 characters", 400);
  if (sql.prepare("SELECT 1 FROM users WHERE email = ?").get(email)) throw err("An account with that email already exists", 409);
  const salt = crypto.randomBytes(16).toString("hex");
  const first = userCount() === 0;
  const user = { id: crypto.randomUUID(), email, name, owner: first ? 1 : 0 };
  sql.prepare("INSERT INTO users (id, email, name, hash, salt, owner, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?)").run(user.id, email, name, hashPassword(password, salt), salt, user.owner, now());
  return publicUser(user);
}

export function login({ email, password }) {
  if (!email && PASSWORD) return safeEq(sha(String(password || "")), sha(PASSWORD)) ? ADMIN_USER : null;
  const u = sql.prepare("SELECT * FROM users WHERE email = ?").get(String(email || "").trim().toLowerCase());
  if (!u) { hashPassword(password || "", "timing-equalizer"); return null; }
  if (!safeEq(hashPassword(password || "", u.salt), u.hash)) return null;
  sql.prepare("UPDATE users SET lastLogin = ? WHERE id = ?").run(now(), u.id);
  return publicUser(u);
}

export const getUser = (id) => publicUser(sql.prepare("SELECT * FROM users WHERE id = ?").get(id));
export const findUserByEmail = (email) => publicUser(sql.prepare("SELECT * FROM users WHERE email = ?").get(String(email || "").trim().toLowerCase()));

// Legacy helper kept for scripts: true if the team password matches.
export function checkPassword(pw) { return !!PASSWORD && safeEq(sha(String(pw || "")), sha(PASSWORD)); }

// --- Sessions -----------------------------------------------------------------------------
export function sessionCookie(req, user) {
  const exp = Date.now() + SESSION_DAYS * 864e5;
  const uid = user?.id || "admin";
  const value = `${exp}.${uid}.${hmac(`${exp}.${uid}`)}`;
  const https = req.headers["x-forwarded-proto"] === "https" || req.socket.encrypted;
  return `hm_session=${value}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${https ? "; Secure" : ""}`;
}
export const clearCookie = "hm_session=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0";

// The signed-in user for this request (open mode: everyone is the local owner).
export function sessionUser(req) {
  if (!isSecure()) return OPEN_USER;
  const m = (req.headers.cookie || "").match(/(?:^|;\s*)hm_session=([^;]+)/);
  if (!m) return null;
  const [exp, uid, sig] = m[1].split(".");
  if (!exp || !uid || !sig || Number(exp) <= Date.now() || !safeEq(sig, hmac(`${exp}.${uid}`))) return null;
  if (uid === "admin") return PASSWORD ? ADMIN_USER : null;
  return getUser(uid);
}
export const isLoggedIn = (req) => !!sessionUser(req);

// --- Project membership ----------------------------------------------------------------
// Owners/admins see every project. Others see projects they're members of, plus legacy projects
// that have no members at all (e.g. created before accounts existed).
export function canSeeProject(user, slug) {
  if (!user) return false;
  if (user.owner || user.admin || user.open) return true;
  if (sql.prepare("SELECT 1 FROM members WHERE project = ? AND userId = ?").get(slug, user.id)) return true;
  return !sql.prepare("SELECT 1 FROM members WHERE project = ?").get(slug);
}
export function addMember(project, userId, role = "member") {
  sql.prepare("INSERT OR REPLACE INTO members (project, userId, role, addedAt) VALUES (?, ?, ?, ?)").run(project, userId, role, now());
}
export function removeMember(project, userId) { sql.prepare("DELETE FROM members WHERE project = ? AND userId = ?").run(project, userId); }
export const projectMembers = (project) => sql.prepare("SELECT m.role, m.addedAt, u.id, u.email, u.name FROM members m JOIN users u ON u.id = m.userId WHERE m.project = ? ORDER BY m.role = 'owner' DESC, u.name").all(project);
export const memberRole = (project, userId) => sql.prepare("SELECT role FROM members WHERE project = ? AND userId = ?").get(project, userId)?.role || null;

// --- Agent tokens ---------------------------------------------------------------------------
export function createToken(agent, ownerId = null) {
  const name = String(agent).trim().slice(0, 40).replace(/[^\w.@-]/g, "-");
  if (!name) throw err("Agent name required", 400);
  const token = `hm_${crypto.randomBytes(24).toString("base64url")}`;
  const id = crypto.randomUUID().slice(0, 8);
  sql.prepare("INSERT INTO tokens (id, hash, agent, createdAt, ownerId) VALUES (?, ?, ?, ?, ?)").run(id, sha(token), name, now(), ownerId);
  return { id, agent: name, token }; // the raw token is only ever returned here
}
// Users see their own tokens; owners/admins see all.
export function listTokens(user = null) {
  const all = !user || user.owner || user.admin || user.open;
  return (all ? sql.prepare("SELECT id, agent, createdAt, lastUsed, revokedAt, ownerId FROM tokens ORDER BY createdAt DESC").all()
    : sql.prepare("SELECT id, agent, createdAt, lastUsed, revokedAt, ownerId FROM tokens WHERE ownerId = ? ORDER BY createdAt DESC").all(user.id));
}
export function revokeToken(id, user = null) {
  const t = sql.prepare("SELECT * FROM tokens WHERE id = ?").get(id);
  if (!t) throw err("No such token", 404);
  if (user && !(user.owner || user.admin || user.open) && t.ownerId !== user.id) throw err("You can only revoke your own agents' tokens", 403);
  sql.prepare("UPDATE tokens SET revokedAt = ? WHERE id = ? AND revokedAt IS NULL").run(now(), id);
}
export const tokenOwner = (agent) => sql.prepare("SELECT ownerId FROM tokens WHERE agent = ? AND revokedAt IS NULL AND ownerId IS NOT NULL ORDER BY createdAt DESC").get(agent)?.ownerId || null;

// Returns the agent name for a request to /mcp or /hooks, or null if it isn't allowed.
export function agentForMcp(req, url) {
  if (!isSecure()) return String(url.searchParams.get("agent") || req.headers["x-agent-name"] || "anonymous").slice(0, 40).replace(/[^\w.@-]/g, "-");
  const raw = (req.headers.authorization || "").replace(/^Bearer\s+/i, "") || url.searchParams.get("token") || "";
  if (!raw.startsWith("hm_")) return null;
  const row = sql.prepare("SELECT * FROM tokens WHERE hash = ? AND revokedAt IS NULL").get(sha(raw));
  if (!row) return null;
  if (!row.lastUsed || Date.now() - Date.parse(row.lastUsed) > 60000) sql.prepare("UPDATE tokens SET lastUsed = ? WHERE id = ?").run(now(), row.id);
  return row.agent;
}
