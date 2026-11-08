// Tool-call policy: what a connected CLI agent may do on the user's machine.
//
// Claude Code calls our gateway (PreToolUse HTTP hook) before EVERY tool call. We evaluate these
// rules and answer deny / ask / (nothing = let Claude Code's normal permission flow decide).
// We never answer "allow": the gateway can only make an agent MORE restricted, never bypass the
// user's own permission prompts.
//
// Rules: first match wins. Project rules are checked before global rules.

import { randomUUID } from "node:crypto";
import { sql } from "./store/db.js";
import { emit } from "./bus.js";

sql.exec(`CREATE TABLE IF NOT EXISTS policies (
  id TEXT PRIMARY KEY, project TEXT, tools TEXT, pattern TEXT, decision TEXT, reason TEXT,
  enabled INTEGER DEFAULT 1, builtIn INTEGER DEFAULT 0, position INTEGER, createdAt TEXT)`);

const FILE_TOOLS = "Read|Edit|Write|MultiEdit|NotebookEdit";
export const DEFAULT_RULES = [
  { tools: FILE_TOOLS, pattern: String.raw`(^|[\\/])\.env($|\.(?!example$|sample$|template$))|(^|[\\/])(id_rsa|id_ed25519)|\.pem$|\.key$|(^|[\\/])\.aws[\\/]credentials|(^|[\\/])\.npmrc$`, decision: "deny", reason: "Secret files (.env, keys, credentials) are blocked by Loom policy" },
  { tools: "Bash|PowerShell", pattern: String.raw`\b(cat|less|more|head|tail|type|get-content|gc|bat|xxd|strings)\b[^|;&]*\.env\b(?!\.example|\.sample)`, decision: "deny", reason: "Printing .env files is blocked by Loom policy" },
  { tools: "Bash|PowerShell", pattern: String.raw`\b(printenv|env)\s*($|\|)|\$env:[a-z_]*(key|token|secret|password)`, decision: "deny", reason: "Dumping environment secrets is blocked by Loom policy" },
  { tools: "Bash|PowerShell", pattern: String.raw`\brm\s+(-[a-z]*\s+)*-[a-z]*(rf|fr)[a-z]*\s+(/|~|\$home|\*)(\s|$)|remove-item\s+.*-recurse.*\s(c:\\|~|/)\s*$`, decision: "deny", reason: "Deleting the filesystem root or home directory is blocked" },
  { tools: "Bash|PowerShell", pattern: String.raw`\bgit\s+push\b.*(\s--force(?!-with-lease)\b|\s-f\b)`, decision: "deny", reason: "Force-push is blocked. Push a branch and open a PR instead" },
  { tools: "Bash|PowerShell", pattern: String.raw`\b(curl|wget|iwr|invoke-webrequest)\b[^|]*\|\s*(sh|bash|zsh|iex|invoke-expression|python)\b`, decision: "deny", reason: "Piping downloaded scripts into a shell is blocked" },
  { tools: "Bash|PowerShell", pattern: String.raw`\bgit\s+reset\s+--hard\b|\bgit\s+clean\s+-[a-z]*f`, decision: "ask", reason: "Discarding local changes needs your approval" },
  { tools: "Bash|PowerShell", pattern: String.raw`\b(npm|pnpm|yarn)\s+(run\s+)?deploy\b|\bterraform\s+(apply|destroy)\b|\bkubectl\s+(apply|delete)\b|\bcdk\s+(deploy|destroy)\b|\bvercel\s+--prod\b|\baws\s+\S+\s+(delete|terminate|remove)`, decision: "ask", reason: "Deploys and cloud deletions need human approval" },
  { tools: "Bash|PowerShell", pattern: String.raw`\b(npm|pnpm|yarn)\s+publish\b|\bdocker\s+push\b`, decision: "ask", reason: "Publishing packages or images needs human approval" },
];

