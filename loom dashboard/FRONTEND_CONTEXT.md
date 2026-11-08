# Hivemind — Frontend Build Context

You are building the **web dashboard** for Hivemind. The backend is done and running; this file is everything you need to build the UI against it. Don't change the backend API; if something is missing, note it.

---

## 1. What Hivemind is

**A shared brain for a team's AI coding agents.** Built for an AWS hackathon.

- Every developer's AI agent (Claude Code, Cursor, Claude Desktop…) connects to one **hub** over **MCP** (Model Context Protocol).
- Agents **pull** a briefing before starting a task ("website", "api", …) and **push** structured updates as they work.
- A **Conductor AI** (Claude, running on Amazon Bedrock or the Anthropic API) reads every push, conversation, and agent-to-agent message, and keeps the project's knowledge up to date with small, section-level edits.
- Agents can **message each other directly** through the hub. The conductor reads those too, and auto-notifies agents about breaking changes.
- **Everything is versioned in git.** Every edit is a commit with an author (`conductor`, `human`, or the agent's name). **Snapshots** are git tags. Nothing the AI does can delete history or backups.

The dashboard is for the **humans** on the team: watch the hive work live, read and edit the knowledge, approve the conductor's proposals, browse history and diffs, take or restore snapshots, and chat with agents.

### The demo story (design for this moment)

1. Alice's agent changes the signup API and `/push`es it, flagging a breaking change.
2. Within seconds the conductor commits: updates the project brief, creates an "api" playbook, updates bob's "website" playbook, records a decision, saves the PR link, and **auto-messages bob** about the break.
3. Bob's agent `/pull`s its website briefing and already knows about alice's change.
4. On the dashboard you see all of it live: the activity stream, the commit with its diff, the notification in agent chat, the new decision.

The **live activity stream** and **commit diffs** are the money shots. Make them feel alive.

---

## 2. Data model: what a project contains

Each project is a folder in a git repo with these **sections**. Permissions are enforced by the server; the UI should *show* them (lock icons, "AI-maintained", "humans only", etc.).

| Section | What it is | Who can edit | UI notes |
|---|---|---|---|
| **Brief** | Main context doc (markdown): current state, architecture, who's on what, open questions | Conductor maintains; humans can edit | Humans can **pin** blocks by wrapping them in `<!-- pin -->` … `<!-- /pin -->`; the conductor must keep pinned blocks word for word. Render pinned blocks distinctly (pin icon, border). |
| **Instructions** | Team rules every agent must follow (markdown) | **Humans only.** The conductor can only *propose* changes | Lock badge. Show pending proposal count. |
| **Playbooks** | One markdown doc per task area (`website`, `api`, `deploy`…), the briefing an agent gets when it starts that task | Conductor maintains; humans can edit | List of tasks; conductor creates new ones automatically. |
| **Decisions** | Append-only records `D-0001`, `D-0002`… ("we chose X because Y") | Anyone can **add**; nobody can edit or delete | A decision can **supersede** an earlier one. Show status `active` / `superseded` (with link to the newer one). Timeline/ledger feel. |
| **Links** | Structured links: `repo`, `branch`, `pr`, `issue`, `deploy`, `design`, `doc`, `api`, `other` | Anyone adds; **only humans remove** | Group or icon by kind. A `repo` link to GitHub enables GitHub sync. |
| **Files** | Reference files (specs, schemas, notes, images) | Humans/agents upload; **never overwritten** (name collisions get `-2` suffix); AI read-only; only humans delete (and deleted files stay in git history) | Upload (raw body), download, delete. |
| **Approvals** | Conductor's proposed changes to Instructions | Humans approve/reject | Inbox with diff-like preview: op (`replace`/`append`/`delete`), heading, content, reason. |
| **Log** | Raw append-only record of pushes and handoffs (conversations) | Append-only | Each has a conductor-written `summary` (null until processed → show "processing"). Push payloads are structured (see §4). |
| **History** | Git commits touching the project | Read-only | Commit list (short sha, author, subject, time). Click → per-file diff between versions. |
| **Snapshots** | Git tags. Manual (`snap/…`) or automatic (`auto/…`, taken before every conductor run) | Humans create/restore. **Nobody can delete** | Restore = non-destructive (writes a new commit; also auto-snapshots first). Confirm before restoring. |
| **GitHub** | Recent commits + open PRs from the linked repo (cached, refreshed every 10 min or on demand) | Read-only | Show `error` if sync failed. |

**Global (not per project):** agents (presence), agent chat messages, activity stream, conductor queue/status, conductor run stats.

---

## 3. Backend

- Base URL: `http://localhost:4100` (same origin, so all fetches are relative: `/api/...`).
- Plain Node `http` server, JSON in/out. Errors: `{ "error": "message" }` with 4xx/5xx. Permission violations return **403**.
- No auth on `/api` (local hackathon tool). `/mcp` may require a token (`tokenRequired` in state).
- Run: `npm start` (port 4100). Seed sample data: `npm run seed` (hub stopped). Simulate two agents: `npm run demo` (hub running; takes ~30s, conductor commits shortly after).
- The current dashboard is `public/index.html`; static files are served from `public/`. **Your build output must be static files served from `public/`** (plain HTML/JS/CSS, or a Vite build output copied there). No SSR.
- Already-vendored libs (served by the hub, no CDN needed):
  - `/vendor/marked.js`: marked v15 (ESM): `import { marked } from "/vendor/marked.js"`
  - `/vendor/purify.js`: DOMPurify v3 (ESM): `import DOMPurify from "/vendor/purify.js"`
  - **Always sanitize** rendered markdown with DOMPurify (content comes from AI and agents).

---

## 4. REST API

### Global

#### `GET /api/state`
Everything for the top-level views. Re-fetch on SSE events (debounced ~150ms).

```jsonc
{
  "provider": "Anthropic API · claude-opus-5-5",   // or "Amazon Bedrock (us-east-1) · anthropic.claude-opus-5-5"
  "conductor": { "paused": false, "queue": 0 },     // paused=true when credentials are missing/invalid
  "head": "a1b2c3d",                                 // current brain git HEAD (short sha)
  "stats": { "runs": 4, "items": 11, "tokensIn": 52000, "tokensOut": 6100, "avgMs": 14200 },
  "runs": [ { "id": "...", "at": "ISO", "project": "hackathon-site", "items": 5, "notes": "commit message or error",
              "sha": "full sha or null", "ms": 15000, "tokensIn": 13000, "tokensOut": 1500, "ok": 1 } ],
  "projects": [ {
      "slug": "hackathon-site", "name": "Hackathon Site", "description": "...", "createdAt": "ISO", "createdBy": "human",
      "playbooks": ["api", "website"], "decisions": 3, "files": 1, "links": 4,
      "pendingProposals": 0, "agents": ["alice", "bob"], "repo": "owner/name" | null
  } ],
  "agents": [ { "name": "alice", "project": "hackathon-site" | null, "task": "api" | null, "connectedAt": "ISO", "lastSeen": "ISO" } ],
  "messages": [ { "id": "...", "sender": "alice", "recipient": "bob" /* or "*" = everyone */, "text": "...",
                  "project": "hackathon-site" | null, "at": "ISO", "readAt": "ISO" | null, "auto": 0 | 1 /* 1 = sent by conductor */ } ],
  "activity": [ { "id": "...", "at": "ISO", "actor": "conductor" | "human" | "github" | "<agent>",
                  "type": "...", "text": "markdown-ish (uses **bold** and `code`)", "refs": { "project": "slug", "sha": "...", "log": "id", "proposal": "id" } } ],
  "queue": [ { "id": "...", "kind": "push" | "conversation" | "message", "refId": "...", "project": "slug" | null, "at": "ISO", "attempts": 0 } ],
  "tokenRequired": false
}
```

- `activity` is newest first (150 max). `messages` is oldest first (150 max).
- Activity `type` values: `thinking` (conductor started a run), `commit` (conductor committed; `refs.sha`), `noop`, `notify` (conductor messaged an agent), `proposal`, `project`, `error` (text starts with `Paused:` when credentials are missing), `answer`, `pull`, `push` (text ends with `⚠ breaking` if it had breaking changes), `handoff`, `message`, `file`, `question`, `edit`, `decision`, `link`, `snapshot`, `restore`, `github`.
- Agent online heuristic: `lastSeen` within ~10 min.
- Conductor visual state: **paused** if `conductor.paused`; **working** if latest conductor activity is `thinking` or `queue.length > 0`; else **idle**.

#### `GET /api/events`: Server-Sent Events
Live updates. Event names (payloads are small; just re-fetch state/project):
`activity`, `agent`, `message`, `log`, `queue`, `doc`, `decision`, `links`, `files`, `snapshot`, `proposal`, `project`, `run`, `github`, `conductor`.
- `activity` payload is the full activity entry: you can prepend it instantly without refetch.
- `doc` payload: `{ slug, sha, actor, batch? }`: a doc changed. Good moment to flash/highlight.

#### `GET /api/search?q=TEXT&project=SLUG?`
```jsonc
[ { "type": "brief" | "instructions" | "playbook" | "decision" | "file" | "meta" | "push" | "conversation" | "message",
    "project": "slug", "title": "...", "path": "playbooks/website.md" /* brain hits */, "line": 12, "snippet": "...", "at": "ISO" } ]
```
Great for a ⌘K command palette.

#### `GET /api/history?path=REL_PATH`
Commits touching a file. `REL_PATH` is relative to the brain repo, e.g. `projects/hackathon-site/brief.md`.
```jsonc
[ { "sha": "full", "short": "a1b2c3d", "author": "conductor", "at": "ISO", "subject": "commit message" } ]
```

#### `GET /api/version?sha=SHA&path=REL_PATH`
`{ "content": "file content at that commit" }` (404 if the file didn't exist then). Use two of these to diff versions client-side.

#### `POST /api/restore-file`  body `{ "path": REL_PATH, "ref": SHA_OR_TAG }`
Writes that old version as a **new** commit. Returns `{ sha }`.

#### `POST /api/messages`  body `{ "to": "alice" | "*", "text": "...", "project": "slug"? }`
Human → agent chat. Shows as sender `human`.

#### `POST /api/push`  body `{ "summary": "...", "notes": "markdown"?, "project": "slug"?, "task": "website"? }`
A human pushes an update for the conductor to process (same pipeline as agents).

#### `POST /api/projects`  body `{ "name": "...", "description": "..."?, "repo": "https://github.com/o/r"? }`
Creates a project (with default brief + instructions). Returns the project.

### Per project (`:slug`)

#### `GET /api/projects/:slug`
Everything for the project view:
```jsonc
{
  "project": { "slug", "name", "description", "createdAt", "createdBy" },
  "brief": "markdown",
  "instructions": "markdown",
  "playbooks": { "website": "markdown", "api": "markdown" },
  "decisions": [ { "id": "D-0001", "title": "...", "date": "ISO", "by": "human" | "conductor" | "<agent>",
                   "supersedes": "D-0000" | null, "body": "markdown", "status": "active" | "superseded", "supersededBy": "D-0003" | null } ],
  "links": [ { "id": "L-xyz", "label": "...", "url": "https://...", "kind": "repo|branch|pr|issue|deploy|design|doc|api|other", "addedBy": "...", "addedAt": "ISO" } ],
  "files": [ { "name": "signup-api-spec.md", "size": 312 } ],
  "proposals": [ { "id": "ab12cd34", "project": "slug", "op": "replace" | "append" | "delete", "heading": "Rules",
                   "content": "markdown", "reason": "...", "status": "pending" | "approved" | "rejected", "at": "ISO", "decidedAt": "ISO" | null, "sha": "..." | null } ],
  "github": null | { "project", "repo": "o/r", "fetchedAt": "ISO", "error": "msg" | null,
                     "data": { "repo", "url", "defaultBranch", "stars", "language",
                               "commits": [ { "sha": "abc1234", "message", "author", "at", "url" } ],
                               "pulls": [ { "number", "title", "author", "branch", "url", "draft", "at" } ] } },
  "repo": "o/r" | null,
  "log": [ { "id", "kind": "push" | "conversation", "project", "agent", "task": "api" | null, "title": "..." | null,
             "summary": "conductor summary" | null, "at": "ISO",
             "payload": /* push: */ { "summary", "changes": [], "decisions": [], "breaking_changes": [], "files_touched": [],
                                      "next_steps": [], "links": [], "branch", "commit", "notes" }
                        /* conversation: */ { "transcript": "..." } } ],
  "commits": [ { "sha", "short", "author", "at", "subject" } ],        // project history, newest first
  "snapshots": [ { "name": "snap/hackathon-site/20261107-203234-seed", "commit": "abc1234", "at": "ISO", "by": "human",
                   "message": "seed", "auto": false } ]
}
```
Brain file paths for history/version calls:
- brief: `projects/<slug>/brief.md`
- instructions: `projects/<slug>/instructions.md`
- playbook: `projects/<slug>/playbooks/<task>.md`
- links: `projects/<slug>/links.json`
- decisions: `projects/<slug>/decisions/D-0001.md`
- files: `projects/<slug>/files/<name>`
- whole project: `projects/<slug>` (works with `/api/history`)

#### `GET /api/projects/:slug/briefing?task=website`
`{ "markdown": "..." }`: exactly what an agent gets from `pull`. Nice "Preview as agent" feature.

#### `PATCH /api/projects/:slug`  body `{ "name"?, "description"? }`

#### `PUT /api/projects/:slug/docs`  body `{ "kind": "brief" | "instructions" | "playbook", "task": "website" /* playbook only */, "content": "full markdown", "message": "commit msg"? }`
Human edit. Returns `{ sha /* null if unchanged */, restoredPins: 0 }`.

#### `POST /api/projects/:slug/decisions`  body `{ "title", "body", "supersedes": "D-0001"? }` → `{ id, sha }`
#### `POST /api/projects/:slug/links`  body `{ "label", "url", "kind" }` → array of added links (empty if duplicate URL)
#### `DELETE /api/projects/:slug/links/:id`
#### `POST /api/projects/:slug/files?name=FILENAME`  **raw request body** = file bytes → `{ name /* final name */, sha }`
#### `GET /api/projects/:slug/files/:name`: raw file
#### `DELETE /api/projects/:slug/files/:name`
#### `POST /api/projects/:slug/snapshots`  body `{ "label": "before demo" }` → `{ name }`
#### `POST /api/projects/:slug/restore`  body `{ "tag": "snap/..." }` → `{ sha }` (confirm first!)
#### `POST /api/projects/:slug/github/sync` → GitHub data or `502 { error }`
#### `POST /api/proposals/:id/approve` | `/reject`

### Agent onboarding (for a "Connect agent" modal)

- MCP URL: `http://<host>:4100/mcp?agent=<NAME>` (+ `&token=<TOKEN>` if `tokenRequired`).
- Claude Code: `claude mcp add --transport http hivemind "http://localhost:4100/mcp?agent=alice"`
- Other clients (JSON): `{ "mcpServers": { "hivemind": { "type": "http", "url": "http://localhost:4100/mcp?agent=alice" } } }`
- Slash commands come for free as MCP prompts: `/mcp__hivemind__push`, `/mcp__hivemind__pull`, `/mcp__hivemind__handoff`.
- For short `/push` `/pull` `/handoff`, install the kit files (served by the hub):
  ```bash
  mkdir -p .claude/commands && for c in push pull handoff; do curl -s http://localhost:4100/kit/$c.md -o .claude/commands/$c.md; done
  ```
  PowerShell: `mkdir .claude/commands -Force; foreach ($c in "push","pull","handoff") { iwr http://localhost:4100/kit/$c.md -OutFile .claude/commands/$c.md }`

Agent tools (for an explainer panel): `hub_overview`, `pull`, `push`, `handoff`, `send_message`, `read_messages`, `read_file`, `add_file`, `search`, `history`, `ask_conductor`, `create_project`.

---

## 5. Design direction

The team said the old UI "looks stupid." They want it to look **much more advanced and techy**: a mission-control / dev-tool feel, not a generic SaaS admin page.

- **Dark by default**, near-black background, subtle grid or noise, crisp 1px borders, one strong accent (violet `#8b7cff` is the brand) plus semantic green/amber/red/cyan.
- **Monospace for data** (shas, ids, timestamps, paths, the activity stream), e.g. JetBrains Mono; a clean sans (Inter / Geist) for prose.
- **Live everywhere**: the activity stream should feel like a terminal tail (new lines animate in); pulsing conductor status; agent presence dots; "processing…" shimmer on log items without a summary; flash/highlight docs on `doc` events.
- **Hero visual**: a live **topology / network graph**: the conductor as a core node, agents orbiting it, projects as nodes; edges pulse when an agent pushes or messages. This sells the "hive."
- **Git-native feel**: commit list with short shas and authors, a version timeline per doc, unified or side-by-side diffs with green/red lines, snapshot tags shown like git tags.
- **Command palette (⌘K / Ctrl+K)** backed by `/api/search`, also for jumping to projects/sections and actions (new project, snapshot, connect agent).
- A **status bar** (bottom, IDE-style): provider/model, conductor state, queue length, brain HEAD sha, agents online, total tokens.
- Clear **permission affordances**: lock on Instructions ("humans only"), "AI-maintained" badge on Brief/Playbooks, "append-only" on Decisions/Log, "immutable" on Snapshots.
- Responsive enough to not break on a laptop screen at a demo table; desktop-first is fine.

Suggested layout: left rail (projects) → section nav (Overview, Brief, Instructions, Playbooks ▸, Decisions, Links, Files, Log, History, Snapshots, Approvals[n]) → main pane → right panel (live activity stream on top, agent chat below, with composer). Overview page per project: topology graph, stats (commits, decisions, playbooks, files, tokens), latest conductor commits, open PRs/recent GitHub commits, who's working on what.

---

## 5b. Added since this brief was written: auth, gateway, access

**Auth.** If the server has `HIVEMIND_PASSWORD`, every `/api/*` call (except below) returns **401** without a session cookie.
- `GET /api/session` → `{ secure, loggedIn }` (public). `POST /api/login` `{ password }` sets an HttpOnly cookie. `POST /api/logout`.
- Agent tokens: `GET /api/tokens`, `POST /api/tokens` `{ agent, project?, access? }` → `{ id, agent, token }` (token shown once), `DELETE /api/tokens/:id`.
- In secure mode agents connect with header `Authorization: Bearer hm_…` (no `?agent=`).

**Gateway (the Track 2 control layer).** Every agent tool call, slash command, dashboard mutation, login, and bad token is a recorded request.
- `GET /api/requests?limit=&outcome=&actor=&project=&action=` → newest first:
  `{ seq, id, at, actor, actorKind: agent|human|overseer|unknown, channel: mcp|api|internal, client, action, label, access, project, resource, outcome: allowed|denied|unauthenticated|error, status, reason, ms, detail }`
- `GET /api/requests/stats?hours=24` → `{ total, allowed, denied, unauthenticated, error, avgMs, agents: [{ actor, n, denied }] }`. `/api/state` also includes `gateway` (same shape) and `defaultAccess`.
- SSE event `request` fires per recorded request. Denied/unauthenticated ones also appear in `activity` with actor `gateway`, type `denied`, `refs.request`.

**Per-agent project access** (none / read / write), enforced server-side.
- `GET /api/projects/:slug/access` → `{ default, levels, secure, agents: [{ agent, access /*effective*/, explicit /*null = default*/, lastSeen, hasToken }] }`
- `PUT /api/projects/:slug/access` `{ agent, access: "none"|"read"|"write"|null }` (null = reset to default). SSE event `access`.

## 6. Gotchas

- Markdown from the AI may contain HTML comments (`<!-- pin -->`). Detect pinned blocks **before** rendering and render them specially.
- Activity `text` uses `**bold**` and `` `code` `` inline; render with a tiny inline formatter (escape HTML first).
- `log[].summary` is `null` until the conductor processes it (usually 5–30s; the conductor waits ~6s of quiet to batch pushes).
- The conductor may be **paused** (no credentials). Show it clearly, with the reason from the latest `error` activity.
- `messages[].recipient === "*"` means broadcast. `auto === 1` means the conductor sent it (style it as a system notice).
- Restoring a snapshot or file is non-destructive, but still ask for confirmation.
- File uploads: send the raw `File` as the body: `fetch(\`/api/projects/${slug}/files?name=${encodeURIComponent(file.name)}\`, { method: "POST", body: file })`.
- Everything is same-origin; no CORS concerns.
