"""The whole team flow against a throwaway database (skipped when Postgres is not running)."""

import os

import psycopg
import pytest

ADMIN_URL = os.environ.get("LOOM_TEST_ADMIN_URL", "postgresql://loom:loom@localhost:5433/loom")
TEST_DB = "loom_test"


@pytest.fixture(scope="module")
def api(tmp_path_factory):
    try:
        with psycopg.connect(ADMIN_URL, autocommit=True, connect_timeout=2) as conn:
            conn.execute(f"DROP DATABASE IF EXISTS {TEST_DB} WITH (FORCE)")
            conn.execute(f"CREATE DATABASE {TEST_DB}")
    except psycopg.OperationalError:
        pytest.skip("Postgres is not running (docker compose up -d)")

    os.environ["LOOM_DATABASE_URL"] = ADMIN_URL.rsplit("/", 1)[0] + f"/{TEST_DB}"
    os.environ["LOOM_BLOB_DIR"] = str(tmp_path_factory.mktemp("blobs"))
    from fastapi.testclient import TestClient

    from loom_server import db
    from loom_server.api import app
    from loom_server.config import get_settings

    get_settings.cache_clear()
    db._pool = None
    with TestClient(app) as client:
        yield client
    get_settings.cache_clear()


def auth(token: str) -> dict:
    return {"Authorization": f"Bearer {token}", "X-Loom-Client": "pytest"}


def test_team_flow(api):
    alice = api.post("/api/bootstrap", json={
        "team_name": "Test Team", "email": "alice@example.com", "display_name": "Alice",
        "device_name": "alice-laptop",
    }).json()["token"]
    assert api.post("/api/bootstrap", json={
        "team_name": "Second", "email": "eve@example.com", "display_name": "Eve", "device_name": "x",
    }).status_code == 403

    for slug in ("app", "private"):
        assert api.post("/api/projects", json={"name": slug, "slug": slug}, headers=auth(alice)).status_code == 200
    upload = api.post("/api/projects/app/documents", headers=auth(alice), json={"files": [
        {"path": "docs/deploy.md", "content": "# Deploy\n\nWe deploy the gateway to EC2 with Docker Compose."},
        {"path": ".env", "content": "DB_PASSWORD=hunter2hunter2"},
        {"path": "config.py", "content": "token = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789'"},
    ]}).json()
    assert upload["indexed"] == 1
    assert {s["path"] for s in upload["skipped_files"]} == {".env", "config.py"}
    api.post("/api/projects/private/notes", headers=auth(alice),
             json={"title": "Salaries", "content": "The salary budget for the deploy team is 10k."})

    code = api.post("/api/invites", headers=auth(alice), json={
        "email": "bob@example.com", "display_name": "Bob", "project": "app",
    }).json()["code"]
    bob = api.post("/api/join", json={"code": code, "device_name": "bob-laptop"}).json()["token"]
    assert api.post("/api/join", json={"code": code, "device_name": "again"}).status_code == 403

    answer = api.post("/api/ask", headers=auth(bob), json={"query": "How do we deploy the gateway?"}).json()
    assert answer["grounded"] and answer["citations"][0]["path"] == "docs/deploy.md"
    salary = api.post("/api/ask", headers=auth(bob), json={"query": "What is the salary budget?"}).json()
    assert salary["answer"] == "Not in project knowledge."
    assert api.post("/api/ask", headers=auth(bob), json={"query": "salary", "project": "private"}).status_code == 403

    assert api.post("/api/projects", json={"name": "Bob's side project"}, headers=auth(bob)).status_code == 200
    bob_roles = {p["slug"]: p["role"] for p in api.get("/api/projects", headers=auth(bob)).json()}
    assert bob_roles == {"app": "member", "bob-s-side-project": "owner"}

    sent = api.post("/api/send", headers=auth(alice), json={
        "project": "app", "to": "Bob", "filename": "deploy/SKILL.md", "content": "# Deploy skill", "kind": "skill",
    }).json()
    assert sent["delivery"]["install_path"] == "skills/deploy/SKILL.md"
    blocked = api.post("/api/send", headers=auth(alice), json={
        "project": "app", "to": "Bob", "filename": "notes.txt", "content": "key AKIAZ3MHQ7XK2PLW4N8R",
    })
    assert blocked.status_code == 403 and "secrets" in blocked.json()["reason"]

    inbox = api.get("/api/inbox", headers=auth(bob)).json()
    assert [i["filename"] for i in inbox] == ["deploy"]
    accepted = api.post(f"/api/inbox/{inbox[0]['id']}/accept", headers=auth(bob)).json()
    assert accepted["content"] == "# Deploy skill"

    audit = api.get("/api/audit", headers=auth(alice)).json()
    decisions = {(e["action"], e["decision"]) for e in audit}
    assert {("delivery.send", "deny"), ("knowledge.ask", "deny"), ("delivery.accept", "allow")} <= decisions
    assert api.get("/api/audit", headers=auth(bob)).status_code == 403

    device = next(d for d in api.get("/api/devices", headers=auth(alice)).json() if d["user"] == "Bob")
    api.post(f"/api/devices/{device['id']}/revoke", headers=auth(alice))
    assert api.get("/api/me", headers=auth(bob)).status_code == 401


