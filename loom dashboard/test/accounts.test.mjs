// Accounts end to end: open mode -> first account secures the hub -> people see only their projects.
//   node test/accounts.test.mjs
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const PORT = 4294, BASE = `http://localhost:${PORT}`;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hivemind-acct-"));
const env = { ...process.env, PORT: String(PORT), HIVEMIND_DATA_DIR: dir, HIVEMIND_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "unused", HIVEMIND_BATCH_QUIET_MS: "600000", HIVEMIND_BATCH_MAX_MS: "600000" };
delete env.HIVEMIND_PASSWORD;
const srv = spawn(process.execPath, ["src/server.js"], { env, stdio: "pipe" });
let ok = 0, fail = 0;
const check = (name, cond, extra = "") => { cond ? ok++ : fail++; console.log(`${cond ? "PASS" : "FAIL"}  ${name}${!cond && extra ? "  → " + String(extra).slice(0, 300) : ""}`); };

// A tiny cookie-jar client per person.
function person() {
  let cookie = "";
  const call = async (p, { method = "GET", body } = {}) => {
    const r = await fetch(BASE + p, { method, headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const sc = r.headers.get("set-cookie"); if (sc) cookie = sc.split(";")[0];
    const t = await r.text(); let json = null; try { json = t ? JSON.parse(t) : null; } catch {}
    return { status: r.status, json };
  };
  return { call, get cookie() { return cookie; } };
}
const mcpAs = async (url, headers = {}) => { const c = new Client({ name: "t", version: "1" }); await c.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } })); return c; };