export function seedDefaults() {
  const n = sql.prepare("SELECT COUNT(*) AS n FROM policies WHERE builtIn = 1").get().n;
  if (n) return;
  const st = sql.prepare("INSERT INTO policies (id, project, tools, pattern, decision, reason, enabled, builtIn, position, createdAt) VALUES (?, NULL, ?, ?, ?, ?, 1, 1, ?, ?)");
  DEFAULT_RULES.forEach((r, i) => st.run(`P-${String(i + 1).padStart(2, "0")}`, r.tools, r.pattern, r.decision, r.reason, i, new Date().toISOString()));
}

export const list = () => sql.prepare("SELECT * FROM policies ORDER BY (project IS NULL), project, position, createdAt").all().map(r => ({ ...r, enabled: !!r.enabled, builtIn: !!r.builtIn }));

export function add({ project = null, tools = "*", pattern, decision, reason }) {
  if (!["deny", "ask"].includes(decision)) throw Object.assign(new Error("decision must be deny or ask"), { status: 400 });
  try { new RegExp(pattern, "i"); } catch (e) { throw Object.assign(new Error(`Invalid pattern: ${e.message}`), { status: 400 }); }
  const id = `P-${randomUUID().slice(0, 6)}`;
  const pos = (sql.prepare("SELECT MAX(position) AS m FROM policies").get().m ?? 0) + 1;
  sql.prepare("INSERT INTO policies (id, project, tools, pattern, decision, reason, enabled, builtIn, position, createdAt) VALUES (?, ?, ?, ?, ?, ?, 1, 0, ?, ?)")
    .run(id, project || null, String(tools || "*").trim() || "*", pattern, decision, String(reason || "Blocked by Loom policy").slice(0, 200), pos, new Date().toISOString());
  emit("policy", { id });
  return id;
}
export function setEnabled(id, enabled) { sql.prepare("UPDATE policies SET enabled = ? WHERE id = ?").run(enabled ? 1 : 0, id); emit("policy", { id }); }
export function remove(id) { sql.prepare("DELETE FROM policies WHERE id = ? AND builtIn = 0").run(id); emit("policy", { id }); }

// The text a rule's pattern is matched against, per tool.
export function subjectOf(tool, input = {}) {
  if (tool === "Bash" || tool === "PowerShell") return String(input.command || "");
  if (input.file_path || input.notebook_path || input.path) return String(input.file_path || input.notebook_path || input.path);
  if (input.url) return String(input.url);
  if (input.pattern) return String(input.pattern);
  try { return JSON.stringify(input).slice(0, 2000); } catch { return ""; }
}

const toolMatches = (spec, tool) => !spec || spec === "*" || spec.split(/[|,]/).map(s => s.trim()).filter(Boolean).some(t => t === tool || (t.endsWith("*") && tool.startsWith(t.slice(0, -1))));

// -> { decision: "deny" | "ask" | "pass", rule?, reason? }
export function evaluate(tool, input, project) {
  const subject = subjectOf(tool, input);
  const rules = list().filter(r => r.enabled && (r.project === null || r.project === project));
  rules.sort((a, b) => (a.project ? 0 : 1) - (b.project ? 0 : 1));
  for (const r of rules) {
    if (!toolMatches(r.tools, tool)) continue;
    let re; try { re = new RegExp(r.pattern, "i"); } catch { continue; }
    if (re.test(subject)) return { decision: r.decision, rule: r.id, reason: r.reason };
  }
  return { decision: "pass" };
}

// A safe, short description of a tool call for the gateway log: never the full command or contents.
export function describe(tool, input = {}) {
  if (tool === "Bash" || tool === "PowerShell") {
    // Program name, plus a plain lowercase subcommand (git push, npm run). Arguments may hold secrets.
    const words = String(input.command || "").trim().split(/\s+/);
    const prog = (words[0] || "").split(/[\\/]/).pop().replace(/[^\w.\-]/g, "").slice(0, 24);
    const sub = /^[a-z][a-z-]{1,15}$/.test(words[1] || "") ? ` ${words[1]}` : "";
    return `${tool}: ${prog}${sub}${words.length > (sub ? 2 : 1) ? " …" : ""}`;
  }
  const p = input.file_path || input.notebook_path || input.path;
  if (p) return `${tool}: ${String(p).split(/[\\/]/).pop()}`;
  if (input.url) { try { return `${tool}: ${new URL(input.url).hostname}`; } catch {} }
  return tool;
}
