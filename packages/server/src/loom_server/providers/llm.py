from __future__ import annotations

import re
from functools import lru_cache
from typing import Literal, Protocol

import httpx

from ..config import get_settings

Tier = Literal["fast", "answer"]
_THINK = re.compile(r"<think>.*?</think>", re.DOTALL)


class LLM(Protocol):
    available: bool
    name: str

    def complete(
        self, system: str, prompt: str, *, tier: Tier, max_tokens: int = 800, json_mode: bool = False
    ) -> str: ...


class NoLLM:
    """Generation disabled: callers fall back to extractive answers and heuristics."""

    available = False
    name = "none"

    def complete(self, system, prompt, *, tier, max_tokens=800, json_mode=False) -> str:
        raise RuntimeError("No LLM provider configured")


class BedrockLLM:
    available = True

    def __init__(self, fast_model: str, answer_model: str, region: str):
        import boto3

        self.models = {"fast": fast_model, "answer": answer_model}
        self.name = answer_model
        self.client = boto3.client("bedrock-runtime", region_name=region)

    def complete(self, system, prompt, *, tier, max_tokens=800, json_mode=False) -> str:
        if json_mode:
            prompt += "\n\nRespond with a single JSON object and nothing else."
        response = self.client.converse(
            modelId=self.models[tier],
            system=[{"text": system}],
            messages=[{"role": "user", "content": [{"text": prompt}]}],
            inferenceConfig={"maxTokens": max_tokens, "temperature": 0.1},
        )
        parts = response["output"]["message"]["content"]
        return "".join(part.get("text", "") for part in parts).strip()


class OllamaLLM:
    """Local Qwen through Ollama, the generator used in the thesis."""

    available = True

    def __init__(self, url: str, model: str):
        self.url = url.rstrip("/")
        self.name = model

    def complete(self, system, prompt, *, tier, max_tokens=800, json_mode=False) -> str:
        body = {
            "model": self.name,
            "stream": False,
            "think": False,
            "messages": [{"role": "system", "content": system}, {"role": "user", "content": prompt}],
            "options": {"temperature": 0.1, "num_predict": max_tokens},
        }
        if json_mode:
            body["format"] = "json"
        response = httpx.post(f"{self.url}/api/chat", json=body, timeout=300)
        response.raise_for_status()
        return _THINK.sub("", response.json()["message"]["content"]).strip()


@lru_cache
def get_llm() -> LLM:
    settings = get_settings()
    if settings.llm_provider == "bedrock":
        return BedrockLLM(settings.bedrock_fast_model, settings.bedrock_answer_model, settings.aws_region)
    if settings.llm_provider == "ollama":
        return OllamaLLM(settings.ollama_url, settings.ollama_model)
    return NoLLM()