try {
  for (let i = 0; i < 50; i++) { try { if ((await fetch(`${BASE}/health`)).ok) break; } catch {} await new Promise(r => setTimeout(r, 200)); }
  const anon = person(), alice = person(), bob = person(), carol = person();

  // --- Open mode
  let r = await anon.call("/api/session");
  check("fresh hub starts in open mode (no accounts)", r.json.secure === false && r.json.hasAccounts === false && r.json.loggedIn === true);
  const openAgent = await mcpAs(`${BASE}/mcp?agent=laptop`);
  r = await openAgent.callTool({ name: "hub_overview", arguments: {} });
  check("open mode: agent connects by name", !r.isError);
  await openAgent.close();

  // --- First account secures the hub
  r = await alice.call("/api/signup", { method: "POST", body: { name: "Alice Doe", email: "Alice@Team.dev", password: "short" } });
  check("weak password rejected", r.status === 400);
  r = await alice.call("/api/signup", { method: "POST", body: { name: "Alice Doe", email: "Alice@Team.dev", password: "correct-horse-1" } });
  check("first account created + signed in, workspace owner", r.status === 201 && r.json.first === true && r.json.user.owner === true && alice.cookie.startsWith("hm_session="));
  r = await anon.call("/api/session");
  check("hub is now secure", r.json.secure === true && r.json.loggedIn === false && r.json.hasAccounts === true);
  r = await anon.call("/api/state");
  check("API needs sign-in now", r.status === 401);
  const res = await fetch(`${BASE}/mcp?agent=laptop`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: "{}" });
  check("open-mode agents must now use tokens", res.status === 401);
  r = await anon.call("/api/signup", { method: "POST", body: { name: "Dup", email: "alice@team.dev", password: "another-pass-1" } });
  check("duplicate email rejected (case-insensitive)", r.status === 409);

  // --- Sign in
  const alice2 = person();
  r = await alice2.call("/api/login", { method: "POST", body: { email: "alice@team.dev", password: "wrong-password" } });
  check("wrong password rejected", r.status === 401);
  r = await alice2.call("/api/login", { method: "POST", body: { email: "alice@team.dev", password: "correct-horse-1" } });
  check("sign in works", r.status === 200 && r.json.user.name === "Alice Doe");

  // --- Projects are members-only
  await alice.call("/api/projects", { method: "POST", body: { name: "Alpha", description: "Alice's secret project" } });
  await alice.call("/api/projects/alpha/docs", { method: "PUT", body: { kind: "brief", content: "# Alpha\n\nCodename ZEPHYR.\n" } });
  r = await bob.call("/api/signup", { method: "POST", body: { name: "Bob Ray", email: "bob@team.dev", password: "bob-password-1" } });
  check("second account is a regular member", r.status === 201 && r.json.user.owner === false);
  r = await bob.call("/api/state");
  check("bob doesn't see alice's project", r.status === 200 && !r.json.projects.some(p => p.slug === "alpha"), JSON.stringify(r.json.projects.map(p => p.slug)));
  r = await bob.call("/api/projects/alpha");
  check("bob gets 404 for alice's project (not 403: it doesn't exist to him)", r.status === 404);
  r = await bob.call("/api/projects/alpha/docs", { method: "PUT", body: { kind: "brief", content: "pwned" } });
  check("bob can't write to it", r.status === 404);
  r = await bob.call("/api/search?q=ZEPHYR");
  check("search doesn't leak it", Array.isArray(r.json) && r.json.length === 0, JSON.stringify(r.json));
  r = await bob.call("/api/history?path=projects/alpha/brief.md");
  check("history/version of it are hidden", r.status === 404);
  r = await bob.call("/api/projects", { method: "POST", body: { name: "Alpha" } });
  check("can't take over by re-creating it", r.status === 409);

  await bob.call("/api/projects", { method: "POST", body: { name: "Beta", description: "Bob's project" } });
  r = await alice.call("/api/state");
  check("workspace owner sees every project", ["alpha", "beta"].every(s => r.json.projects.some(p => p.slug === s)));

  // --- Members
  await carol.call("/api/signup", { method: "POST", body: { name: "Carol", email: "carol@team.dev", password: "carol-password-1" } });
  r = await carol.call("/api/projects/beta/members", { method: "POST", body: { email: "carol@team.dev" } });
  check("non-members can't add themselves", r.status === 404);
  r = await bob.call("/api/projects/beta/members", { method: "POST", body: { email: "carol@team.dev" } });
  check("project owner adds a member by email", r.status === 201);
  r = await carol.call("/api/state");
  check("carol now sees beta, still not alpha", r.json.projects.some(p => p.slug === "beta") && !r.json.projects.some(p => p.slug === "alpha"));
  r = await carol.call("/api/projects/beta/members", { method: "POST", body: { email: "alice@team.dev" } });
  check("regular members can't manage members", r.status === 403);
  r = await bob.call("/api/projects/beta/members");
  check("member list shows roles", r.json.members.some(m => m.email === "bob@team.dev" && m.role === "owner") && r.json.members.some(m => m.email === "carol@team.dev" && m.role === "member"));

  // --- Agent tokens belong to people
  const bobTok = (await bob.call("/api/tokens", { method: "POST", body: { agent: "bob-claude", project: "beta", access: "write" } })).json;
  r = await bob.call("/api/tokens", { method: "POST", body: { agent: "sneaky", project: "alpha", access: "write" } });
  check("can't grant an agent access to a project you can't see", r.status === 404);
  r = await carol.call("/api/tokens");
  check("people only see their own agents' tokens", Array.isArray(r.json) && !r.json.some(t => t.agent === "bob-claude"));
  r = await alice.call("/api/tokens");
  check("owner sees all tokens", r.json.some(t => t.agent === "bob-claude"));
  r = await carol.call(`/api/tokens/${bobTok.id}`, { method: "DELETE" });
  check("can't revoke someone else's agent", r.status === 403);
  const agent = await mcpAs(`${BASE}/mcp`, { authorization: `Bearer ${bobTok.token}` });
  r = await agent.callTool({ name: "create_project", arguments: { name: "Gamma" } });
  await agent.close();
  r = await bob.call("/api/projects/gamma/members");
  check("a project created by bob's agent is owned by bob", r.status === 200 && r.json.members.some(m => m.email === "bob@team.dev" && m.role === "owner"), JSON.stringify(r.json));
  r = await carol.call("/api/projects/gamma");
  check("...and invisible to others", r.status === 404);

  // --- Attribution
  const hist = (await alice.call("/api/history?path=projects/alpha/brief.md")).json;
  check("git history credits the person who edited", hist[0]?.author === "Alice Doe", JSON.stringify(hist[0]));
  r = await alice.call("/api/requests?action=doc.edit");
  check("gateway records the person, not just 'human'", r.json[0]?.actor === "Alice Doe" && r.json[0].actorKind === "human");
  r = await bob.call("/api/requests?limit=500");
  check("bob's gateway view excludes alice's project", !r.json.some(x => x.project === "alpha"));
  r = await bob.call("/api/state");
  check("bob's activity feed excludes alice's project", !r.json.activity.some(a => a.refs?.project === "alpha"));

  // --- Policies
  r = await bob.call("/api/policies", { method: "POST", body: { decision: "deny", tools: "Bash", pattern: "rm", reason: "x" } });
  check("only the owner can add rules for all projects", r.status === 403);
  r = await bob.call("/api/policies", { method: "POST", body: { decision: "deny", tools: "Bash", pattern: "rm", reason: "x", project: "beta" } });
  check("members can add rules for their projects", r.status === 201);
  r = await carol.call("/api/policies");
  check("rules for projects you can't see are hidden", r.json.rules.every(x => !x.project || x.project === "beta"));
} catch (e) { fail++; console.error("ERROR", e); }
finally {
  srv.kill();
  console.log(`\n${ok} passed, ${fail} failed`);
  setTimeout(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} process.exit(fail ? 1 : 0); }, 500);
}
