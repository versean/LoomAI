"""Talk to `loom mcp` over stdio exactly like Cursor does, and print each tool's answer.

    uv run python scripts/mcp_smoke.py [--home ~/.loom] [--workspace .] [tool-name '{"arg": 1}' ...]

Without tool arguments it lists the tools and calls `whoami` and `check_inbox`.
"""

from __future__ import annotations

import argparse
import json
import shutil
from pathlib import Path

import anyio
from mcp import types
from mcp.client.session import ClientSession
from mcp.client.stdio import StdioServerParameters, stdio_client


async def main(home: str | None, workspace: Path, calls: list[tuple[str, dict]]) -> None:
    env = {"LOOM_HOME": home} if home else {}
    server = StdioServerParameters(command=shutil.which("loom") or "loom", args=["mcp"], env=env)

    async def roots(_context) -> types.ListRootsResult:
        return types.ListRootsResult(roots=[types.Root(uri=workspace.resolve().as_uri(), name=workspace.name)])

    async with (
        stdio_client(server) as (read, write),
        ClientSession(
            read,
            write,
            list_roots_callback=roots,
            client_info=types.Implementation(name="mcp-smoke", version="0.1"),
        ) as session,
    ):
        init = await session.initialize()
        print(f"== connected to '{init.server_info.name}'")
        tools = await session.list_tools()
        print("== tools:", ", ".join(t.name for t in tools.tools))
        for name, arguments in calls or [("whoami", {}), ("check_inbox", {})]:
            result = await session.call_tool(name, arguments)
            text = "\n".join(c.text for c in result.content if isinstance(c, types.TextContent))
            print(f"\n== {name}({json.dumps(arguments)})\n{text}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--home", help="LOOM_HOME of the identity to use")
    parser.add_argument("--workspace", type=Path, default=Path.cwd(), help="Folder reported as the open project")
    parser.add_argument("calls", nargs="*", help="tool name followed by a JSON object of arguments")
    args = parser.parse_args()
    pairs = [(args.calls[i], json.loads(args.calls[i + 1])) for i in range(0, len(args.calls), 2)]
    anyio.run(main, args.home, args.workspace, pairs)
