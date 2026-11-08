"""Loom AI gateway: the single entry point every team member's agent talks to."""

from __future__ import annotations

import asyncio
import logging
import re
import time
from contextlib import asynccontextmanager
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Literal
from uuid import UUID

from fastapi import BackgroundTasks, Depends, FastAPI, Request, WebSocket, WebSocketDisconnect
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from loom_common.secrets import scan_text

from . import delivery, retrieval
from .audit import AuditScope, audited, record
from .auth import (
    INVITE_PREFIX,
    TOKEN_PREFIX,
    Actor,
    actor_for_token,
    hash_secret,
    new_secret,
    require_actor,
)
from .blobs import get_blob_store
from .brief import refresh_brief
from .config import get_settings
from .db import close_pool, connection, open_pool
from .errors import InvalidRequest, NotFound, PolicyDenied
from .events import bus
from .ingestion import FileInput, fetch_github_snapshot, ingest_files, normalize_path, note_path
from .policy import (
    Project,
    require_admin,
    require_manage,
    require_read,
    require_write,
    resolve_project,
)
from .providers.embeddings import get_embedder
from .providers.llm import get_llm
from .providers.rerank import get_reranker

log = logging.getLogger("loom")
Role = Literal["owner", "member", "viewer"]


@asynccontextmanager
async def lifespan(_: FastAPI):
    await run_in_threadpool(open_pool)
    bus.bind(asyncio.get_running_loop())
    yield
    await run_in_threadpool(close_pool)


app = FastAPI(title="Loom AI", version="0.1.0", lifespan=lifespan)


@app.exception_handler(PolicyDenied)
async def _denied(_: Request, exc: PolicyDenied):
    return JSONResponse(status_code=403, content={"error": "denied", "reason": exc.reason})


@app.exception_handler(NotFound)
async def _not_found(_: Request, exc: NotFound):
    return JSONResponse(status_code=404, content={"error": "not_found", "reason": str(exc)})


@app.exception_handler(InvalidRequest)
async def _invalid(_: Request, exc: InvalidRequest):
    return JSONResponse(status_code=400, content={"error": "invalid", "reason": str(exc)})


# ── Request bodies ────────────────────────────────────────────────────────────


class BootstrapBody(BaseModel):
    team_name: str = Field(min_length=1, max_length=80)
    email: str
    display_name: str = Field(min_length=1, max_length=80)
    device_name: str = Field(min_length=1, max_length=80)
    secret: str | None = None


class InviteBody(BaseModel):
    """A personal invite (email and name) works once; without them it is a team link for up to max_uses people."""

    email: str | None = None
    display_name: str | None = Field(default=None, min_length=1, max_length=80)
    project: str | None = None
    role: Role = "member"
    max_uses: int = Field(default=20, ge=1, le=200)


class CancelInviteBody(BaseModel):
    code: str


class JoinBody(BaseModel):
    code: str
    device_name: str = Field(min_length=1, max_length=80)
    email: str | None = None
    display_name: str | None = Field(default=None, max_length=80)


