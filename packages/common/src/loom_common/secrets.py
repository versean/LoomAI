"""Detection of credentials in text and of files that should never leave a machine."""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import PurePosixPath


@dataclass(frozen=True)
class Finding:
    rule: str
    line: int
    preview: str

    def describe(self) -> str:
        return f"{self.rule} on line {self.line} ({self.preview})"


_RULES: list[tuple[str, re.Pattern[str]]] = [
    ("aws_access_key_id", re.compile(r"\b(?:AKIA|ASIA)[0-9A-Z]{16}\b")),
    (
        "aws_secret_access_key",
        re.compile(r"(?i)aws.{0,20}(?:secret|private).{0,20}[:=]\s*['\"]?([A-Za-z0-9/+]{40})\b"),
    ),
    ("private_key", re.compile(r"-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY")),
    ("github_token", re.compile(r"\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,})\b")),
    ("slack_token", re.compile(r"\bxox[abprs]-[A-Za-z0-9-]{10,}\b")),
    ("llm_api_key", re.compile(r"\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{32,}\b")),
    ("google_api_key", re.compile(r"\bAIza[0-9A-Za-z_-]{35}\b")),
    ("stripe_live_key", re.compile(r"\b[rs]k_live_[0-9A-Za-z]{24,}\b")),
    ("jwt", re.compile(r"\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}")),
    (
        "assigned_secret",
        re.compile(
            r"(?i)(?<![A-Za-z0-9])"
            r"(?:password|passwd|pwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token)"
            r"[A-Za-z0-9_]*[\"']?\s*[:=]\s*[\"']?([^\s\"'`,;]{8,})"
        ),
    ),
]

_PLACEHOLDER = re.compile(
    r"(?i)^(?:x{4,}|\*{4,}|changeme|change_me|example|placeholder|dummy|test|password|secret|"
    r"your[_-].*|<.*>|\$\{.*\}|\{\{.*\}\}|\$[A-Z_]+|os\.environ.*|process\.env.*|null|none|true|false)$"
)
# Right-hand sides that are code, e.g. ``password = request.form["password"]``.
_CODE_EXPRESSION = re.compile(r"[(\[{]|^[A-Za-z_]\w*\.[A-Za-z_]")

_SENSITIVE_NAMES = {
    ".env",
    "id_rsa",
    "id_dsa",
    "id_ecdsa",
    "id_ed25519",
    "credentials",
    ".netrc",
    ".pgpass",
}
_SENSITIVE_SUFFIXES = {".pem", ".key", ".p12", ".pfx", ".keystore", ".jks"}
_SAFE_ENV_SUFFIXES = {".example", ".sample", ".template", ".dist"}


def _preview(value: str) -> str:
    return value[:4] + "…" if len(value) > 4 else "…"


def scan_text(text: str) -> list[Finding]:
    """Return every credential-looking value in ``text``; placeholders are ignored."""
    findings: list[Finding] = []
    for line_no, line in enumerate(text.splitlines(), start=1):
        for rule, pattern in _RULES:
            for match in pattern.finditer(line):
                value = match.group(match.lastindex or 0)
                if rule == "assigned_secret" and (
                    _PLACEHOLDER.match(value) or _CODE_EXPRESSION.search(value)
                ):
                    continue
                findings.append(Finding(rule=rule, line=line_no, preview=_preview(value)))
    return findings


def is_sensitive_path(path: str) -> bool:
    """True for files whose purpose is to hold credentials, e.g. ``.env`` or ``id_rsa``."""
    name = PurePosixPath(path.replace("\\", "/")).name.lower()
    if name.startswith(".env"):
        return not any(name.endswith(suffix) for suffix in _SAFE_ENV_SUFFIXES)
    return name in _SENSITIVE_NAMES or PurePosixPath(name).suffix in _SENSITIVE_SUFFIXES
