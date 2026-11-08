"""In-process pub/sub that pushes events to connected CLIs over WebSocket.

A single gateway instance is assumed; running several would need a shared channel
such as Postgres LISTEN/NOTIFY.
"""

from __future__ import annotations

import asyncio
from collections import defaultdict
from typing import Any
from uuid import UUID


class EventBus:
    def __init__(self) -> None:
        self._loop: asyncio.AbstractEventLoop | None = None
        self._user_queues: dict[UUID, set[asyncio.Queue]] = defaultdict(set)
        self._admin_queues: dict[UUID, set[asyncio.Queue]] = defaultdict(set)
        self._queue_device: dict[asyncio.Queue, UUID] = {}

    def bind(self, loop: asyncio.AbstractEventLoop) -> None:
        self._loop = loop

    def subscribe(self, user_id: UUID, workspace_id: UUID | None, device_id: UUID | None = None) -> asyncio.Queue:
        queue: asyncio.Queue = asyncio.Queue(maxsize=500)
        self._user_queues[user_id].add(queue)
        if device_id is not None:
            self._queue_device[queue] = device_id
        if workspace_id is not None:
            self._admin_queues[workspace_id].add(queue)
        return queue

    def unsubscribe(self, queue: asyncio.Queue) -> None:
        self._queue_device.pop(queue, None)
        for registry in (self._user_queues, self._admin_queues):
            for queues in registry.values():
                queues.discard(queue)

    def online_devices(self) -> set[UUID]:
        """Devices holding a live connection right now (``loom watch`` or the dashboard)."""
        return set(self._queue_device.values())

    def to_user(self, user_id: UUID, event: dict[str, Any]) -> None:
        self._dispatch(self._user_queues.get(user_id, ()), event)

    def to_admins(self, workspace_id: UUID, event: dict[str, Any]) -> None:
        self._dispatch(self._admin_queues.get(workspace_id, ()), event)

    def _dispatch(self, queues, event: dict[str, Any]) -> None:
        if self._loop is None or not queues:
            return
        for queue in list(queues):
            self._loop.call_soon_threadsafe(_offer, queue, event)


def _offer(queue: asyncio.Queue, event: dict[str, Any]) -> None:
    if not queue.full():
        queue.put_nowait(event)


bus = EventBus()
