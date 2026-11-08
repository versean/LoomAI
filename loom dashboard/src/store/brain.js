// The brain: every project is a folder of markdown/JSON in a git repo.
//
//   projects/<slug>/
//     project.json          name, description
//     brief.md              main context. Conductor-maintained; <!-- pin --> blocks are preserved verbatim
//     instructions.md       rules. HUMANS ONLY. The conductor can only propose changes
//     playbooks/<task>.md   per-area briefings (website, api, ...). Conductor-maintained
//     decisions/D-0001.md   append-only decision records. Never edited; superseded by newer ones
//     links.json            repo, PRs, deploys, designs... structured
//     files/<name>          reference files. Read-only to AI; never overwritten
//
// Permissions are enforced HERE, not in prompts. Snapshots are git tags; nothing deletes them.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { GitRepo } from "./git.js";
import { emit } from "../bus.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.HIVEMIND_DATA_DIR || path.join(here, "..", "..", "data");
export const repo = new GitRepo(path.join(DATA_DIR, "brain"));

export class PermissionError extends Error { constructor(msg) { super(msg); this.name = "PermissionError"; this.status = 403; } }

export const slugify = (s) => String(s).toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "").slice(0, 60) || "untitled";
const P = (slug, ...rest) => ["projects", slug, ...rest].join("/");
const now = () => new Date().toISOString();

export async function init() { await repo.init(); }

// --- Projects ------------------------------------------------------------------

