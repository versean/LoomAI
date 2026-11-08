from __future__ import annotations

import hashlib
import secrets
from dataclasses import dataclass
from uuid import UUID

from fastapi import Header, HTTPException, Request

from .db import connection

TOKEN_PREFIX = "loom_"
INVITE_PREFIX = "inv_"


@dataclass(frozen=True)
class Actor:
    user_id: UUID
    workspace_id: UUID
    email: str
    display_name: str
    is_admin: bool
    device_id: UUID
    device_name: str
    scopes: tuple[str, ...]
    client: str | None

    def label(self) -> str:
        client = f" via {self.client}" if self.client else ""
        return f"{self.display_name} ({self.device_name}{client})"


def new_secret(prefix: str) -> tuple[str, str]:
    """Return ``(plaintext, sha256)``; only the hash is ever stored."""
    value = prefix + secrets.token_urlsafe(32)
    return value, hash_secret(value)


def hash_secret(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


def actor_for_token(token: str, client: str | None) -> Actor | None:
    with connection() as conn:
        row = conn.execute(
            """
            SELECT d.id AS device_id, d.name AS device_name, d.scopes,
                   u.id AS user_id, u.workspace_id, u.email, u.display_name, u.is_admin
            FROM devices d JOIN users u ON u.id = d.user_id
            WHERE d.token_hash = %s AND d.revoked_at IS NULL
            """,
            (hash_secret(token),),
        ).fetchone()
        if row is None:
            return None
        conn.execute(
            """
            UPDATE devices SET last_seen_at = now(), last_client = coalesce(%s, last_client)
            WHERE id = %s AND (last_seen_at < now() - interval '15 seconds'
                               OR last_client IS DISTINCT FROM coalesce(%s, last_client))
            """,
            (client, row["device_id"], client),
        )
    return Actor(
        user_id=row["user_id"],
        workspace_id=row["workspace_id"],
        email=row["email"],
        display_name=row["display_name"],
        is_admin=row["is_admin"],
        device_id=row["device_id"],
        device_name=row["device_name"],
        scopes=tuple(row["scopes"]),
        client=client,
    )


def require_actor(
    request: Request,
    authorization: str | None = Header(default=None),
    x_loom_client: str | None = Header(default=None),
) -> Actor:
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(status_code=401, detail="Missing bearer token")
    actor = actor_for_token(authorization.split(" ", 1)[1].strip(), x_loom_client)
    if actor is None:
        raise HTTPException(status_code=401, detail="Unknown or revoked device token")
    request.state.actor = actor
    return actor
