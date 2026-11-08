from __future__ import annotations

from typing import Any
from urllib.parse import quote

import httpx

from .config import Config


class LoomError(Exception):
    def __init__(self, status: int, reason: str, kind: str | None = None):
        super().__init__(reason)
        self.status = status
        self.reason = reason
        self.kind = kind

    @property
    def denied(self) -> bool:
        return self.kind == "denied"


class LoomClient:
    def __init__(self, config: Config, client_name: str | None = None, timeout: float = 120):
        headers = {"User-Agent": "loom-cli/0.1"}
        if config.token:
            headers["Authorization"] = f"Bearer {config.token}"
        if client_name:
            headers["X-Loom-Client"] = client_name
        self.config = config
        self.client_name = client_name
        self._http = httpx.Client(base_url=config.server_url, headers=headers, timeout=timeout)

    def request(self, method: str, path: str, **kwargs: Any) -> Any:
        try:
            response = self._http.request(method, path, **kwargs)
        except httpx.ConnectError as error:
            raise LoomError(0, f"Cannot reach Loom AI at {self.config.server_url}") from error
        if response.status_code >= 400:
            try:
                body = response.json()
            except ValueError:
                body = {}
            reason = body.get("reason") or body.get("detail") or response.text or response.reason_phrase
            raise LoomError(response.status_code, str(reason), body.get("error"))
        return response.json() if response.content else None

    def get(self, path: str, **params: Any) -> Any:
        return self.request("GET", path, params={k: v for k, v in params.items() if v is not None})

    def post(self, path: str, body: dict | None = None) -> Any:
        return self.request("POST", path, json=body or {})

    def delete(self, path: str) -> Any:
        return self.request("DELETE", path)

    def websocket_url(self) -> str:
        base = self.config.server_url.replace("https://", "wss://").replace("http://", "ws://")
        url = f"{base}/api/ws?token={quote(self.config.token or '')}"
        return url + (f"&client={quote(self.client_name)}" if self.client_name else "")

    def resolve_project(self, project: str | None) -> str:
        """Explicit project, else the configured default, else the only project the user has."""
        if project:
            return project
        if self.config.default_project:
            return self.config.default_project
        projects = self.get("/api/projects")
        if len(projects) == 1:
            return projects[0]["slug"]
        names = ", ".join(p["slug"] for p in projects) or "none yet"
        raise LoomError(400, f"Which project? You are in: {names}")
