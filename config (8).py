from functools import lru_cache
from pathlib import Path
from typing import Literal

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="LOOM_", env_file=".env", extra="ignore")

    database_url: str = "postgresql://loom:loom@localhost:5433/loom"
    host: str = "127.0.0.1"
    port: int = 8787

    blob_dir: Path = Path("data/blobs")
    s3_bucket: str | None = None
    aws_region: str = "us-east-1"

    embedding_provider: Literal["hash", "bedrock"] = "hash"
    rerank_provider: Literal["lexical", "bedrock"] = "lexical"
    llm_provider: Literal["none", "bedrock", "ollama"] = "none"

    bedrock_embedding_model: str = "cohere.embed-multilingual-v3"
    bedrock_fast_model: str = "us.anthropic.claude-haiku-4-5-20251001-v1:0"
    bedrock_answer_model: str = "us.anthropic.claude-sonnet-4-5-20250929-v1:0"
    bedrock_rerank_model_arn: str = (
        "arn:aws:bedrock:us-east-1::foundation-model/cohere.rerank-v3-5:0"
    )
    guardrail_id: str | None = None
    guardrail_version: str = "DRAFT"

    ollama_url: str = "http://localhost:11434"
    ollama_model: str = "qwen3:14b"

    # Retrieval parameters carried over from the thesis pipeline.
    pool_size: int = 20
    top_k: int = 5
    rrf_k: int = 60
    rrf_dense_weight: float = 0.7
    rrf_sparse_weight: float = 0.3
    # Minimum reranker score for an answer; None picks the default for the active reranker.
    relevance_threshold: float | None = None

    history_turns: int = 4
    history_window_minutes: int = 30

    max_file_bytes: int = 400_000
    max_artifact_bytes: int = 1_000_000

    bootstrap_secret: str | None = None
    # Hosted mode: anyone may start a new team without the secret. Teams never see each other's data.
    open_signup: bool = False


@lru_cache
def get_settings() -> Settings:
    return Settings()
