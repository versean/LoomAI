// The Conductor: the AI that curates the brain.
//
// It waits for a quiet moment (or a full batch), groups queued items by project, and for each
// project makes ONE Claude call that returns section-level edits:
//   brief edits · playbook edits · new decisions · links · instruction PROPOSALS · teammate notifications
// Everything it writes lands as one git commit, after an automatic snapshot. It cannot touch
// instructions, files, history, or snapshots: the store refuses.

import * as brain from "./store/brain.js";
import * as db from "./store/db.js";
import { subscribe, emit } from "./bus.js";
import { client, MODEL, friendlyError, isConfigError } from "./llm.js";
import * as gateway from "./gateway.js";
import * as access from "./access.js";

const QUIET_MS = Number(process.env.HIVEMIND_BATCH_QUIET_MS || 6000);   // wait this long after the last push
const MAX_WAIT_MS = Number(process.env.HIVEMIND_BATCH_MAX_MS || 30000); // but never longer than this
const MAX_ITEMS = 12;

const SYSTEM = `You are the Conductor of Loom, the shared brain for a team of AI coding agents and their humans.

Agents push structured updates, log conversations, and message each other. You keep each project's knowledge accurate
and useful by making SMALL, SECTION-LEVEL edits. The project is stored as:

- BRIEF (brief.md): the main context. What the project is, current state, architecture, who's on what, open questions.
  Concise and factual. Remove things that are no longer true. Never invent details.
  Blocks wrapped in <!-- pin --> ... <!-- /pin --> were pinned by a human: never change or remove them.
- PLAYBOOKS (one per task area, e.g. "website", "api", "deploy"): the briefing an agent receives when it starts that
  task. Written as instructions to an agent: goals right now, conventions, relevant files/endpoints, pitfalls, and what
  teammates are doing that affects this task. Create a playbook the first time a new task area shows up.
- DECISIONS: append-only records ("we chose X because Y"). Add one only for real, durable decisions (an API contract,
  a library choice, a rule). If it replaces an earlier decision, set supersedes to that id. Never restate existing ones.
- LINKS: repo, branches, PRs, deploy URLs, designs. Add any URL that appears in an update and is useful to keep.
- INSTRUCTIONS: the team's rules. You CANNOT edit them. If an item clearly implies a rule change, add a proposal;
  a human approves it. Use this sparingly.
- NOTIFY: when an item contains a breaking change or something another agent must know NOW, send a short message
  to that agent (by name) or "*" for everyone. Don't notify the agent who caused it. Don't repeat what they already said
  to each other in messages.

Edits: heading is an H2 title in the target doc (without "##"). op "replace" rewrites that section (creates it if missing),
"append" adds lines to it, "delete" removes it. For a NEW playbook use op "create" with the full markdown (start with a
"# Playbook: <task>" title) and heading "". Prefer the fewest edits that keep the docs correct. Write summaries in 1-2
sentences, for a teammate.`;

const S = { type: "string" };
const OUTPUT_SCHEMA = {
  type: "json_schema",
  schema: {
    type: "object", additionalProperties: false,
    required: ["summaries", "brief_edits", "playbook_edits", "decisions", "links", "instruction_proposals", "notify", "commit_message"],
    properties: {
      summaries: { type: "array", items: { type: "object", additionalProperties: false, required: ["item_id", "summary"], properties: { item_id: S, summary: S } } },
      brief_edits: { type: "array", items: { type: "object", additionalProperties: false, required: ["op", "heading", "content"], properties: { op: { type: "string", enum: ["replace", "append", "delete"] }, heading: S, content: S } } },
      playbook_edits: { type: "array", items: { type: "object", additionalProperties: false, required: ["task", "op", "heading", "content"], properties: { task: S, op: { type: "string", enum: ["create", "replace", "append", "delete"] }, heading: S, content: S } } },
      decisions: { type: "array", items: { type: "object", additionalProperties: false, required: ["title", "body", "supersedes"], properties: { title: S, body: S, supersedes: { type: ["string", "null"] } } } },
      links: { type: "array", items: { type: "object", additionalProperties: false, required: ["label", "url", "kind"], properties: { label: S, url: S, kind: { type: "string", enum: brain.LINK_KINDS } } } },
      instruction_proposals: { type: "array", items: { type: "object", additionalProperties: false, required: ["op", "heading", "content", "reason"], properties: { op: { type: "string", enum: ["replace", "append", "delete"] }, heading: S, content: S, reason: S } } },
      notify: { type: "array", items: { type: "object", additionalProperties: false, required: ["to", "text"], properties: { to: S, text: S } } },
      commit_message: { type: "string", description: "One-line git commit message describing what changed in the docs." },
    },
  },
};

