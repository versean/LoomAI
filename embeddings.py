from __future__ import annotations

import hashlib
import json
import math
from collections import Counter
from functools import lru_cache
from typing import Protocol

import numpy as np

from ..config import get_settings
from .text import STOPWORDS, tokenize

DIM = 1024


class Embedder(Protocol):
    name: str

    def embed_documents(self, texts: list[str]) -> list[np.ndarray]: ...
    def embed_query(self, text: str) -> np.ndarray: ...


class HashEmbedder:
    """Signed feature hashing of words, word pairs and character n-grams.

    Needs no model download, so the whole pipeline runs offline; semantic quality is far
    below a trained model, which is why production uses Bedrock.
    """

    name = "hash-v1"

    def _features(self, text: str) -> Counter[str]:
        words = [w for w in tokenize(text) if w not in STOPWORDS]
        features: Counter[str] = Counter()
        for word in words:
            features[f"w:{word}"] += 1.0
            if len(word) > 5:
                for i in range(len(word) - 3):
                    features[f"c:{word[i:i + 4]}"] += 0.25
        for left, right in zip(words, words[1:], strict=False):
            features[f"b:{left}_{right}"] += 0.5
        return features

    def _vector(self, text: str) -> np.ndarray:
        vector = np.zeros(DIM, dtype=np.float32)
        for feature, weight in self._features(text).items():
            digest = hashlib.blake2b(feature.encode(), digest_size=8).digest()
            value = int.from_bytes(digest, "little")
            sign = 1.0 if value & 1 else -1.0
            damped = 1.0 + math.log(weight) if weight > 1 else weight
            vector[(value >> 1) % DIM] += sign * damped
        norm = float(np.linalg.norm(vector))
        if norm == 0.0:
            vector[0] = 1.0
            return vector
        return vector / norm

    def embed_documents(self, texts: list[str]) -> list[np.ndarray]:
        return [self._vector(t) for t in texts]

    def embed_query(self, text: str) -> np.ndarray:
        return self._vector(text)


class BedrockCohereEmbedder:
    """Cohere Embed on Bedrock; ``input_type`` plays the role of e5's query:/passage: prefixes."""

    max_batch = 96
    max_chars = 2048

    def __init__(self, model_id: str, region: str):
        import boto3

        self.name = model_id
        self.model_id = model_id
        self.client = boto3.client("bedrock-runtime", region_name=region)

    def _embed(self, texts: list[str], input_type: str) -> list[np.ndarray]:
        vectors: list[np.ndarray] = []
        for start in range(0, len(texts), self.max_batch):
            batch = [t[: self.max_chars] for t in texts[start : start + self.max_batch]]
            response = self.client.invoke_model(
                modelId=self.model_id,
                body=json.dumps({"texts": batch, "input_type": input_type, "truncate": "END"}),
            )
            payload = json.loads(response["body"].read())
            for embedding in payload["embeddings"]:
                vector = np.asarray(embedding, dtype=np.float32)
                if vector.shape[0] != DIM:
                    raise ValueError(f"{self.model_id} returned {vector.shape[0]} dims, expected {DIM}")
                vectors.append(vector / max(float(np.linalg.norm(vector)), 1e-12))
        return vectors

    def embed_documents(self, texts: list[str]) -> list[np.ndarray]:
        return self._embed(texts, "search_document")

    def embed_query(self, text: str) -> np.ndarray:
        return self._embed([text], "search_query")[0]


@lru_cache
def get_embedder() -> Embedder:
    settings = get_settings()
    if settings.embedding_provider == "bedrock":
        return BedrockCohereEmbedder(settings.bedrock_embedding_model, settings.aws_region)
    return HashEmbedder()
