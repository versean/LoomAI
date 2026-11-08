from __future__ import annotations

import math
from functools import lru_cache
from typing import Protocol

from ..config import get_settings
from .text import content_terms, stem, tokenize


class Reranker(Protocol):
    name: str
    default_threshold: float

    def score(self, query: str, documents: list[str]) -> list[float]:
        """Relevance in [0, 1] for each document, in input order."""
        ...


class LexicalReranker:
    """IDF-weighted share of query terms present in each candidate.

    A stand-in for a cross-encoder when no model is available: it re-scores the fused
    pool and lets the refusal threshold work, but does not understand paraphrases.
    """

    name = "lexical-v1"
    default_threshold = 0.5  # a passage must cover most of the question's weighted terms

    def score(self, query: str, documents: list[str]) -> list[float]:
        terms = list(dict.fromkeys(stem(t) for t in content_terms(query)))
        if not terms or not documents:
            return [0.0] * len(documents)
        doc_tokens = [{stem(t) for t in tokenize(doc)} for doc in documents]
        n = len(documents)
        weights = {
            term: math.log(1.0 + (n + 1) / (1 + sum(term in tokens for tokens in doc_tokens)))
            for term in terms
        }
        total = sum(weights.values())
        return [
            sum(w for term, w in weights.items() if term in tokens) / total for tokens in doc_tokens
        ]


class BedrockReranker:
    name = "bedrock-rerank"
    default_threshold = 0.25

    def __init__(self, model_arn: str, region: str):
        import boto3

        self.model_arn = model_arn
        self.client = boto3.client("bedrock-agent-runtime", region_name=region)

    def score(self, query: str, documents: list[str]) -> list[float]:
        if not documents:
            return []
        response = self.client.rerank(
            queries=[{"type": "TEXT", "textQuery": {"text": query}}],
            sources=[
                {
                    "type": "INLINE",
                    "inlineDocumentSource": {"type": "TEXT", "textDocument": {"text": doc}},
                }
                for doc in documents
            ],
            rerankingConfiguration={
                "type": "BEDROCK_RERANKING_MODEL",
                "bedrockRerankingConfiguration": {
                    "numberOfResults": len(documents),
                    "modelConfiguration": {"modelArn": self.model_arn},
                },
            },
        )
        scores = [0.0] * len(documents)
        for result in response["results"]:
            scores[result["index"]] = float(result["relevanceScore"])
        return scores


@lru_cache
def get_reranker() -> Reranker:
    settings = get_settings()
    if settings.rerank_provider == "bedrock":
        return BedrockReranker(settings.bedrock_rerank_model_arn, settings.aws_region)
    return LexicalReranker()
