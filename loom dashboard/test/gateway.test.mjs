// Gateway checks against a throwaway secure-mode hub: every request path produces the right
// request record (allowed / denied / unauthenticated / error) with no content leaked.
//   node test/gateway.test.mjs
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const PORT = 4297, BASE = `http://localhost:${PORT}`, PW = "gw-test-pass";
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hivemind-gw-"));
const srv = spawn(process.execPath, ["src/server.js"], { env: { ...process.env, PORT: String(PORT), HIVEMIND_DATA_DIR: dir, HIVEMIND_PASSWORD: PW, HIVEMIND_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "unused", HIVEMIND_BATCH_QUIET_MS: "600000", HIVEMIND_BATCH_MAX_MS: "600000" }, stdio: "pipe" });
let ok = 0, fail = 0;
const check = (name, cond, extra = "") => { cond ? ok++ : fail++; console.log(`${cond ? "PASS" : "FAIL"}  ${name}${!cond && extra ? "  → " + extra : ""}`); };
const SECRET = "TOP-SECRET-CONTENT-123";

try {
  for (let i = 0; i < 50; i++) { try { if ((await fetch(`${BASE}/health`)).ok) break; } catch {} await new Promise(r => setTimeout(r, 200)); }
  const login = await fetch(`${BASE}/api/login`, { method: "POST", body: JSON.stringify({ password: PW }) });
  const cookie = (login.headers.get("set-cookie") || "").split(";")[0];
  const H = { cookie, "content-type": "application/json" };
  const reqs = async (q = "") => (await fetch(`${BASE}/api/requests${q}`, { headers: H })).json();

  await fetch(`${BASE}/api/projects`, { method: "POST", headers: H, body: JSON.stringify({ name: "Transit App", description: "test" }) });
  const t = await (await fetch(`${BASE}/api/tokens`, { method: "POST", headers: H, body: JSON.stringify({ agent: "claude-code", project: "transit-app", access: "write" }) })).json();

  // 1. Unauthenticated agent
  await fetch(`${BASE}/mcp`, { method: "POST", headers: { authorization: "Bearer hm_forged", "content-type": "application/json", accept: "application/json, text/event-stream" }, body: "{}" });
  let r = (await reqs("?outcome=unauthenticated"))[0];
  check("forged token -> unauthenticated record", r?.action === "session.connect" && r.reason === "Invalid or revoked agent token");

  // 2. Wrong dashboard password
  await fetch(`${BASE}/api/login`, { method: "POST", body: JSON.stringify({ password: "nope" }) });
  r = (await reqs("?action=auth.login&outcome=denied"))[0];
  check("wrong password -> denied auth.login record", !!r);

  // 3. Real MCP client through the gateway
  const client = new Client({ name: "claude-code", version: "2.1.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), { requestInit: { headers: { authorization: `Bearer ${t.token}` } } }));
  r = (await reqs("?action=session.connect&outcome=allowed"))[0];
  check("initialize -> session.connect with client name", r?.actor === "claude-code" && r.client === "claude-code 2.1.0", JSON.stringify(r));

  await client.callTool({ name: "pull", arguments: { project: "transit-app", task: "website" } });
  r = (await reqs("?action=context.pull"))[0];
  check("pull -> allowed context.pull on project", r?.outcome === "allowed" && r.project === "transit-app" && r.resource === "briefing:website" && r.ms !== null, JSON.stringify(r));

  await client.callTool({ name: "push", arguments: { summary: SECRET, breaking_changes: ["api change"] } });
  r = (await reqs("?action=knowledge.push"))[0];
  check("push -> allowed, project inferred from pulled context", r?.outcome === "allowed" && r.project === "transit-app", JSON.stringify(r));
  check("push record has metadata (breaking count) but no content", r?.detail?.breaking === 1 && !JSON.stringify(r).includes(SECRET));

  await client.callTool({ name: "send_message", arguments: { to: "codex", text: SECRET } });
  r = (await reqs("?action=message.send"))[0];
  check("message -> allowed, recipient recorded, text not recorded", r?.outcome === "allowed" && r.resource === "to:codex" && !JSON.stringify(r).includes(SECRET));

  const res = await client.callTool({ name: "read_file", arguments: { name: "does-not-exist.md" } });
  r = (await reqs("?action=file.read"))[0];
  check("missing file -> error outcome returned to agent and recorded", res.isError && r?.outcome === "error" && /No file/.test(r.reason || ""), JSON.stringify(r));

  await client.getPrompt({ name: "push", arguments: {} });
  r = (await reqs("?action=prompt.get"))[0];
  check("slash command -> prompt.get record", r?.outcome === "allowed" && r.resource === "prompt:push");
  await client.close();

  // 4. Dashboard mutations
  await fetch(`${BASE}/api/projects/transit-app/snapshots`, { method: "POST", headers: H, body: JSON.stringify({ label: "gw test" }) });
  r = (await reqs("?action=snapshot.create"))[0];
  check("dashboard snapshot -> human allowed record", r?.actor === "human" && r.outcome === "allowed" && r.project === "transit-app");
  await fetch(`${BASE}/api/projects/transit-app/docs`, { method: "PUT", headers: H, body: JSON.stringify({ kind: "nonsense", content: "x" }) });
  r = (await reqs("?action=doc.edit"))[0];
  check("bad dashboard edit -> error record", r?.outcome === "error");

  // 5. No session
  await fetch(`${BASE}/api/state`);
  r = (await reqs("?outcome=unauthenticated"))[0];
  check("API without session -> unauthenticated record", r?.action === "api.read");

  // 6. Stats + activity feed visibility
  const st = await (await fetch(`${BASE}/api/requests/stats`, { headers: H })).json();
  check("stats count allowed/denied/unauthenticated/error", st.allowed >= 6 && st.denied >= 1 && st.unauthenticated >= 2 && st.error >= 2, JSON.stringify(st));
  check("stats per agent", st.agents.some(a => a.actor === "claude-code"));
  const state = await (await fetch(`${BASE}/api/state`, { headers: H })).json();
  check("blocked requests appear in the live activity feed", state.activity.some(a => a.actor === "gateway" && a.type === "denied"));
  check("state exposes gateway stats", state.gateway?.total > 0);
} catch (e) { fail++; console.error("ERROR", e); }
finally {
  srv.kill();
  console.log(`\n${ok} passed, ${fail} failed`);
  setTimeout(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} process.exit(fail ? 1 : 0); }, 500);
}