class ProjectBody(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    slug: str | None = Field(default=None, pattern=r"^[a-z0-9][a-z0-9-]{0,39}$")
    description: str = ""


class MemberBody(BaseModel):
    email: str
    role: Role = "member"


class FileBody(BaseModel):
    path: str
    content: str


class UploadBody(BaseModel):
    files: list[FileBody] = Field(max_length=500)
    source: str = "upload"
    refresh_brief: bool = True


class GithubBody(BaseModel):
    repo: str
    ref: str | None = None
    token: str | None = None


class NoteBody(BaseModel):
    title: str = Field(min_length=1, max_length=120)
    content: str = Field(min_length=1, max_length=50_000)


class SearchBody(BaseModel):
    query: str = Field(min_length=1, max_length=2000)
    project: str | None = None
    path_prefix: str | None = None


class AskBody(SearchBody):
    session_key: str | None = None


class SendBody(BaseModel):
    project: str
    to: str
    filename: str
    content: str
    kind: Literal["file", "skill", "message"] = "file"
    note: str = ""
    install_path: str | None = None


class DashboardLoginBody(BaseModel):
    code: str


class AgentEventBody(BaseModel):
    event: str = Field(pattern=r"^[a-z_.]{1,40}$")
    decision: Literal["allow", "deny"] = "allow"
    reason: str | None = None
    detail: dict = Field(default_factory=dict)


# ── Helpers ───────────────────────────────────────────────────────────────────


def _project(conn, actor: Actor, slug: str, scope: AuditScope) -> Project:
    project = resolve_project(conn, actor, slug)
    scope.project_id = project.id
    return project


def _issue_device(conn, user_id: UUID, device_name: str, scopes: list[str] | None = None) -> str:
    token, token_hash = new_secret(TOKEN_PREFIX)
    conn.execute(
        "INSERT INTO devices (user_id, name, token_hash, scopes) VALUES (%s, %s, %s, %s)",
        (user_id, device_name, token_hash, scopes or ["read", "share"]),
    )
    return token


def _slugify(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")[:40] or "project"


# ── Onboarding ────────────────────────────────────────────────────────────────


@app.get("/api/health")
def health() -> dict:
    return {
        "status": "ok",
        "embedder": get_embedder().name,
        "reranker": get_reranker().name,
        "llm": get_llm().name,
    }


@app.post("/api/bootstrap")
def bootstrap(body: BootstrapBody) -> dict:
    settings = get_settings()
    with connection() as conn:
        exists = conn.execute("SELECT 1 FROM workspaces LIMIT 1").fetchone()
        secret_ok = settings.bootstrap_secret and body.secret == settings.bootstrap_secret
        if not (secret_ok or settings.open_signup):
            if settings.bootstrap_secret:
                raise PolicyDenied("Creating a team on this server requires the bootstrap secret")
            if exists:
                raise PolicyDenied("A team already exists; ask its admin for an invite")
        workspace_id = conn.execute(
            "INSERT INTO workspaces (name) VALUES (%s) RETURNING id", (body.team_name,)
        ).fetchone()["id"]
        user_id = conn.execute(
            """
            INSERT INTO users (workspace_id, email, display_name, is_admin)
            VALUES (%s, lower(%s), %s, true) RETURNING id
            """,
            (workspace_id, body.email, body.display_name),
        ).fetchone()["id"]
        token = _issue_device(conn, user_id, body.device_name)
    record(None, "team.create", "allow", workspace_id=workspace_id,
           detail={"team": body.team_name, "admin": body.email})
    return {"token": token, "team": body.team_name, "user": body.display_name}


@app.post("/api/invites")
def create_invite(body: InviteBody, actor: Actor = Depends(require_actor)) -> dict:
    with audited(actor, "invite.create", email=body.email, role=body.role) as scope, connection() as conn:
        project_id = None
        if body.project:
            project = _project(conn, actor, body.project, scope)
            require_manage(actor, project)
            project_id = project.id
        else:
            require_admin(actor)
        team_link = body.email is None
        if team_link and body.role == "owner":
            raise InvalidRequest("A team link can't make people owners; send a personal invite instead")
        if not team_link and not body.display_name:
            raise InvalidRequest("A personal invite needs the person's name")
        max_uses = body.max_uses if team_link else 1
        code, code_hash = new_secret(INVITE_PREFIX)
        conn.execute(
            """
            INSERT INTO invites (code_hash, workspace_id, email, display_name, project_id, role, created_by,
                                 expires_at, max_uses)
            VALUES (%s, %s, lower(%s), %s, %s, %s, %s, %s, %s)
            """,
            (code_hash, actor.workspace_id, body.email, body.display_name, project_id, body.role,
             actor.user_id, datetime.now(UTC) + timedelta(days=7), max_uses),
        )
    return {"code": code, "expires_in_days": 7, "max_uses": max_uses}


@app.post("/api/invites/cancel")
def cancel_invite(body: CancelInviteBody, actor: Actor = Depends(require_actor)) -> dict:
    with audited(actor, "invite.cancel"), connection() as conn:
        row = conn.execute(
            """
            UPDATE invites SET expires_at = now()
            WHERE code_hash = %s AND workspace_id = %s AND (%s OR created_by = %s) AND expires_at > now()
            RETURNING uses
            """,
            (hash_secret(body.code.strip()), actor.workspace_id, actor.is_admin, actor.user_id),
        ).fetchone()
        if row is None:
            raise NotFound("No active invite with that code that you can cancel")
    return {"cancelled": True, "used_by": row["uses"]}


@app.post("/api/join")
def join(body: JoinBody) -> dict:
    with connection() as conn:
        invite = conn.execute(
            """
            SELECT i.*, w.name AS team FROM invites i JOIN workspaces w ON w.id = i.workspace_id
            WHERE i.code_hash = %s AND i.used_at IS NULL AND i.expires_at > now()
            FOR UPDATE OF i
            """,
            (hash_secret(body.code.strip()),),
        ).fetchone()
        if invite is None:
            raise PolicyDenied("Invite code is invalid, expired or already used")
        email, name = invite["email"], invite["display_name"]
        if email is None:
            email, name = (body.email or "").strip().lower(), (body.display_name or "").strip()
            if "@" not in email or not name:
                raise InvalidRequest("This team link needs your name and email")
            taken = conn.execute(
                "SELECT 1 FROM users WHERE workspace_id = %s AND email = %s", (invite["workspace_id"], email)
            ).fetchone()
            if taken:
                raise PolicyDenied(f"{email} is already in this team; ask its admin for a personal invite")
        user_id = conn.execute(
            """
            INSERT INTO users (workspace_id, email, display_name) VALUES (%s, %s, %s)
            ON CONFLICT (workspace_id, email) DO UPDATE SET display_name = users.display_name
            RETURNING id
            """,
            (invite["workspace_id"], email, name),
        ).fetchone()["id"]
        if invite["project_id"]:
            conn.execute(
                """
                INSERT INTO memberships (project_id, user_id, role) VALUES (%s, %s, %s)
                ON CONFLICT (project_id, user_id) DO UPDATE SET role = EXCLUDED.role
                """,
                (invite["project_id"], user_id, invite["role"]),
            )
            refresh_brief(conn, invite["project_id"])
        conn.execute(
            """
            UPDATE invites SET uses = uses + 1, used_at = CASE WHEN uses + 1 >= max_uses THEN now() END
            WHERE code_hash = %s
            """,
            (invite["code_hash"],),
        )
        token = _issue_device(conn, user_id, body.device_name)
    record(None, "team.join", "allow", workspace_id=invite["workspace_id"],
           detail={"email": email, "device": body.device_name, "team_link": invite["email"] is None})
    return {"token": token, "team": invite["team"], "user": name}


@app.get("/api/me")
def me(actor: Actor = Depends(require_actor)) -> dict:
    with connection() as conn:
        team = conn.execute("SELECT name FROM workspaces WHERE id = %s", (actor.workspace_id,)).fetchone()
        projects = conn.execute(
            """
            SELECT p.slug, p.name, m.role,
                   (SELECT count(*) FROM memberships x WHERE x.project_id = p.id) AS members,
                   (SELECT count(*) FROM documents d WHERE d.project_id = p.id) AS documents
            FROM memberships m JOIN projects p ON p.id = m.project_id
            WHERE m.user_id = %s ORDER BY p.name
            """,
            (actor.user_id,),
        ).fetchall()
        waiting = conn.execute(
            "SELECT count(*) AS n FROM deliveries WHERE recipient_id = %s AND status = 'new'",
            (actor.user_id,),
        ).fetchone()["n"]
    return {
        "user": actor.display_name,
        "email": actor.email,
        "is_admin": actor.is_admin,
        "team": team["name"],
        "device": actor.device_name,
        "scopes": list(actor.scopes),
        "projects": projects,
        "inbox_waiting": waiting,
        "providers": health(),
    }


# ── Projects and knowledge ────────────────────────────────────────────────────


@app.get("/api/projects")
def list_projects(actor: Actor = Depends(require_actor)) -> list[dict]:
    return me(actor)["projects"]


@app.post("/api/projects")
def create_project(body: ProjectBody, actor: Actor = Depends(require_actor)) -> dict:
    slug = body.slug or _slugify(body.name)
    with audited(actor, "project.create", slug=slug) as scope, connection() as conn:
        if conn.execute(
            "SELECT 1 FROM projects WHERE workspace_id = %s AND slug = %s", (actor.workspace_id, slug)
        ).fetchone():
            raise InvalidRequest(f"Project '{slug}' already exists")
        project_id = conn.execute(
            "INSERT INTO projects (workspace_id, slug, name, description) VALUES (%s, %s, %s, %s) RETURNING id",
            (actor.workspace_id, slug, body.name, body.description),
        ).fetchone()["id"]
        conn.execute(
            "INSERT INTO memberships (project_id, user_id, role) VALUES (%s, %s, 'owner')",
            (project_id, actor.user_id),
        )
        scope.project_id = project_id
    return {"slug": slug, "name": body.name}


@app.post("/api/projects/{slug}/members")
def add_member(slug: str, body: MemberBody, actor: Actor = Depends(require_actor)) -> dict:
    with audited(actor, "member.add", email=body.email, role=body.role) as scope, connection() as conn:
        project = _project(conn, actor, slug, scope)
        require_manage(actor, project)
        user = conn.execute(
            "SELECT id, display_name FROM users WHERE workspace_id = %s AND email = lower(%s)",
            (actor.workspace_id, body.email),
        ).fetchone()
        if user is None:
            raise NotFound(f"{body.email} is not in this team yet; send an invite instead")
        conn.execute(
            """
            INSERT INTO memberships (project_id, user_id, role) VALUES (%s, %s, %s)
            ON CONFLICT (project_id, user_id) DO UPDATE SET role = EXCLUDED.role
            """,
            (project.id, user["id"], body.role),
        )
        refresh_brief(conn, project.id)
    return {"project": slug, "member": user["display_name"], "role": body.role}


@app.delete("/api/projects/{slug}/members/{email}")
def remove_member(slug: str, email: str, actor: Actor = Depends(require_actor)) -> dict:
    with audited(actor, "member.remove", email=email) as scope, connection() as conn:
        project = _project(conn, actor, slug, scope)
        require_manage(actor, project)
        removed = conn.execute(
            """
            DELETE FROM memberships m USING users u
            WHERE m.user_id = u.id AND m.project_id = %s AND u.email = lower(%s)
            RETURNING u.display_name
            """,
            (project.id, email),
        ).fetchone()
        if removed is None:
            raise NotFound(f"{email} is not a member of '{slug}'")
        refresh_brief(conn, project.id)
    return {"project": slug, "removed": removed["display_name"]}


@app.post("/api/projects/{slug}/documents")
def upload_documents(slug: str, body: UploadBody, actor: Actor = Depends(require_actor)) -> dict:
    with audited(actor, "ingest.upload", files=len(body.files)) as scope, connection() as conn:
        project = _project(conn, actor, slug, scope)
        require_write(actor, project)
        report = ingest_files(
            conn, project_id=project.id, user_id=actor.user_id,
            files=[FileInput(f.path, f.content) for f in body.files], source=body.source,
        )
        if body.refresh_brief:
            refresh_brief(conn, project.id)
        scope.detail.update(report.summary())
    return report.summary() | {"skipped_files": report.skipped}


def _ingest_github(actor: Actor, project: Project, body: GithubBody) -> None:
    try:
        with audited(actor, "ingest.github", repo=body.repo, ref=body.ref) as scope:
            scope.project_id = project.id
            files, skipped = fetch_github_snapshot(body.repo, body.ref, body.token)
            with connection() as conn:
                report = ingest_files(
                    conn, project_id=project.id, user_id=actor.user_id, files=files,
                    source=f"github:{body.repo}", prune_missing=True,
                )
                refresh_brief(conn, project.id)
            report.skipped.extend(skipped)
            scope.detail.update(report.summary())
        bus.to_user(actor.user_id, {"type": "ingest.done", "project": project.slug, "repo": body.repo,
                                    "report": report.summary()})
    except Exception as error:  # already audited; surface it to the requester's CLI
        log.exception("GitHub ingestion failed")
        bus.to_user(actor.user_id, {"type": "ingest.failed", "project": project.slug,
                                    "repo": body.repo, "reason": str(error)[:300]})


@app.post("/api/projects/{slug}/github", status_code=202)
def import_github(slug: str, body: GithubBody, background: BackgroundTasks,
                  actor: Actor = Depends(require_actor)) -> dict:
    with audited(actor, "ingest.github.request", repo=body.repo) as scope, connection() as conn:
        project = _project(conn, actor, slug, scope)
        require_write(actor, project)
    background.add_task(_ingest_github, actor, project, body)
    return {"status": "started", "project": slug, "repo": body.repo}


@app.post("/api/projects/{slug}/notes")
def save_note(slug: str, body: NoteBody, actor: Actor = Depends(require_actor)) -> dict:
    with audited(actor, "note.save", title=body.title) as scope, connection() as conn:
        project = _project(conn, actor, slug, scope)
        require_write(actor, project)
        if findings := scan_text(body.content):
            raise PolicyDenied("Note not saved, it contains secrets: "
                               + "; ".join(f.describe() for f in findings[:3]))
        path = note_path(body.title)
        content = f"# {body.title}\n\n_Saved by {actor.display_name}_\n\n{body.content}"
        report = ingest_files(conn, project_id=project.id, user_id=actor.user_id,
                              files=[FileInput(path, content)], source="note", kind="note")
        refresh_brief(conn, project.id)
        scope.detail.update(path=path)
    return {"path": path, "project": slug, "chunks": report.chunks}


@app.get("/api/projects/{slug}/brief")
def project_brief(slug: str, actor: Actor = Depends(require_actor)) -> dict:
    with audited(actor, "brief.read") as scope, connection() as conn:
        project = _project(conn, actor, slug, scope)
        require_read(actor, project)
        row = conn.execute("SELECT brief FROM projects WHERE id = %s", (project.id,)).fetchone()
        brief = row["brief"] or refresh_brief(conn, project.id)
    return {"project": slug, "brief": brief}


@app.get("/api/projects/{slug}/files")
def list_files(slug: str, actor: Actor = Depends(require_actor)) -> dict:
    with audited(actor, "files.list") as scope, connection() as conn:
        project = _project(conn, actor, slug, scope)
        require_read(actor, project)
        rows = conn.execute(
            "SELECT path, kind, size_bytes, updated_at FROM documents WHERE project_id = %s ORDER BY path",
            (project.id,),
        ).fetchall()
    return {"project": slug, "files": rows}


@app.get("/api/projects/{slug}/file")
def get_file(slug: str, path: str, actor: Actor = Depends(require_actor)) -> dict:
    with audited(actor, "file.read", path=path) as scope, connection() as conn:
        project = _project(conn, actor, slug, scope)
        require_read(actor, project)
        row = conn.execute(
            "SELECT blob_key, updated_at FROM documents WHERE project_id = %s AND path = %s",
            (project.id, normalize_path(path)),
        ).fetchone()
        if row is None:
            raise NotFound(f"No file '{path}' in project '{slug}'")
    return {"project": slug, "path": path, "content": get_blob_store().get(row["blob_key"]).decode(),
            "updated_at": row["updated_at"]}


@app.post("/api/search")
def search(body: SearchBody, actor: Actor = Depends(require_actor)) -> dict:
    with audited(actor, "knowledge.search", query=body.query[:200]) as scope, connection() as conn:
        project_id = None
        if body.project:
            project = _project(conn, actor, body.project, scope)
            require_read(actor, project)
            project_id = project.id
        elif "read" not in actor.scopes:
            raise PolicyDenied("This device cannot read project knowledge")
        result = retrieval.hybrid_search(conn, actor, body.query, project_id=project_id,
                                         path_prefix=body.path_prefix)
        scope.detail.update(hits=len(result.hits), top_score=result.top_score, grounded=result.grounded)
    return retrieval.search_payload(result)


@app.post("/api/ask")
def ask(body: AskBody, actor: Actor = Depends(require_actor)) -> dict:
    with audited(actor, "knowledge.ask", question=body.query[:200]) as scope, connection() as conn:
        project_id = None
        if body.project:
            project = _project(conn, actor, body.project, scope)
            require_read(actor, project)
            project_id = project.id
        elif "read" not in actor.scopes:
            raise PolicyDenied("This device cannot read project knowledge")
        result = retrieval.answer(conn, actor, body.query, project_id=project_id,
                                  path_prefix=body.path_prefix, session_key=body.session_key)
        scope.detail.update(grounded=result["grounded"], top_score=result.get("top_score"),
                            sources=[c["path"] for c in result["citations"]])
    return result


# ── Delivery ──────────────────────────────────────────────────────────────────


@app.post("/api/send")
def send(body: SendBody, actor: Actor = Depends(require_actor)) -> dict:
    with audited(actor, "delivery.send", to=body.to, filename=body.filename, kind=body.kind) as scope, \
            connection() as conn:
        project = _project(conn, actor, body.project, scope)
        return delivery.send(conn, actor, project, to=body.to, filename=body.filename,
                             content=body.content, kind=body.kind, note=body.note,
                             install_path=body.install_path)


@app.get("/api/inbox")
def get_inbox(all: bool = False, actor: Actor = Depends(require_actor)) -> list[dict]:
    with connection() as conn:
        return delivery.inbox(conn, actor, include_handled=all)


@app.post("/api/inbox/{delivery_id}/accept")
def accept(delivery_id: UUID, actor: Actor = Depends(require_actor)) -> dict:
    with audited(actor, "delivery.accept", delivery=str(delivery_id)) as scope, connection() as conn:
        item = delivery.accept(conn, actor, delivery_id)
        scope.detail.update(filename=item["filename"], sender=item["from"])
    return item


@app.post("/api/inbox/{delivery_id}/decline")
def decline(delivery_id: UUID, actor: Actor = Depends(require_actor)) -> dict:
    with audited(actor, "delivery.decline", delivery=str(delivery_id)), connection() as conn:
        return delivery.decline(conn, actor, delivery_id)


# ── Governance ────────────────────────────────────────────────────────────────


@app.get("/api/audit")
def audit_log(limit: int = 50, actor: Actor = Depends(require_actor)) -> list[dict]:
    require_admin(actor)
    with connection() as conn:
        rows = conn.execute(
            """
            SELECT a.id, a.at, a.action, a.decision, a.reason, a.latency_ms, a.detail, a.client,
                   u.display_name AS user, d.name AS device, p.slug AS project
            FROM audit_events a
            LEFT JOIN users u ON u.id = a.user_id
            LEFT JOIN devices d ON d.id = a.device_id
            LEFT JOIN projects p ON p.id = a.project_id
            WHERE a.workspace_id = %s ORDER BY a.id DESC LIMIT %s
            """,
            (actor.workspace_id, min(limit, 500)),
        ).fetchall()
    return list(reversed(rows))


@app.get("/api/devices")
def devices(actor: Actor = Depends(require_actor)) -> list[dict]:
    with connection() as conn:
        return conn.execute(
            """
            SELECT d.id, d.name, d.scopes, d.last_seen_at, d.last_client, d.revoked_at,
                   u.display_name AS user, u.email
            FROM devices d JOIN users u ON u.id = d.user_id
            WHERE u.workspace_id = %s AND (%s OR u.id = %s)
            ORDER BY d.last_seen_at DESC
            """,
            (actor.workspace_id, actor.is_admin, actor.user_id),
        ).fetchall()


@app.post("/api/devices/{device_id}/revoke")
def revoke_device(device_id: UUID, actor: Actor = Depends(require_actor)) -> dict:
    with audited(actor, "device.revoke", device=str(device_id)), connection() as conn:
        row = conn.execute(
            """
            SELECT d.id, d.name, u.id AS user_id, u.display_name FROM devices d JOIN users u ON u.id = d.user_id
            WHERE d.id = %s AND u.workspace_id = %s
            """,
            (device_id, actor.workspace_id),
        ).fetchone()
        if row is None:
            raise NotFound("No such device")
        if not actor.is_admin and row["user_id"] != actor.user_id:
            raise PolicyDenied("Only admins can revoke other people's devices")
        conn.execute("UPDATE devices SET revoked_at = now() WHERE id = %s", (device_id,))
    bus.to_user(row["user_id"], {"type": "device.revoked", "device": row["name"]})
    return {"revoked": row["name"], "user": row["display_name"]}


@app.post("/api/agent-events")
def agent_event(body: AgentEventBody, actor: Actor = Depends(require_actor)) -> dict:
    """Activity reported by local agent hooks, e.g. a prompt blocked on the laptop."""
    record(actor, f"agent.{body.event}", body.decision, reason=body.reason, detail=body.detail)
    return {"recorded": True}


@app.websocket("/api/ws")
async def events(websocket: WebSocket, token: str, client: str | None = None):
    actor = await run_in_threadpool(actor_for_token, token, client)
    if actor is None:
        await websocket.close(code=4401)
        return
    await websocket.accept()
    queue = bus.subscribe(actor.user_id, actor.workspace_id if actor.is_admin else None, actor.device_id)
    await run_in_threadpool(record, actor, "device.online", "allow")
    try:
        await websocket.send_json({"type": "hello", "user": actor.display_name, "device": actor.device_name})
        while True:
            try:
                event = await asyncio.wait_for(queue.get(), timeout=25)
            except TimeoutError:
                event = {"type": "ping"}
            await websocket.send_json(event)
    except (WebSocketDisconnect, RuntimeError):
        pass
    finally:
        bus.unsubscribe(queue)
        await run_in_threadpool(record, actor, "device.offline", "allow")


# ── Dashboard ─────────────────────────────────────────────────────────────────

DASHBOARD_DEVICE = "Dashboard"
NON_AGENT_CLIENTS = ("dashboard", "cursor-hook", "loom-watch")
_dashboard_codes: dict[str, tuple[UUID, float]] = {}


@app.post("/api/dashboard/link")
def dashboard_link(actor: Actor = Depends(require_actor)) -> dict:
    """One-time, two-minute login link so the browser never sees the CLI's own token."""
    now = time.monotonic()
    for key in [k for k, (_, expires) in _dashboard_codes.items() if expires < now]:
        del _dashboard_codes[key]
    code, code_hash = new_secret("dsh_")
    _dashboard_codes[code_hash] = (actor.user_id, now + 120)
    return {"path": f"/#login={code}", "expires_in": 120}


@app.post("/api/dashboard/session")
def dashboard_session(body: DashboardLoginBody) -> dict:
    entry = _dashboard_codes.pop(hash_secret(body.code.strip()), None)
    if entry is None or entry[1] < time.monotonic():
        raise PolicyDenied("This dashboard link has expired; run `loom dashboard` again")
    with connection() as conn:
        conn.execute(
            "UPDATE devices SET revoked_at = now() WHERE user_id = %s AND name = %s AND revoked_at IS NULL",
            (entry[0], DASHBOARD_DEVICE),
        )
        token = _issue_device(conn, entry[0], DASHBOARD_DEVICE, scopes=["read"])
    actor = actor_for_token(token, "dashboard")
    record(actor, "dashboard.login", "allow")
    return {"token": token}


@app.get("/api/team")
def team(actor: Actor = Depends(require_actor)) -> dict:
    """The team tree: members, their computers and the agents seen on each."""
    online = bus.online_devices()
    with connection() as conn:
        name = conn.execute("SELECT name FROM workspaces WHERE id = %s", (actor.workspace_id,)).fetchone()["name"]
        members = conn.execute(
            """
            SELECT u.id, u.display_name AS name, u.email, u.is_admin,
                   coalesce((SELECT json_agg(json_build_object('slug', p.slug, 'role', m.role) ORDER BY p.slug)
                             FROM memberships m JOIN projects p ON p.id = m.project_id
                             WHERE m.user_id = u.id), '[]'::json) AS projects
            FROM users u WHERE u.workspace_id = %s
            ORDER BY u.is_admin DESC, u.created_at
            """,
            (actor.workspace_id,),
        ).fetchall()
        devices = conn.execute(
            """
            SELECT d.id, d.user_id, d.name, d.scopes, d.last_seen_at, d.revoked_at,
                   coalesce((SELECT array_agg(DISTINCT a.client ORDER BY a.client) FROM audit_events a
                             WHERE a.device_id = d.id AND a.client IS NOT NULL
                               AND a.client <> ALL(%s) AND a.at > now() - interval '7 days'),
                            '{}') AS agents
            FROM devices d JOIN users u ON u.id = d.user_id
            WHERE u.workspace_id = %s AND (%s OR u.id = %s)
              AND NOT (d.name = %s AND d.revoked_at IS NOT NULL)
            ORDER BY d.created_at
            """,
            (list(NON_AGENT_CLIENTS), actor.workspace_id, actor.is_admin, actor.user_id, DASHBOARD_DEVICE),
        ).fetchall()
        projects = conn.execute(
            """
            SELECT p.slug, p.name, p.description, m.role AS my_role,
                   (SELECT count(*) FROM memberships x WHERE x.project_id = p.id) AS members,
                   (SELECT count(*) FROM documents d WHERE d.project_id = p.id) AS documents,
                   (SELECT count(*) FROM chunks c WHERE c.project_id = p.id) AS chunks
            FROM projects p LEFT JOIN memberships m ON m.project_id = p.id AND m.user_id = %s
            WHERE p.workspace_id = %s AND (%s OR m.role IS NOT NULL)
            ORDER BY p.created_at
            """,
            (actor.user_id, actor.workspace_id, actor.is_admin),
        ).fetchall()
    recent = datetime.now(UTC) - timedelta(minutes=3)
    for device in devices:
        device["online"] = device["revoked_at"] is None and (
            device["id"] in online or device["last_seen_at"] > recent
        )
    for member in members:
        member["devices"] = [d for d in devices if d["user_id"] == member["id"]]
    return {"team": name, "me": actor.display_name, "is_admin": actor.is_admin,
            "members": members, "projects": projects, "providers": health()}


@app.get("/api/stats")
def stats(actor: Actor = Depends(require_actor)) -> dict:
    """Hourly counts for the last 24 hours, oldest hour first."""
    require_admin(actor)
    with connection() as conn:
        rows = conn.execute(
            """
            SELECT least(23, floor(extract(epoch FROM now() - at) / 3600))::int AS hours_ago,
                   action, decision, count(*) AS n
            FROM audit_events WHERE workspace_id = %s AND at > now() - interval '24 hours'
            GROUP BY 1, 2, 3
            """,
            (actor.workspace_id,),
        ).fetchall()
        agents = conn.execute(
            """
            SELECT count(DISTINCT (device_id, client)) AS n FROM audit_events
            WHERE workspace_id = %s AND at > now() - interval '24 hours'
              AND client IS NOT NULL AND client <> ALL(%s)
            """,
            (actor.workspace_id, list(NON_AGENT_CLIENTS)),
        ).fetchone()["n"]

    def series(match) -> dict:
        buckets = [0] * 24
        for row in rows:
            if match(row):
                buckets[23 - row["hours_ago"]] += row["n"]
        return {"total": sum(buckets), "series": buckets}

    questions = ("knowledge.ask", "knowledge.search")
    return {
        "questions": series(lambda r: r["action"] in questions and r["decision"] == "allow"),
        "delivered": series(lambda r: r["action"] == "delivery.send" and r["decision"] == "allow"),
        "stopped": series(lambda r: r["decision"] == "deny"),
        "agents": agents,
    }


app.mount("/", StaticFiles(directory=Path(__file__).parent / "static", html=True), name="dashboard")
