# Handoff: Loom AI

This is your `daddy-ai` backend (the latest version, with team links) with three changes:

1. **A new dashboard** in `packages/server/src/loom_server/static/`
2. **A rename** from Daddy AI / family to **Loom AI** / team
3. **A name for the central AI:** the **Conductor**

No server logic was changed: no retrieval, policy, schema or delivery code. Everything below is what you need to ship it.

---

## 1. Before you deploy

Do these in order.

1. **Regenerate the lock file.** Package names changed (`daddy-*` → `loom-*`) and `uv.lock` was edited as text:
   ```bash
   uv lock
   ```
2. **Run the full test suite** (it needs the database):
   ```bash
   docker compose up -d
   ```
   ```bash
   uv run pytest
   ```
   The local database user, password and name are now `loom`. If you had the old `daddy` volume, run
   `docker compose down -v` first.
3. **Try the dashboard against the real server:**
   ```bash
   uv run loom-server
   ```
   ```bash
   uv run loom dashboard
   ```
   Click through Home, Activity, Team, Inbox, a project (Summary, Files, Ask), and the Invite button in the top bar.
4. **Push this folder as the root of `github.com/versean/LoomAI`.** The installer URL now points there
   (`https://raw.githubusercontent.com/versean/LoomAI/main/install.sh`). Until the code is there, the one-line install
   fails.
5. **Redeploy the hosted server** (`d1a5peogdvb7j1.cloudfront.net`) with `deploy/aws/deploy.sh`. The renamed CLI can't
   talk to the old server: `/api/family` became `/api/team`, and the bootstrap field `family_name` became `team_name`.

---

## 2. What was renamed