export function listProjects() {
  return repo.list("projects").filter(d => d.isDirectory()).map(d => getProject(d.name)).filter(Boolean)
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function getProject(slugOrName) {
  if (!slugOrName) return null;
  const slug = slugify(slugOrName);
  const raw = repo.read(P(slug, "project.json"));
  return raw ? { ...JSON.parse(raw), slug } : null;
}

export async function createProject({ name, description = "", actor = "human" }) {
  const slug = slugify(name);
  if (getProject(slug)) return getProject(slug);
  const meta = { name, description, createdAt: now(), createdBy: actor };
  await repo.commit({
    [P(slug, "project.json")]: JSON.stringify(meta, null, 2) + "\n",
    [P(slug, "brief.md")]: `# ${name}\n\n${description || "_No description yet._"}\n\n## Current state\n\n_Nothing recorded yet. The conductor fills this in as agents push._\n\n## Who's on what\n\n_Nobody yet._\n\n## Open questions\n\n_None._\n`,
    [P(slug, "instructions.md")]: `# Instructions: ${name}\n\nRules every agent must follow on this project. **Only humans edit this file.** The conductor can propose changes, which appear in Approvals.\n\n## Rules\n\n- Pull your briefing (\`/pull <task>\`) before starting work.\n- Push (\`/push\`) after every meaningful change: decisions, API changes, blockers.\n- Message the affected teammate before making a breaking change.\n`,
    [P(slug, "links.json")]: "[]\n",
  }, `Create project ${name}`, actor);
  emit("project", { slug });
  return getProject(slug);
}

export async function updateProjectMeta(slug, patch, actor) {
  const p = getProject(slug); if (!p) throw new Error("No such project");
  const { slug: _, ...meta } = { ...p, ...patch };
  await repo.commit({ [P(slug, "project.json")]: JSON.stringify(meta, null, 2) + "\n" }, `Update ${p.name} details`, actor);
  emit("project", { slug });
}

// --- Markdown section helpers (H2-level) -----------------------------------------

export function splitSections(md) {
  const lines = md.replace(/\r/g, "").split("\n");
  const sections = [{ heading: null, lines: [] }];
  for (const line of lines) {
    const m = line.match(/^##\s+(.*)$/);
    if (m) sections.push({ heading: m[1].trim(), lines: [] });
    else sections[sections.length - 1].lines.push(line);
  }
  return sections;
}
function joinSections(sections) {
  return sections.map(s => (s.heading ? [`## ${s.heading}`, ...s.lines] : s.lines).join("\n")).join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}
const norm = (h) => h.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

// ops: replace (create if missing) | append (add lines under heading, create if missing) | delete
export function patchMarkdown(md, edits) {
  const sections = splitSections(md);
  for (const e of edits) {
    const i = sections.findIndex(s => s.heading && norm(s.heading) === norm(e.heading));
    const body = String(e.content || "").replace(/\r/g, "").trim();
    if (e.op === "delete") { if (i > 0) sections.splice(i, 1); continue; }
    if (i < 0) { sections.push({ heading: e.heading, lines: ["", body, ""] }); continue; }
    if (e.op === "append") {
      const existing = sections[i].lines.join("\n").trim();
      const placeholder = /^_.*_$/.test(existing);
      sections[i].lines = ["", ...(placeholder ? [] : [existing]), body, ""].filter((l, k, a) => !(l === "" && a[k - 1] === ""));
    } else {
      sections[i].lines = ["", body, ""];
    }
  }
  return joinSections(sections);
}

// --- Pins: blocks a human marked as untouchable inside AI-maintained docs ----------

const PIN_RE = /<!--\s*pin\s*-->[\s\S]*?<!--\s*\/pin\s*-->/g;
export function enforcePins(oldMd, newMd) {
  const pins = oldMd.match(PIN_RE) || [];
  const missing = pins.filter(p => !newMd.includes(p));
  if (!missing.length) return { content: newMd, restored: 0 };
  // Put missing pins back right under the title.
  const lines = newMd.split("\n");
  const at = lines.findIndex(l => /^#\s/.test(l));
  lines.splice(at + 1, 0, "", ...missing);
  return { content: lines.join("\n"), restored: missing.length };
}

// --- Docs: brief, instructions, playbooks ----------------------------------------

export const docPath = (slug, kind, task) =>
  kind === "brief" ? P(slug, "brief.md") : kind === "instructions" ? P(slug, "instructions.md") : P(slug, "playbooks", `${slugify(task)}.md`);

export function readDoc(slug, kind, task) { return repo.read(docPath(slug, kind, task)); }

export function listPlaybooks(slug) {
  return repo.list(P(slug, "playbooks")).filter(d => d.isFile() && d.name.endsWith(".md")).map(d => d.name.replace(/\.md$/, "")).sort();
}

function checkDocWrite(kind, actor) {
  if (kind === "instructions" && actor !== "human") throw new PermissionError("Only humans can edit instructions. Submit a proposal instead.");
  if (!["brief", "instructions", "playbook"].includes(kind)) throw new Error(`Unknown doc kind ${kind}`);
}

// Full-body write (humans editing on the dashboard, or conductor creating a new playbook).
export async function writeDoc(slug, kind, { task, content, actor, message }) {
  checkDocWrite(kind, actor);
  const rel = docPath(slug, kind, task);
  const old = repo.read(rel) || "";
  let body = content.replace(/\r/g, "");
  let restored = 0;
  if (actor !== "human") ({ content: body, restored } = enforcePins(old, body));
  const sha = await repo.commit({ [rel]: body.endsWith("\n") ? body : body + "\n" }, message || `Edit ${rel}`, actor);
  if (sha) emit("doc", { slug, kind, task: task ? slugify(task) : null, sha, actor });
  return { sha, restoredPins: restored };
}

// Section-level edit (what the conductor uses): small diffs, less drift.
export async function editDoc(slug, kind, { task, edits, actor, message }) {
  checkDocWrite(kind, actor);
  const rel = docPath(slug, kind, task);
  const old = repo.read(rel);
  if (old === null) throw new Error(`${rel} doesn't exist`);
  return writeDoc(slug, kind, { task, content: patchMarkdown(old, edits), actor, message });
}

// --- Decisions: append-only ----------------------------------------------------------

function parseDecision(raw, file) {
  const m = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  const meta = {};
  if (m) for (const line of m[1].split("\n")) { const i = line.indexOf(":"); if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim(); }
  return { id: meta.id || file.replace(/\.md$/, ""), title: meta.title || "", date: meta.date, by: meta.by, supersedes: meta.supersedes || null, body: (m ? m[2] : raw).trim() };
}

export function listDecisions(slug) {
  const ds = repo.list(P(slug, "decisions")).filter(d => d.isFile() && d.name.endsWith(".md"))
    .map(d => parseDecision(repo.read(P(slug, "decisions", d.name)), d.name)).sort((a, b) => a.id.localeCompare(b.id));
  const supersededBy = {};
  for (const d of ds) if (d.supersedes) supersededBy[d.supersedes] = d.id;
  return ds.map(d => ({ ...d, status: supersededBy[d.id] ? "superseded" : "active", supersededBy: supersededBy[d.id] || null }));
}

export async function addDecision(slug, { title, body, supersedes = null, actor }) {
  const existing = listDecisions(slug);
  if (supersedes && !existing.find(d => d.id === supersedes)) supersedes = null;
  const id = `D-${String(existing.length + 1).padStart(4, "0")}`;
  const rel = P(slug, "decisions", `${id}.md`);
  if (repo.exists(rel)) throw new Error("Decision ids are append-only");
  const clean = (s) => String(s).replace(/\n/g, " ").trim();
  const content = `---\nid: ${id}\ntitle: ${clean(title)}\ndate: ${now()}\nby: ${actor}\nsupersedes: ${supersedes || ""}\n---\n\n${String(body).trim()}\n`;
  const sha = await repo.commit({ [rel]: content }, `Decision ${id}: ${clean(title)}`, actor);
  emit("decision", { slug, id, sha });
  return { id, sha };
}

// --- Links -------------------------------------------------------------------------

export const LINK_KINDS = ["repo", "branch", "pr", "issue", "deploy", "design", "doc", "api", "other"];
export function listLinks(slug) { try { return JSON.parse(repo.read(P(slug, "links.json")) || "[]"); } catch { return []; } }

export async function addLinks(slug, links, actor) {
  const cur = listLinks(slug);
  const added = [];
  for (const l of links) {
    if (!l?.url || !/^https?:\/\//i.test(l.url)) continue;
    if (cur.find(c => c.url === l.url)) continue;
    const link = { id: `L-${Date.now().toString(36)}${added.length}`, label: String(l.label || l.url).slice(0, 120), url: l.url, kind: LINK_KINDS.includes(l.kind) ? l.kind : "other", addedBy: actor, addedAt: now() };
    cur.push(link); added.push(link);
  }
  if (!added.length) return [];
  await repo.commit({ [P(slug, "links.json")]: JSON.stringify(cur, null, 2) + "\n" }, `Add ${added.length} link(s): ${added.map(l => l.label).join(", ")}`.slice(0, 200), actor);
  emit("links", { slug });
  return added;
}

export async function removeLink(slug, id, actor) {
  if (actor !== "human") throw new PermissionError("Only humans can remove links.");
  const cur = listLinks(slug); const l = cur.find(x => x.id === id); if (!l) return;
  await repo.commit({ [P(slug, "links.json")]: JSON.stringify(cur.filter(x => x.id !== id), null, 2) + "\n" }, `Remove link ${l.label}`, actor);
  emit("links", { slug });
}

// --- Files: read-only to AI, never overwritten ---------------------------------------

export function listFiles(slug) {
  return repo.list(P(slug, "files")).filter(d => d.isFile()).map(d => ({ name: d.name, size: repo.readBuffer(P(slug, "files", d.name)).length })).sort((a, b) => a.name.localeCompare(b.name));
}
export function readFile(slug, name) { return repo.readBuffer(P(slug, "files", path.basename(name))); }

export async function addFile(slug, name, buffer, actor) {
  let safe = path.basename(name).replace(/[^\w.\- ]+/g, "_").slice(0, 100) || "file";
  const ext = path.extname(safe), base = safe.slice(0, safe.length - ext.length);
  for (let i = 2; repo.exists(P(slug, "files", safe)); i++) safe = `${base}-${i}${ext}`;
  const sha = await repo.commit({ [P(slug, "files", safe)]: buffer }, `Add file ${safe}`, actor);
  emit("files", { slug });
  return { name: safe, sha };
}

export async function deleteFile(slug, name, actor) {
  if (actor !== "human") throw new PermissionError("Only humans can remove files.");
  await repo.commit({ [P(slug, "files", path.basename(name))]: null }, `Remove file ${name} (recoverable from history)`, actor);
  emit("files", { slug });
}

// --- History, snapshots, restore -------------------------------------------------------

export const history = (rel, limit) => repo.log(rel, limit);
export const versionAt = (sha, rel) => repo.show(sha, rel);
export const projectHistory = (slug, limit = 100) => repo.log(P(slug), limit);

export async function snapshot(slug, label, actor, auto = false) {
  const stamp = now().replace(/[-:]/g, "").replace(/\..*/, "").replace("T", "-");
  const name = `${auto ? "auto" : "snap"}/${slug}/${stamp}${label ? "-" + slugify(label).slice(0, 30) : ""}`;
  await repo.tag(name, label || (auto ? "Automatic snapshot" : "Snapshot"), actor);
  emit("snapshot", { slug, name });
  if (process.env.HIVEMIND_BACKUP_REMOTE) repo.pushBackup(process.env.HIVEMIND_BACKUP_REMOTE).catch(e => console.error("[backup]", e.message));
  return name;
}

export async function listSnapshots(slug) {
  const [manual, auto] = await Promise.all([repo.tags(`snap/${slug}/`), repo.tags(`auto/${slug}/`)]);
  return [...manual.map(t => ({ ...t, auto: false })), ...auto.map(t => ({ ...t, auto: true }))].sort((a, b) => b.at.localeCompare(a.at));
}

// Restore never destroys anything: it writes the old content as a NEW commit.
export async function restoreFile(rel, ref, actor) {
  if (actor !== "human") throw new PermissionError("Only humans can restore versions.");
  const content = await repo.show(ref, rel);
  if (content === null) throw new Error("That version doesn't exist");
  const sha = await repo.commit({ [rel]: content }, `Restore ${rel} to ${ref.slice(0, 40)}`, actor);
  emit("doc", { restored: true, rel, sha });
  return sha;
}

export async function restoreSnapshot(slug, tag, actor) {
  if (actor !== "human") throw new PermissionError("Only humans can restore snapshots.");
  await snapshot(slug, "before-restore", "system", true);
  const then = await repo.filesAt(tag, P(slug));
  const nowFiles = await repo.filesAt("HEAD", P(slug));
  const files = {};
  for (const rel of then) files[rel] = Buffer.from(await repo.raw(["show", `${tag}:${rel}`], {}), "utf8");
  for (const rel of nowFiles) if (!then.includes(rel)) files[rel] = null;
  const sha = await repo.commit(files, `Restore ${slug} to snapshot ${tag}`, actor);
  emit("doc", { slug, restored: true, sha });
  return sha;
}

// --- Conductor batch: everything one run changes, as ONE commit -------------------------
// Instructions are deliberately not accepted here: the conductor can only propose those.

export async function commitBatch(slug, { briefEdits = [], playbookEdits = [], decisions = [], links = [], message, actor = "conductor" }) {
  const files = {};
  const changed = { brief: false, playbooks: [], decisions: [], links: [], restoredPins: 0 };

  if (briefEdits.length) {
    const rel = docPath(slug, "brief");
    const old = repo.read(rel) || "";
    const { content, restored } = enforcePins(old, patchMarkdown(old, briefEdits));
    if (content !== old) { files[rel] = content; changed.brief = true; changed.restoredPins += restored; }
  }

  const byTask = {};
  for (const e of playbookEdits) { const t = slugify(e.task); (byTask[t] ||= []).push(e); }
  for (const [task, edits] of Object.entries(byTask)) {
    const rel = docPath(slug, "playbook", task);
    const old = repo.read(rel);
    let next = old;
    for (const e of edits) {
      if (e.op === "create" || next === null) next = e.op === "create" ? e.content : `# Playbook: ${task}\n\n` + patchMarkdown("", [{ ...e, op: e.op === "delete" ? "replace" : e.op }]);
      else next = patchMarkdown(next, [e]);
    }
    if (old !== null) { const r = enforcePins(old, next); next = r.content; changed.restoredPins += r.restored; }
    if (next && next !== old) { files[rel] = next.endsWith("\n") ? next : next + "\n"; changed.playbooks.push(task); }
  }

  let n = listDecisions(slug).length;
  const known = new Set(listDecisions(slug).map(d => d.id));
  for (const d of decisions) {
    if (!d?.title) continue;
    const id = `D-${String(++n).padStart(4, "0")}`;
    const sup = d.supersedes && known.has(d.supersedes) ? d.supersedes : "";
    const clean = (s) => String(s).replace(/\n/g, " ").trim();
    files[P(slug, "decisions", `${id}.md`)] = `---\nid: ${id}\ntitle: ${clean(d.title)}\ndate: ${now()}\nby: ${actor}\nsupersedes: ${sup}\n---\n\n${String(d.body || "").trim()}\n`;
    known.add(id);
    changed.decisions.push(id);
  }

  if (links.length) {
    const cur = listLinks(slug);
    for (const l of links) {
      if (!l?.url || !/^https?:\/\//i.test(l.url) || cur.find(c => c.url === l.url)) continue;
      const link = { id: `L-${Date.now().toString(36)}${changed.links.length}`, label: String(l.label || l.url).slice(0, 120), url: l.url, kind: LINK_KINDS.includes(l.kind) ? l.kind : "other", addedBy: actor, addedAt: now() };
      cur.push(link); changed.links.push(link);
    }
    if (changed.links.length) files[P(slug, "links.json")] = JSON.stringify(cur, null, 2) + "\n";
  }

  const sha = Object.keys(files).length ? await repo.commit(files, message || "Conductor update", actor) : null;
  if (sha) emit("doc", { slug, sha, actor, batch: true });
  return { sha, ...changed };
}

// --- Briefing: what an agent gets when it starts a task ----------------------------------

export function briefing(slug, task) {
  const p = getProject(slug);
  const t = task ? slugify(task) : null;
  const playbook = t ? readDoc(slug, "playbook", t) : null;
  return {
    project: p,
    instructions: readDoc(slug, "instructions"),
    playbook, task: t,
    otherPlaybooks: listPlaybooks(slug).filter(x => x !== t),
    brief: readDoc(slug, "brief"),
    decisions: listDecisions(slug).filter(d => d.status === "active"),
    links: listLinks(slug),
    files: listFiles(slug),
  };
}