def _new_team(api, monkeypatch, team: str, name: str) -> str:
    from loom_server.config import get_settings

    monkeypatch.setenv("LOOM_OPEN_SIGNUP", "true")
    get_settings.cache_clear()
    body = {"team_name": team, "email": f"{name.lower()}@example.com", "display_name": name, "device_name": "d"}
    token = api.post("/api/bootstrap", json=body).json()["token"]
    monkeypatch.delenv("LOOM_OPEN_SIGNUP")
    get_settings.cache_clear()
    return token


def test_open_signup_teams_are_isolated(api, monkeypatch):
    zed = _new_team(api, monkeypatch, "Other Team", "Zed")

    assert api.get("/api/projects", headers=auth(zed)).json() == []
    answer = api.post("/api/ask", headers=auth(zed), json={"query": "How do we deploy the gateway?"}).json()
    assert answer["answer"] == "Not in project knowledge." and answer["citations"] == []
    assert api.post("/api/ask", headers=auth(zed), json={"query": "deploy", "project": "app"}).status_code == 404
    assert api.post("/api/projects", json={"name": "app", "slug": "app"}, headers=auth(zed)).status_code == 200
    note = {"project": "app", "to": "Alice", "filename": "hi.txt", "content": "hi"}
    sent = api.post("/api/send", headers=auth(zed), json=note)
    assert sent.status_code in (400, 404)
    team = api.get("/api/team", headers=auth(zed)).json()
    assert [m["name"] for m in team["members"]] == ["Zed"]
    assert {e["user"] for e in api.get("/api/audit", headers=auth(zed)).json()} <= {"Zed", None}


def test_team_link_lets_several_people_join(api, monkeypatch):
    kim = _new_team(api, monkeypatch, "Link Team", "Kim")
    api.post("/api/projects", json={"name": "Demo"}, headers=auth(kim))
    assert api.post("/api/invites", headers=auth(kim), json={"project": "demo", "role": "owner"}).status_code == 400
    link = api.post("/api/invites", headers=auth(kim), json={"project": "demo", "max_uses": 2}).json()
    assert link["max_uses"] == 2

    def join(email, name):
        body = {"code": link["code"], "device_name": "d", "email": email, "display_name": name}
        return api.post("/api/join", json=body)

    assert api.post("/api/join", json={"code": link["code"], "device_name": "d"}).status_code == 400
    assert join("kim@example.com", "Not Kim").status_code == 403
    lee = join("lee@example.com", "Lee").json()["token"]
    assert join("max@example.com", "Max").status_code == 200
    assert join("ned@example.com", "Ned").status_code == 403
    assert [p["slug"] for p in api.get("/api/projects", headers=auth(lee)).json()] == ["demo"]

    again = api.post("/api/invites", headers=auth(kim), json={"project": "demo"}).json()["code"]
    assert api.post("/api/invites/cancel", headers=auth(lee), json={"code": again}).status_code == 404
    assert api.post("/api/invites/cancel", headers=auth(kim), json={"code": again}).json()["cancelled"]
    body = {"code": again, "device_name": "d", "email": "ola@example.com", "display_name": "Ola"}
    assert api.post("/api/join", json=body).status_code == 403

    personal = api.post(
        "/api/invites", headers=auth(kim), json={"email": "pat@example.com", "display_name": "Pat"}
    ).json()
    assert personal["max_uses"] == 1
    assert api.post("/api/join", json={"code": personal["code"], "device_name": "d"}).json()["user"] == "Pat"
    assert api.post("/api/join", json={"code": personal["code"], "device_name": "d"}).status_code == 403
