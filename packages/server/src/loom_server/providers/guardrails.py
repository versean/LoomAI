from __future__ import annotations

from functools import lru_cache

from ..config import get_settings


class BedrockGuardrail:
    """Bedrock Guardrails check for PII and prompt attacks, used in addition to the secret scanner."""

    def __init__(self, guardrail_id: str, version: str, region: str):
        import boto3

        self.guardrail_id = guardrail_id
        self.version = version
        self.client = boto3.client("bedrock-runtime", region_name=region)

    def check(self, text: str, *, source: str = "OUTPUT") -> str | None:
        """Return why the guardrail intervened, or ``None`` if the text passes."""
        response = self.client.apply_guardrail(
            guardrailIdentifier=self.guardrail_id,
            guardrailVersion=self.version,
            source=source,
            content=[{"text": {"text": text[:20_000]}}],
        )
        if response.get("action") != "GUARDRAIL_INTERVENED":
            return None
        reasons: list[str] = []
        for assessment in response.get("assessments", []):
            for entity in assessment.get("sensitiveInformationPolicy", {}).get("piiEntities", []):
                reasons.append(f"PII: {entity.get('type')}")
            for item in assessment.get("contentPolicy", {}).get("filters", []):
                reasons.append(f"content filter: {item.get('type')}")
        return "Blocked by Bedrock Guardrails" + (f" ({', '.join(sorted(set(reasons)))})" if reasons else "")


@lru_cache
def get_guardrail() -> BedrockGuardrail | None:
    settings = get_settings()
    if not settings.guardrail_id:
        return None
    return BedrockGuardrail(settings.guardrail_id, settings.guardrail_version, settings.aws_region)