const ROUTE_SCHEMA = {
  type: "json_schema",
  schema: {
    type: "object", additionalProperties: false, required: ["project", "new_project_name", "new_project_description"],
    properties: {
      project: { type: "string", description: "Existing project slug, 'new' to create one, or 'none' if this isn't about any project." },
      new_project_name: { type: ["string", "null"] },
      new_project_description: { type: ["string", "null"] },
    },
  },
};

// --- Rendering context ---------------------------------------------------------------

function renderItem(item) {
  if (item.kind === "message") {
    const m = db.getMessage(item.refId);
    return m && { id: item.refId, text: `### Item ${item.refId}: MESSAGE ${m.sender} → ${m.recipient}\n${m.text}` };
  }
  const e = db.getLog(item.refId);
  if (!e) return null;
  if (e.kind === "conversation") {
    let t = e.payload?.transcript || "";
    if (t.length > 20000) t = t.slice(0, 10000) + "\n[… truncated …]\n" + t.slice(-10000);
    return { id: e.id, text: `### Item ${e.id}: CONVERSATION logged by ${e.agent}${e.title ? ` — "${e.title}"` : ""}\n${t}` };
  }
  const p = e.payload || {};
  const list = (label, arr) => arr?.length ? `**${label}:**\n${arr.map(x => `- ${x}`).join("\n")}\n` : "";
  return { id: e.id, text: `### Item ${e.id}: PUSH from ${e.agent}${e.task ? ` (task: ${e.task})` : ""}\n` +
    `**Summary:** ${p.summary || "(none)"}\n` + list("Changes", p.changes) + list("Decisions", p.decisions) +
    list("BREAKING changes", p.breaking_changes) + list("Files touched", p.files_touched) + list("Next steps", p.next_steps) +
    list("Links", p.links) + (p.branch ? `**Branch:** ${p.branch}${p.commit ? ` @ ${p.commit}` : ""}\n` : "") + (p.notes ? `**Notes:**\n${p.notes}\n` : "") };
}

function renderProject(slug) {
  const b = brain.briefing(slug, null);
  const playbooks = brain.listPlaybooks(slug).map(t => `#### playbook: ${t}\n${brain.readDoc(slug, "playbook", t)}`).join("\n\n");
  const agents = db.listAgents().filter(a => a.project === slug).map(a => `- ${a.name}: ${a.task || "?"} (seen ${a.lastSeen})`).join("\n");
  const gh = db.getGithub(slug)?.data;
  const ghText = gh ? `\n### GitHub (${gh.repo})\nRecent commits:\n${(gh.commits || []).slice(0, 8).map(c => `- ${c.sha} ${c.message} (${c.author})`).join("\n")}\nOpen PRs:\n${(gh.pulls || []).map(p => `- #${p.number} ${p.title} [${p.branch}] by ${p.author}`).join("\n") || "none"}\n` : "";
  return `## Project "${b.project.name}" (slug: ${slug})\n${b.project.description}\n\n### INSTRUCTIONS (read-only to you)\n${b.instructions}\n\n### BRIEF\n${b.brief}\n\n### PLAYBOOKS\n${playbooks || "_none yet_"}\n\n` +
    `### ACTIVE DECISIONS\n${b.decisions.map(d => `- ${d.id}: ${d.title}`).join("\n") || "_none_"}\n\n### LINKS\n${b.links.map(l => `- [${l.kind}] ${l.label}: ${l.url}`).join("\n") || "_none_"}\n\n` +
    `### FILES\n${b.files.map(f => `- ${f.name}`).join("\n") || "_none_"}\n${ghText}\n### AGENTS ON THIS PROJECT\n${agents || "_none_"}`;
}

// --- Model calls ------------------------------------------------------------------------

async function call(messages, { format, effort = "medium", max_tokens = 16000 }) {
  const response = await client.messages.create({
    model: MODEL, max_tokens,
    system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }],
    output_config: { ...(format ? { format } : {}), effort },
    messages,
  });
  if (response.stop_reason === "refusal") throw new Error(`Conductor declined: ${response.stop_details?.explanation || "no explanation"}`);
  if (response.stop_reason === "max_tokens") throw new Error("Conductor output was cut off (max_tokens)");
  const text = response.content.filter(b => b.type === "text").map(b => b.text).join("");
  return { text, usage: response.usage };
}

// Who wrote a queued item, and may they change this project's knowledge?
// Humans (dashboard) may write anywhere; agents only where they hold write access.
function authorOf(item) { return item.kind === "message" ? db.getMessage(item.refId)?.sender : db.getLog(item.refId)?.agent; }
const isHuman = (a) => a === "human" || a === "conductor";
const authorCanWrite = (item, slug) => { const a = authorOf(item); return !!a && (isHuman(a) || access.can(a, slug, "write")); };

