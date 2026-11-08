"""Every allow/deny rule lives here so it can be read, tested and audited in one place."""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from uuid import UUID

import psycopg

from loom_common.secrets import Finding

from .auth import Actor
from .errors import NotFound, PolicyDenied

ROLES = ("owner", "member", "viewer")
WRITE_ROLES = {"owner", "member"}


@dataclass(frozen=True)
class Project:
    id: UUID
    slug: str
    name: str
    role: str | None


def resolve_project(conn: psycopg.Connection, actor: Actor, slug: str) -> Project:
    row = conn.execute(
        """
        SELECT p.id, p.slug, p.name, m.role
        FROM projects p
        LEFT JOIN memberships m ON m.project_id = p.id AND m.user_id = %s
        WHERE p.workspace_id = %s AND p.slug = %s
        """,
        (actor.user_id, actor.workspace_id, slug.strip().lower()),
    ).fetchone()
    if row is None:
        raise NotFound(f"No project '{slug}' in this team")
    return Project(id=row["id"], slug=row["slug"], name=row["name"], role=row["role"])


def require_read(actor: Actor, project: Project) -> None:
    if "read" not in actor.scopes:
        raise PolicyDenied(f"Device '{actor.device_name}' is not allowed to read project knowledge")
    if project.role is None:
        raise PolicyDenied(f"{actor.display_name} is not a member of project '{project.slug}'")


def require_write(actor: Actor, project: Project) -> None:
    require_read(actor, project)
    if project.role not in WRITE_ROLES:
        raise PolicyDenied(f"Role '{project.role}' cannot add knowledge to '{project.slug}'")


def require_manage(actor: Actor, project: Project) -> None:
    if not (actor.is_admin or project.role == "owner"):
        raise PolicyDenied(f"Only owners can manage project '{project.slug}'")


def require_admin(actor: Actor) -> None:
    if not actor.is_admin:
        raise PolicyDenied("Only team admins can do this")


def decide_share(
    *,
    sender_role: str | None,
    device_scopes: Sequence[str],
    recipient_role: str | None,
    recipient_is_sender: bool,
    sensitive_path: bool,
    findings: Sequence[Finding],
) -> str | None:
    """Return the reason a share is denied, or ``None`` when it is allowed."""
    if "share" not in device_scopes:
        return "This device is read-only and cannot send files"
    if sender_role is None:
        return "Sender is not a member of this project"
    if sender_role not in WRITE_ROLES:
        return f"Role '{sender_role}' cannot send files from this project"
    if recipient_is_sender:
        return "Sender and recipient are the same person"
    if recipient_role is None:
        return "Recipient is not a member of this project"
    if sensitive_path:
        return "Credential files (.env, keys, certificates) can never be sent"
    if findings:
        details = "; ".join(f.describe() for f in findings[:3])
        return f"Content contains secrets: {details}"
    return None
