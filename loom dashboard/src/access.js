// Per-agent project access: none | read | write. Enforced by the gateway (server-side).
//
// An explicit grant always wins. Without one, the default applies:
//   secure mode (HIVEMIND_PASSWORD set): none   -> agents see nothing until a human grants access
//   open mode (local dev):               write  -> everything just works on your laptop
// Override with HIVEMIND_DEFAULT_ACCESS=none|read|write.

import { sql } from "./store/db.js";
import { isSecure } from "./auth.js";
import { emit } from "./bus.js";

export const LEVELS = ["none", "read", "write"];
// Evaluated per request: the hub flips to secure mode the moment the first account is created.
export const defaultAccess = () => LEVELS.includes(process.env.HIVEMIND_DEFAULT_ACCESS) ? process.env.HIVEMIND_DEFAULT_ACCESS : isSecure() ? "none" : "write";
const RANK = { none: 0, read: 1, write: 2 };

sql.exec(`CREATE TABLE IF NOT EXISTS grants (agent TEXT, project TEXT, access TEXT, updatedAt TEXT, updatedBy TEXT, PRIMARY KEY (agent, project))`);

export function explicit(agent, project) {
  return sql.prepare("SELECT access FROM grants WHERE agent = ? AND project = ?").get(agent, project)?.access || null;
}

export function effective(agent, project) { return explicit(agent, project) || defaultAccess(); }
export const can = (agent, project, need) => RANK[effective(agent, project)] >= RANK[need];

export function set(agent, project, access, by = "human") {
  if (!LEVELS.includes(access)) throw Object.assign(new Error(`Access must be one of ${LEVELS.join(", ")}`), { status: 400 });
  sql.prepare("INSERT OR REPLACE INTO grants (agent, project, access, updatedAt, updatedBy) VALUES (?, ?, ?, ?, ?)").run(agent, project, access, new Date().toISOString(), by);
  emit("access", { agent, project, access });
}

export function clear(agent, project) {
  sql.prepare("DELETE FROM grants WHERE agent = ? AND project = ?").run(agent, project);
  emit("access", { agent, project, access: null });
}

export const forProject = (project) => sql.prepare("SELECT * FROM grants WHERE project = ?").all(project);
export const forAgent = (agent) => sql.prepare("SELECT * FROM grants WHERE agent = ?").all(agent);
export const knownAgents = () => sql.prepare("SELECT DISTINCT agent FROM grants").all().map(r => r.agent);

// Filter a list of project slugs down to the ones an agent may read/write.
export const visible = (agent, slugs, need = "read") => slugs.filter(s => can(agent, s, need));