async function route(item) {
  const r = renderItem(item);
  if (!r) return "none";
  const author = authorOf(item);
  // The Overseer may only route an agent's item into projects that agent can write.
  const candidates = brain.listProjects().filter(p => isHuman(author) || access.can(author, p.slug, "write"));
  const projects = candidates.map(p => `- ${p.slug}: ${p.name} — ${p.description}`).join("\n") || "_none_";
  const { text } = await call([{ role: "user", content: `Existing projects:\n${projects}\n\nWhich project does this item belong to?\n\n${r.text}` }], { format: ROUTE_SCHEMA, effort: "low", max_tokens: 2000 });
  const out = JSON.parse(text);
  if (out.project === "none") return "none";
  if (candidates.some(p => p.slug === out.project)) return out.project;
  if (out.project === "new" && out.new_project_name && !brain.getProject(out.new_project_name)) {
    const p = await brain.createProject({ name: out.new_project_name, description: out.new_project_description || "", actor: "conductor" });
    if (!isHuman(author)) access.set(author, p.slug, "write", "conductor");
    db.activity("conductor", "project", `Created project **${p.name}**`, { project: p.slug });
    return p.slug;
  }
  return "none";
}

async function runBatch(slug, items) {
  const started = Date.now();
  const rendered = items.map(renderItem).filter(Boolean);
  if (!rendered.length) return;
  const who = [...new Set(rendered.map(r => r.text.match(/from (\S+)|MESSAGE (\S+)|by (\S+)/)?.slice(1).find(Boolean)).filter(Boolean))];
  db.activity("conductor", "thinking", `Processing ${rendered.length} item${rendered.length > 1 ? "s" : ""} for **${slug}**${who.length ? ` from ${who.join(", ")}` : ""}`, { project: slug });

  // Safety net first: a frozen copy of the project before anything changes (and before spending a model call).
  await brain.snapshot(slug, "pre-conductor", "conductor", true);

  const { text, usage } = await call([{ role: "user", content: `${renderProject(slug)}\n\n---\n\n# NEW ITEMS (${rendered.length})\n\n${rendered.map(r => r.text).join("\n\n")}\n\n---\nUpdate the project's knowledge for these items.` }], { format: OUTPUT_SCHEMA });
  const out = JSON.parse(text);

  const result = await brain.commitBatch(slug, {
    briefEdits: out.brief_edits, playbookEdits: out.playbook_edits, decisions: out.decisions, links: out.links,
    message: out.commit_message || "Conductor update", actor: "conductor",
  });

  for (const s of out.summaries) if (db.getLog(s.item_id)) db.setLogMeta(s.item_id, { summary: s.summary, project: slug });
  for (const pr of out.instruction_proposals) {
    const p = db.addProposal({ project: slug, ...pr });
    db.activity("conductor", "proposal", `Proposed an instructions change: **${pr.heading}**, waiting for approval`, { project: slug, proposal: p.id });
  }
  const known = new Set(db.listAgents().map(a => a.name));
  for (const n of out.notify) {
    if (n.to !== "*" && !known.has(n.to)) continue;
    db.addMessage({ from: "conductor", to: n.to, text: n.text, project: slug, auto: true, queue: false });
    db.activity("conductor", "notify", `Notified **${n.to === "*" ? "everyone" : n.to}**: ${n.text}`, { project: slug });
  }

  const parts = [];
  if (result.brief) parts.push("brief");
  if (result.playbooks.length) parts.push(`playbook${result.playbooks.length > 1 ? "s" : ""} ${result.playbooks.join(", ")}`);
  if (result.decisions.length) parts.push(`${result.decisions.join(", ")}`);
  if (result.links.length) parts.push(`${result.links.length} link${result.links.length > 1 ? "s" : ""}`);
  const short = result.sha ? result.sha.slice(0, 7) : null;
  db.activity("conductor", result.sha ? "commit" : "noop",
    result.sha ? `\`${short}\` ${out.commit_message}${parts.length ? ` · ${parts.join(" · ")}` : ""}${result.restoredPins ? ` · restored ${result.restoredPins} pinned block(s)` : ""}` : "Nothing in the docs needed to change",
    { project: slug, sha: result.sha });

  gateway.record({
    actor: "conductor", actorKind: "overseer", channel: "internal", client: MODEL, action: "overseer.update", project: slug,
    resource: result.sha ? `commit:${result.sha.slice(0, 7)}` : "no changes", outcome: "allowed", status: 200, ms: Date.now() - started,
    detail: { items: rendered.length, brief: result.brief, playbooks: result.playbooks, decisions: result.decisions, links: result.links.length, proposals: out.instruction_proposals.length, notified: out.notify.length },
  });

  db.addRun({ project: slug, items: rendered.length, notes: out.commit_message, sha: result.sha, ms: Date.now() - started, tokensIn: (usage.input_tokens || 0) + (usage.cache_read_input_tokens || 0) + (usage.cache_creation_input_tokens || 0), tokensOut: usage.output_tokens || 0, ok: true });
}

