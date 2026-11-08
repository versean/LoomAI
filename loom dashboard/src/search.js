// Search across the brain (git grep over markdown/files) and the operational log (SQLite).
import * as brain from "./store/brain.js";
import { sql } from "./store/db.js";

// scope (optional, for agents): { agent, projects } limits results to readable projects and to
// messages the agent is part of. Humans on the dashboard pass no scope and see everything.
export async function search(query, slug = null, scope = null, limit = 30) {
  const q = String(query || "").trim();
  if (!q) return [];
  if (scope && slug && !scope.projects.includes(slug)) return [];
  const hits = [];
  const allowed = (project) => !scope || (project && scope.projects.includes(project));

  // Brain: git grep is fast and searches exactly what's committed.
  try {
    const out = await brain.repo.raw(["grep", "-n", "-i", "-I", "-F", "-e", q, "--", slug ? `projects/${slug}` : "projects"]);
    for (const line of out.split("\n").filter(Boolean).slice(0, 200)) {
      const m = line.match(/^projects\/([^/]+)\/(.+?):(\d+):(.*)$/);
      if (!m) continue;
      const [, project, file, ln, textLine] = m;
      if (!allowed(project)) continue;
      const type = file === "brief.md" ? "brief" : file === "instructions.md" ? "instructions" : file.startsWith("playbooks/") ? "playbook" : file.startsWith("decisions/") ? "decision" : file.startsWith("files/") ? "file" : "meta";
      hits.push({ type, project, title: file.replace(/^playbooks\//, "").replace(/\.md$/, ""), path: file, line: Number(ln), snippet: textLine.trim().slice(0, 220) });
    }
  } catch { /* git grep exits 1 on no matches */ }

  const like = `%${q.replace(/[%_]/g, "\\$&")}%`;
  const logs = sql.prepare(`SELECT id, kind, project, agent, title, summary, payload, at FROM log WHERE (payload LIKE ? ESCAPE '\\' OR summary LIKE ? ESCAPE '\\' OR title LIKE ? ESCAPE '\\') ${slug ? "AND project = ?" : ""} ORDER BY at DESC LIMIT 20`)
    .all(...[like, like, like, ...(slug ? [slug] : [])]);
  for (const r of logs) if (allowed(r.project)) hits.push({ type: r.kind, project: r.project, title: `${r.agent}${r.title ? `: ${r.title}` : ""}`, id: r.id, at: r.at, snippet: (r.summary || JSON.parse(r.payload)?.summary || "").slice(0, 220) });

  const msgs = sql.prepare(`SELECT * FROM messages WHERE text LIKE ? ESCAPE '\\' ${slug ? "AND project = ?" : ""} ORDER BY at DESC LIMIT 15`).all(...[like, ...(slug ? [slug] : [])]);
  // Agents only find messages they sent or received, or broadcasts in projects they can read.
  const mine = (m) => !scope || m.sender === scope.agent || m.recipient === scope.agent || (m.recipient === "*" && (!m.project || scope.projects.includes(m.project)));
  for (const m of msgs) if (mine(m)) hits.push({ type: "message", project: m.project, title: `${m.sender} → ${m.recipient}`, at: m.at, snippet: m.text.slice(0, 220) });

  return hits.slice(0, limit);
}
