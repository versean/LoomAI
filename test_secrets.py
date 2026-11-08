from loom_common.secrets import is_sensitive_path, scan_text


def test_detects_real_credentials():
    text = "\n".join(
        [
            "AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE",
            "token = ghp_" + "a" * 36,
            "-----BEGIN OPENSSH PRIVATE KEY-----",
            'DB_PASSWORD="s3cr3t-Value-123"',
        ]
    )
    rules = {f.rule for f in scan_text(text)}
    assert {"aws_access_key_id", "github_token", "private_key", "assigned_secret"} <= rules


def test_ignores_placeholders_and_env_references():
    text = "\n".join(
        [
            "password = changeme",
            "api_key: ${API_KEY}",
            "secret = os.environ['SECRET']",
            "token: <your-token>",
            'password = request.form["password"]',
            "password_hash = generate_password_hash(raw_password)",
        ]
    )
    assert scan_text(text) == []


def test_findings_never_contain_the_full_secret():
    secret = "AKIAIOSFODNN7EXAMPLE"
    (finding,) = scan_text(f"key={secret}")
    assert secret not in finding.preview
    assert finding.line == 1


def test_sensitive_paths():
    assert is_sensitive_path(".env")
    assert is_sensitive_path("config/.env.production")
    assert is_sensitive_path("keys/server.pem")
    assert is_sensitive_path("~/.ssh/id_ed25519")
    assert not is_sensitive_path(".env.example")
    assert not is_sensitive_path("src/env.py")
    assert not is_sensitive_path("skills/deploy/SKILL.md")
