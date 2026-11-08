// Per-agent project access, end to end through the gateway with real MCP clients.
//   node test/access.test.mjs
// Agents: writer (write on transit-app), reader (read on transit-app), outsider (no grants).
// Projects: transit-app, secret-ops (nobody but humans).
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const PORT = 4296, BASE = `http://localhost:${PORT}`, PW = "access-test-pass";
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hivemind-acc-"));
const srv = spawn(process.execPath, ["src/server.js"], { env: { ...process.env, PORT: String(PORT), HIVEMIND_DATA_DIR: dir, HIVEMIND_PASSWORD: PW, HIVEMIND_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "sk-ant-invalid-for-tests", HIVEMIND_BATCH_QUIET_MS: "300", HIVEMIND_BATCH_MAX_MS: "800" }, stdio: "pipe" });
let ok = 0, fail = 0;
const check = (name, cond, extra = "") => { cond ? ok++ : fail++; console.log(`${cond ? "PASS" : "FAIL"}  ${name}${!cond && extra ? "  → " + String(extra).slice(0, 300) : ""}`); };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

try {
  for (let i = 0; i < 50; i++) { try { if ((await fetch(`${BASE}/health`)).ok) break; } catch {} await sleep(200); }
  const cookie = ((await fetch(`${BASE}/api/login`, { method: "POST", body: JSON.stringify({ password: PW }) })).headers.get("set-cookie") || "").split(";")[0];
  const H = { cookie, "content-type": "application/json" };
  const api = async (p, opts = {}) => (await fetch(BASE + p, { headers: H, ...opts })).json();
  const lastReq = async (q) => (await api(`/api/requests${q}`))[0];

  await api("/api/projects", { method: "POST", body: JSON.stringify({ name: "Transit App", description: "Bus routing" }) });
  await api("/api/projects", { method: "POST", body: JSON.stringify({ name: "Secret Ops", description: "Classified" }) });
  await api("/api/projects/secret-ops/docs", { method: "PUT", body: JSON.stringify({ kind: "brief", content: "# Secret Ops\n\nThe launch codename is PLATYPUS.\n" }) });

  const tok = async (agent, project, access) => (await api("/api/tokens", { method: "POST", body: JSON.stringify({ agent, project, access }) })).token;
  const tokens = { writer: await tok("writer", "transit-app", "write"), reader: await tok("reader", "transit-app", "read"), outsider: await tok("outsider") };
  const connect = async (name) => { const c = new Client({ name, version: "1" }); await c.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), { requestInit: { headers: { authorization: `Bearer ${tokens[name]}` } } })); return c; };
  const call = async (c, name, args = {}) => { const r = await c.callTool({ name, arguments: args }); return { err: !!r.isError, text: r.content.map(x => x.text).join("\n") }; };
  const writer = await connect("writer"), reader = await connect("reader"), outsider = await connect("outsider");

  // --- Defaults: secure mode starts agents with no access
  let r = await call(outsider, "pull", { project: "transit-app", task: "api" });
  check("outsider (no grant) pull -> denied", r.err && /Denied by the Loom gateway: outsider has no access to project transit-app/.test(r.text), r.text);
  let q = await lastReq("?actor=outsider&action=context.pull");
  check("...and the denial is recorded", q?.outcome === "denied" && q.status === 403 && q.project === "transit-app");
  r = await call(outsider, "hub_overview");
  check("outsider's overview shows no projects", !/Transit App|Secret Ops/.test(r.text) && /No projects you can access/.test(r.text), r.text);

  // --- Read-only
  r = await call(reader, "pull", { project: "transit-app", task: "website" });
  check("reader pull -> allowed", !r.err && /Briefing: website/.test(r.text), r.text);
  r = await call(reader, "push", { summary: "try to write" });
  check("reader push -> denied (read-only)", r.err && /read-only access to project transit-app/.test(r.text), r.text);
  r = await call(reader, "add_file", { name: "x.md", content: "x" });
  check("reader add_file -> denied", r.err && /read-only/.test(r.text), r.text);

  // --- Write, but only on its own project
  r = await call(writer, "pull", { project: "transit-app", task: "api" });
  r = await call(writer, "push", { summary: "Added /routes endpoint", changes: ["GET /routes"] });
  check("writer push on its project -> allowed", !r.err, r.text);
  r = await call(writer, "pull", { project: "secret-ops", task: "x" });
  check("writer pull on another project -> denied", r.err && /no access to project secret-ops/.test(r.text), r.text);
  r = await call(writer, "read_file", { project: "secret-ops", name: "anything.md" });
  check("writer read_file on another project -> denied", r.err && /no access/.test(r.text));

  // --- Cross-project leaks
  r = await call(writer, "search", { query: "PLATYPUS" });
  check("search never returns other projects' content", /^Nothing for/.test(r.text) && !/secret-ops/i.test(r.text), r.text);
  r = await call(writer, "search", { query: "PLATYPUS", project: "secret-ops" });
  check("search scoped to a forbidden project -> denied", r.err && /no access/.test(r.text), r.text);
  await call(writer, "send_message", { to: "outsider", text: "the zebra password is here" });
  r = await call(reader, "search", { query: "zebra" });
  check("agents can't search other agents' direct messages", /^Nothing for/.test(r.text), r.text);
  r = await call(writer, "send_message", { to: "*", text: "hello", project: "secret-ops" });
  check("broadcasting into a forbidden project -> denied", r.err && /no access/.test(r.text), r.text);
  await api("/api/messages", { method: "POST", body: JSON.stringify({ to: "*", text: "PLATYPUS launch moved", project: "secret-ops" }) });
  await api("/api/messages", { method: "POST", body: JSON.stringify({ to: "*", text: "Transit standup at 3", project: "transit-app" }) });
  r = await call(reader, "read_messages");
  check("project broadcasts only reach agents with access", /Transit standup/.test(r.text) && !/PLATYPUS/.test(r.text), r.text);
  r = await call(outsider, "read_messages");
  check("direct messages always reach the recipient", /zebra/.test(r.text) && !/Transit standup/.test(r.text), r.text);

  // --- Live changes from the dashboard
  let a = await api("/api/projects/transit-app/access", { method: "PUT", body: JSON.stringify({ agent: "reader", access: "write" }) });
  r = await call(reader, "push", { summary: "now I can write" });
  check("dashboard upgrades reader to write -> push allowed immediately", a.access === "write" && !r.err, r.text);
  q = await lastReq("?action=access.set");
  check("access change is recorded as a human admin action", q?.actor === "human" && q.outcome === "allowed" && q.project === "transit-app");
  a = await api("/api/projects/transit-app/access", { method: "PUT", body: JSON.stringify({ agent: "reader", access: null }) });
  r = await call(reader, "pull", { project: "transit-app", task: "website" });
  check("reset to default (none in secure mode) -> denied", a.access === "none" && r.err, r.text);
  const list = await api("/api/projects/transit-app/access");
  const w = list.agents.find(x => x.agent === "writer"), o = list.agents.find(x => x.agent === "outsider");
  check("access page lists agents with effective + explicit levels", list.default === "none" && w?.access === "write" && w.explicit === "write" && o?.access === "none" && o.explicit === null, JSON.stringify(list));

  // --- Agents can create their own projects (and only get access to those)
  r = await call(outsider, "create_project", { name: "Outsider Sandbox" });
  const r2 = await call(outsider, "pull", { project: "outsider-sandbox", task: "x" });
  check("agent-created project grants the creator write", !r.err && !r2.err, r.text + r2.text);
  r = await call(outsider, "create_project", { name: "Transit App" });
  check("can't take over an existing project by 'creating' it", r.err && /already exists|no access/.test(r.text), r.text);

  // --- Overseer won't fold a read-only agent's message into project knowledge
  await api("/api/projects/transit-app/access", { method: "PUT", body: JSON.stringify({ agent: "reader", access: "read" }) });
  await call(reader, "send_message", { to: "writer", text: "Decision: we switch to Postgres", project: "transit-app" });
  let skip;
  for (let i = 0; i < 20 && !skip; i++) { await sleep(500); skip = (await api("/api/requests?actor=conductor&outcome=denied"))[0]; }
  // Access is checked when the Overseer processes an item, so reader's earlier push (made while it
  // briefly had write) is skipped too, since that access was revoked before processing.
  check("Overseer skips items from agents without write access (recorded)", /Skipped \d+ item/.test(skip?.reason || "") && skip.detail?.from?.includes("reader"), JSON.stringify(skip));

  // --- Human-only actions stay human-only
  const st = await api("/api/requests/stats");
  check("stats show denials", st.denied >= 8, JSON.stringify(st));
  for (const c of [writer, reader, outsider]) await c.close();
} catch (e) { fail++; console.error("ERROR", e); }
finally {
  srv.kill();
  console.log(`\n${ok} passed, ${fail} failed`);
  setTimeout(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} process.exit(fail ? 1 : 0); }, 500);
}
