from __future__ import annotations

from functools import lru_cache
from pathlib import Path
from typing import Protocol

from .config import get_settings


class BlobStore(Protocol):
    def put(self, key: str, data: bytes) -> None: ...
    def get(self, key: str) -> bytes: ...


class LocalBlobStore:
    def __init__(self, root: Path):
        self.root = root.resolve()

    def _path(self, key: str) -> Path:
        path = (self.root / key).resolve()
        if not path.is_relative_to(self.root):
            raise ValueError(f"Invalid blob key: {key}")
        return path

    def put(self, key: str, data: bytes) -> None:
        path = self._path(key)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)

    def get(self, key: str) -> bytes:
        return self._path(key).read_bytes()


class S3BlobStore:
    def __init__(self, bucket: str, region: str):
        import boto3

        self.bucket = bucket
        self.client = boto3.client("s3", region_name=region)

    def put(self, key: str, data: bytes) -> None:
        self.client.put_object(
            Bucket=self.bucket, Key=key, Body=data, ServerSideEncryption="aws:kms"
        )

    def get(self, key: str) -> bytes:
        return self.client.get_object(Bucket=self.bucket, Key=key)["Body"].read()


@lru_cache
def get_blob_store() -> BlobStore:
    settings = get_settings()
    if settings.s3_bucket:
        return S3BlobStore(settings.s3_bucket, settings.aws_region)
    return LocalBlobStore(settings.blob_dir)