// --- Worker loop -------------------------------------------------------------------------

let wake = null;
let paused = false;
export const status = () => ({ paused, queue: db.queueLength() });

export function start() {
  subscribe((event) => { if (event === "queue" && wake) wake(); });
  loop();
}

const sleep = (ms) => new Promise(r => { wake = r; setTimeout(r, ms); });

async function loop() {
  for (;;) {
    const items = db.peekQueue(MAX_ITEMS);
    if (!items.length) { await sleep(10000); wake = null; continue; }

    // Batch window: wait for quiet, but not forever.
    const newest = Math.max(...items.map(i => Date.parse(i.at)));
    const oldest = Date.parse(db.oldestQueued());
    if (items.length < MAX_ITEMS && Date.now() - newest < QUIET_MS && Date.now() - oldest < MAX_WAIT_MS) {
      await new Promise(r => setTimeout(r, 1000));
      continue;
    }

    try {
      // Route items with no project.
      for (const it of items.filter(i => !i.project)) {
        const slug = await route(it);
        if (slug === "none") { db.dequeue([it.id]); continue; }
        it.project = slug;
        db.setQueueProject(it.id, slug);
        if (it.kind !== "message") db.setLogMeta(it.refId, { project: slug });
      }
      const groups = {};
      for (const it of items.filter(i => i.project)) (groups[it.project] ||= []).push(it);
      for (const [slug, group] of Object.entries(groups)) {
        if (!brain.getProject(slug)) { db.dequeue(group.map(g => g.id)); continue; }
        // Items from agents without write access (e.g. a read-only agent's message) are delivered
        // to their recipients but never folded into project knowledge.
        const writable = group.filter(g => authorCanWrite(g, slug));
        const skipped = group.filter(g => !writable.includes(g));
        if (skipped.length) {
          db.dequeue(skipped.map(g => g.id));
          gateway.record({ actor: "conductor", actorKind: "overseer", channel: "internal", action: "overseer.update", project: slug, outcome: "denied", status: 403, reason: `Skipped ${skipped.length} item(s) from agents without write access`, detail: { skipped: skipped.length, from: [...new Set(skipped.map(authorOf))] } });
        }
        if (writable.length) await runBatch(slug, writable);
        db.dequeue(writable.map(g => g.id));
      }
      if (paused) { paused = false; emit("conductor", status()); }
    } catch (err) {
      console.error("[conductor]", err);
      const msg = friendlyError(err);
      gateway.record({ actor: "conductor", actorKind: "overseer", channel: "internal", client: MODEL, action: "overseer.update", project: items[0]?.project || null, outcome: "error", status: 500, reason: msg, detail: { items: items.length } });
      if (isConfigError(err)) {
        if (!paused) { paused = true; db.activity("conductor", "error", `Paused: ${msg}`); emit("conductor", status()); }
        await sleep(60000); wake = null;
      } else {
        db.bumpAttempts(items.map(i => i.id));
        const dead = items.filter(i => i.attempts + 1 >= 3);
        if (dead.length) db.dequeue(dead.map(d => d.id));
        db.activity("conductor", "error", `Run failed: ${msg}${dead.length ? ` (dropped ${dead.length} item(s) after 3 tries)` : " (will retry)"}`);
        db.addRun({ project: items[0]?.project, items: items.length, notes: msg, sha: null, ms: 0, tokensIn: 0, tokensOut: 0, ok: false });
        await new Promise(r => setTimeout(r, 5000));
      }
    }
  }
}

// --- Q&A for agents (ask_conductor tool) ------------------------------------------------------

export async function answer(question, agent, slug, allowedSlugs = null) {
  const scope = brain.listProjects().filter(p => !allowedSlugs || allowedSlugs.includes(p.slug));
  const ctx = slug && brain.getProject(slug) ? renderProject(slug) : scope.map(p => renderProject(p.slug)).join("\n\n---\n\n") || "_No projects available to this agent._";
  const { text } = await call([{ role: "user", content: `${ctx}\n\n---\nAgent "${agent}" asks: ${question}\n\nAnswer directly and briefly in markdown, using only what the brain knows. Cite decision ids or file names when relevant. If the brain doesn't know, say so.` }], { effort: "low", max_tokens: 4000 });
  return text;
}
