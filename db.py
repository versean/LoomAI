from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager
from importlib.resources import files

import psycopg
from pgvector.psycopg import register_vector
from psycopg.rows import dict_row
from psycopg_pool import ConnectionPool

from .config import get_settings

_pool: ConnectionPool | None = None


def apply_schema(database_url: str) -> None:
    schema = files("loom_server").joinpath("schema.sql").read_text()
    with psycopg.connect(database_url, autocommit=True) as conn:
        conn.execute(schema)


def _configure(conn: psycopg.Connection) -> None:
    register_vector(conn)
    # Keep scanning the HNSW index until enough rows survive the permission filter.
    conn.execute("SET hnsw.iterative_scan = relaxed_order")
    conn.commit()


def open_pool() -> ConnectionPool:
    global _pool
    if _pool is None:
        settings = get_settings()
        apply_schema(settings.database_url)
        _pool = ConnectionPool(
            settings.database_url,
            min_size=1,
            max_size=10,
            kwargs={"row_factory": dict_row},
            configure=_configure,
            open=True,
        )
    return _pool


def close_pool() -> None:
    global _pool
    if _pool is not None:
        _pool.close()
        _pool = None


@contextmanager
def connection() -> Iterator[psycopg.Connection]:
    """A pooled connection that commits on success and rolls back on error."""
    with open_pool().connection() as conn:
        yield conn