| Before | After |
|---|---|
| Product name "Daddy AI" | "Loom AI" |
| CLI command `daddy` | `loom` (`loom watch`, `loom dashboard`, …) |
| Packages `daddy_server`, `daddy_cli`, `daddy_common` | `loom_server`, `loom_cli`, `loom_common` |
| Distributions `daddy-server`, `daddy-cli`, `daddy-common` | `loom-server`, `loom-cli`, `loom-common` |
| Env vars `DADDY_*` | `LOOM_*` (e.g. `LOOM_DATABASE_URL`, `LOOM_LLM_PROVIDER`, `LOOM_HOME`) |
| Config folder `~/.daddy` | `~/.loom` |
| Inbox folder `~/Daddy/inbox` | `~/Loom/inbox` |
| MCP server key `"daddy"` in Cursor, Claude Code and Claude app configs | `"loom"` |
| Cursor rule `.cursor/rules/daddy-ai.mdc` | `.cursor/rules/loom-ai.mdc` |
| Header `X-Daddy-Client` | `X-Loom-Client` |
| New device tokens `dad_…` | `loom_…` (old tokens still work: they're checked by hash) |
| "family", "family members", "family ledger" | "team", "teammates", "team dashboard" |
| API route `GET /api/family` | `GET /api/team` |
| JSON key `"family"` in `/api/me`, `/api/bootstrap`, `/api/join`, `/api/team` | `"team"` |
| Bootstrap body field `family_name`, CLI flag `--family` | `team_name`, `--team` |
| Audit actions `family.create`, `family.join` | `team.create`, `team.join` |
| systemd unit `daddy-server` | `loom-server`. `setup-ec2.sh` now stops the old unit so port 8787 is free |
| Release paths `daddy-ai.tar.gz`, `/home/ec2-user/daddy-ai` | `loom-ai.tar.gz`, `/home/ec2-user/loom-ai` |
| Install URL `AskArtwentythree/daddy-ai` | `versean/LoomAI` |

### Kept on purpose: live AWS identifiers

Changing any of these makes CloudFormation replace resources. RDS has `BackupRetentionPeriod: 0`, so replacing the
database would lose all data.

| Where | Kept as |
|---|---|
| `deploy/aws/stack.yaml` | `DBName: daddy`, `MasterUsername: daddy_admin`, the three security-group descriptions, the DB subnet group description, `PolicyName: daddy-ai` |
| `deploy/aws/deploy.sh` | `STACK=${STACK:-daddy-full}` (the existing stack's name) |
| `deploy/aws/install.sh` | The database URL path `…:5432/daddy` (must match `DBName`) |
| `deploy/README.md` | "The stack is named `daddy-full`" |

Only the template's top-level `Description` and the bootstrap secret's `Description` were updated; both change in
place.

**Suggestion:** turn backups on (`BackupRetentionPeriod: 7`). That change is applied in place and doesn't replace
the instance.

---

## 3. The Conductor

The central AI that answers questions and writes project briefs is now called the **Conductor**:

| File | What changed |
|---|---|
| `loom_server/retrieval.py` | `_ANSWER_SYSTEM`: "You are the Conductor, the AI at the center of Loom AI…" |
| `loom_server/brief.py` | `_OVERVIEW_SYSTEM`: "You are the Conductor of Loom AI…" |
| `loom_cli/mcp_server.py` | `INSTRUCTIONS` and the `ask_project` docstring mention the Conductor |
| `loom_cli/main.py` | `loom ask` help |
| `README.md` | Intro |
| Dashboard | House rules and the project brief card |

---

## 4. The new dashboard

| File | Notes |
|---|---|
| `static/index.html`, `static/app.js`, `static/app.css` | Replace your `index.html`, `app.js`, `style.css` (`style.css` was removed) |
| `static/assets/` | Loom logo and favicon |
| `scripts/dashboard-mock.mjs` | Fakes your API with made-up data for design previews (`node scripts/dashboard-mock.mjs`, then http://localhost:4300/#login=demo). Not for production |
| `DASHBOARD.md` | Pages and the endpoints each one calls |

It's plain HTML, CSS and JS with no build step, and uses only your existing endpoints:
- `/api/team`, `/api/me`, `/api/stats`, `/api/audit`
- `/api/ask`, `/api/inbox` (accept and decline)
- `/api/projects/{slug}/brief|files|file|notes`
- `/api/invites`, `/api/invites/cancel`, `/api/devices/{id}/revoke`
- the `/api/ws` WebSocket

Sign-in works as before:
1. `loom dashboard` opens `/#login=<code>`.
2. The page exchanges the code at `/api/dashboard/session` for the read-only dashboard token, kept in `sessionStorage`.

One behavior change from your page: opening a new `#login=` link in an already-open tab now reloads and signs in. Before, it was ignored.

What the dashboard can't do, by design, because the dashboard token has only the `read` scope:
- send files
- create projects
- upload files

Saving a note works for owners and members, since `require_write` checks the role, not the scope.

---

## 5. Other changes

- **`packages/cli/tests/test_cli_parts.py`:** two tests now also set `USERPROFILE` and `APPDATA`. On Windows,
  `Path.home()` and the Claude desktop config path ignore `HOME`, so these tests were writing into the real user's
  `~/.cursor` and `%APPDATA%\Claude`.

---

## 6. What's been verified, and what hasn't

| Check | Result |
|---|---|
| Python compiles, all packages import, `loom --help` runs | Done |
| `pytest` on `packages/common/tests`, `packages/cli/tests`, `packages/server/tests/test_retrieval_parts.py` | 21 passed |
| Dashboard against the mock API (every page, ask, filters, log detail, invite, note, accept, phone width) | Done |
| `test_api_flow.py` (needs Postgres) | **Not run** |
| Dashboard against the real server | **Not run** |
| `uv lock`, deploy, the installer from `versean/LoomAI` | **Not run** |

---

## 7. Existing users after the rename

Their old setup points at the `daddy` command and `~/.daddy`. The simplest path is to re-run the installer, which:
- installs `loom`
- writes `~/.loom`
- registers the `loom` MCP server

They should then remove the old `"daddy"` entries from:
- `~/.cursor/mcp.json`
- `~/.cursor/hooks.json`
- the Claude app config
- Claude Code (`claude mcp remove --scope user daddy`)
