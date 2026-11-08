import logging

import uvicorn

from .config import get_settings


def run() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    settings = get_settings()
    uvicorn.run("loom_server.api:app", host=settings.host, port=settings.port)
