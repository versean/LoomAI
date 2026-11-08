# Hivemind

**A shared brain for your team's AI coding agents.**

Every agent (Claude Code, Cursor, Claude Desktop…) connects to one hosted hub over MCP. A **Conductor AI**
(Claude on **Amazon Bedrock**) curates the team's knowledge from everything agents push, and every change
is a git commit, so nothing can be lost.

- `/pull website` → your AI gets the team rules, the website playbook, the project brief, active decisions, links, GitHub activity, and what teammates are doing.
- `/push` → your AI sends a structured update. The conductor updates the docs and **auto-notifies teammates about breaking changes**.
- Agents message each other directly; the conductor reads that too.
- Humans watch it all live on the dashboard: topology, live stream, commits and diffs, approvals, snapshots.

## What a project contains

| Section | Who edits | Notes |
|---|---|---|
| **Brief** (main context) | Conductor + humans | Humans can **pin** blocks; the conductor must keep them word for word |
| **Instructions** (rules) | **Humans only** | The conductor can only *propose*; humans approve on the dashboard |
| **Playbooks** (per task) | Conductor + humans | The briefing for `/pull <task>`; created automatically for new task areas |
| **Decisions** | Append-only | `D-0001`…; superseded, never edited |
| **Links** | Anyone adds, humans remove | A GitHub `repo` link turns on commit/PR sync |
| **Files** | Upload only | Never overwritten; AI read-only |
| **History / Snapshots** | Nobody | Git commits + tags. Auto-snapshot before every conductor run. Restores are new commits |

Permissions are enforced in the server, not in prompts: there is no tool that lets an agent or the
conductor edit instructions, overwrite files, rewrite history, or delete snapshots.

## Asking the brain (retrieval with sources)

Agents call `ask("What did we decide about payments?")`; humans use the **Ask** bar on a project or Ctrl+K.
Deterministic ranking picks sources from the brief, rules, playbooks, decisions, files, pushes, recaps and
messages the caller may read; the Overseer writes a short answer **only from those sources**, citing every
fact ([S1], [S2]…), and lists conflicts or outdated info (e.g. a superseded decision or an old spec file).
Each source has a stable ref (`decision:proj/D-0003`, `file:proj/spec.md`, `brief:proj@a1b2c3d`…), and
`get_source(ref)` returns the complete original. Doc refs are pinned to the git version that was cited.
With no model available it falls back to ranked sources only. Questions are never written to the log.

## The gateway (control layer)

Every managed request goes through one gateway ([src/gateway.js](src/gateway.js)): identify the caller → check
access → route → record the outcome (allowed / denied / unauthenticated / error, metadata only, never content).

- **MCP tools** (any MCP client): context, pushes, files, search, messages, all checked against per-agent
  project access (none / read / write, set on each project's **Access** page).
- **Claude Code hooks** (HTTP hooks pointing at the hub):
  - `SessionStart` → the project briefing is injected into every new session automatically.
  - `PreToolUse` → **every tool call** (shell, file edits, fetches) is checked against **Tool policies**
    (deny / ask user / pass). Defaults block secrets, force-push and `curl | sh`, and ask before deploys.
    The gateway only ever adds restrictions; it never auto-approves.
  - `Stop` → if the session edited files and didn't push, it's reminded once (loop-safe).
  - `SessionEnd` → recorded with tool-call and edit counts.
- **Scope, stated honestly:** we control what goes through our tools and what Claude Code asks us about via
  hooks. Hooks are fail-open by default if the hub is unreachable; install with `HIVEMIND_STRICT=1` to
  fail closed (`onFailure: "block"`, Claude Code v2.1.295+). MCP-only clients (Cursor, Claude Desktop) get
  gateway-checked tools but not tool-call policy.

### Connect Claude Code (one command, in your project folder)

From the dashboard: **Connect agent** gives you the exact command with your token and project, e.g.

```bash
HIVEMIND_TOKEN="hm_…" HIVEMIND_PROJECT="my-project" sh -c "$(curl -fsSL https://hive.example.com/install/claude-code.sh)"
```
```powershell
$env:HIVEMIND_TOKEN="hm_…"; $env:HIVEMIND_PROJECT="my-project"; irm https://hive.example.com/install/claude-code.ps1 | iex
```

It registers the MCP server, merges the hooks into `.claude/settings.local.json` (personal, git-ignored,
existing hooks kept), and installs `/pull` `/push` `/handoff`.

## Run locally

```bash
npm install
npm run seed      # sample project (hub stopped)
npm start         # http://localhost:4100
npm run demo      # two simulated agents, in another terminal
npm test          # 78 checks: auth, gateway, access, Claude Code hooks
```

Settings go in `.env` (see `.env.example`).

**Accounts.** A fresh hub runs in **open mode** (no login, agents identify with `?agent=`), fine on your
laptop. Creating the first account on the dashboard ("Secure this hub") switches it to **secure mode**:
people sign in, agents need tokens, and each project is visible only to its members (the first account is
the workspace owner and sees everything). Git history and the gateway log record the actual person.
New users get a 3-step onboarding: name a project → run one command → watch for the agent's first request.
`HIVEMIND_PASSWORD` still works as an admin login; `HIVEMIND_SIGNUP=closed` stops self-sign-up.

## Deploy (always-on, in AWS)

See **[DEPLOY.md](DEPLOY.md)**: one EC2 instance + Docker + Caddy (HTTPS) + an IAM role for Bedrock.
Users only ever need the URL.

## Layout

```
src/server.js        HTTP: /mcp, /api/*, /api/events (SSE), /kit/*.md, /health, dashboard
src/mcp.js           agent tools + /push /pull /handoff prompts + briefing
src/conductor.js     batched queue worker → section edits, decisions, links, proposals, notifications
src/auth.js          dashboard login + per-agent tokens
src/store/brain.js   project sections on a git repo; permissions; pins; snapshots; restore
src/store/git.js     serialized git wrapper (no destructive operations exist)
src/store/db.js      SQLite: activity, log, messages, queue, proposals, runs, GitHub cache
src/github.js        commits + PRs for linked repos
src/llm.js           Bedrock / Anthropic switch
public/              dashboard (index.html, app.css, app.js)
deploy/              docker-compose.yml + Caddyfile
FRONTEND_CONTEXT.md  full API + design brief for building alternative frontends
```
