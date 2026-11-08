// Starts a throwaway hub in secure mode and checks every auth gate. No model calls.
//   node test/auth.test.mjs
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const PORT = 4299, BASE = `http://localhost:${PORT}`, PW = "test-password-123";
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hivemind-auth-"));
const srv = spawn(process.execPath, ["src/server.js"], { env: { ...process.env, PORT: String(PORT), HIVEMIND_DATA_DIR: dir, HIVEMIND_PASSWORD: PW, HIVEMIND_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "unused" }, stdio: "pipe" });
let ok = 0, fail = 0;
const check = (name, cond) => { cond ? ok++ : fail++; console.log(`${cond ? "PASS" : "FAIL"}  ${name}`); };

try {
  for (let i = 0; i < 50; i++) { try { if ((await fetch(`${BASE}/health`)).ok) break; } catch {} await new Promise(r => setTimeout(r, 200)); }
  check("health is public", (await fetch(`${BASE}/health`)).ok);
  check("dashboard page is public (login screen)", (await fetch(`${BASE}/`)).ok);
  check("/api/state blocked without login", (await fetch(`${BASE}/api/state`)).status === 401);
  check("SSE blocked without login", (await fetch(`${BASE}/api/events`)).status === 401);
  check("wrong password rejected", (await fetch(`${BASE}/api/login`, { method: "POST", body: JSON.stringify({ password: "nope" }) })).status === 401);
  const login = await fetch(`${BASE}/api/login`, { method: "POST", body: JSON.stringify({ password: PW }) });
  const cookie = (login.headers.get("set-cookie") || "").split(";")[0];
  check("right password sets HttpOnly session cookie", login.ok && cookie.startsWith("hm_session=") && /HttpOnly/.test(login.headers.get("set-cookie")));
  check("/api/state works with session", (await fetch(`${BASE}/api/state`, { headers: { cookie } })).ok);
  check("forged cookie rejected", (await fetch(`${BASE}/api/state`, { headers: { cookie: "hm_session=99999999999999.forged" } })).status === 401);

  check("/mcp blocked without token", (await fetch(`${BASE}/mcp?agent=mallory`, { method: "POST", body: "{}" })).status === 401);
  const t = await (await fetch(`${BASE}/api/tokens`, { method: "POST", headers: { cookie }, body: JSON.stringify({ agent: "alice" }) })).json();
  check("token issued", t.token?.startsWith("hm_"));

  // Connect with alice's token but claim to be "mallory" in the URL: identity must come from the token.
  const client = new Client({ name: "auth-test", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp?agent=mallory`), { requestInit: { headers: { authorization: `Bearer ${t.token}` } } }));
  const r = await client.callTool({ name: "hub_overview", arguments: {} });
  check("MCP works with token", !r.isError);
  check("agent identity comes from token, not URL", /You are \*\*alice\*\*/.test(r.content[0].text));
  await client.close();

  await fetch(`${BASE}/api/tokens/${t.id}`, { method: "DELETE", headers: { cookie } });
  const after = await fetch(`${BASE}/mcp`, { method: "POST", headers: { authorization: `Bearer ${t.token}`, "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
  check("revoked token rejected", after.status === 401);
} catch (e) { fail++; console.error("ERROR", e); }
finally {
  srv.kill();
  console.log(`\n${ok} passed, ${fail} failed`);
  setTimeout(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} process.exit(fail ? 1 : 0); }, 500);
}
