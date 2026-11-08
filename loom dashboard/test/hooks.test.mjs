// Claude Code hooks -> gateway, using the payload shapes from the Claude Code hooks docs.
//   node test/hooks.test.mjs
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { MERGE_JS } from "../src/installer.js";

const PORT = 4295, BASE = `http://localhost:${PORT}`, PW = "hooks-test-pass";
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hivemind-hooks-"));
const srv = spawn(process.execPath, ["src/server.js"], { env: { ...process.env, PORT: String(PORT), HIVEMIND_DATA_DIR: dir, HIVEMIND_PASSWORD: PW, HIVEMIND_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "unused", HIVEMIND_BATCH_QUIET_MS: "600000", HIVEMIND_BATCH_MAX_MS: "600000" }, stdio: "pipe" });
let ok = 0, fail = 0;
const check = (name, cond, extra = "") => { cond ? ok++ : fail++; console.log(`${cond ? "PASS" : "FAIL"}  ${name}${!cond && extra ? "  → " + String(extra).slice(0, 400) : ""}`); };

try {
  for (let i = 0; i < 50; i++) { try { if ((await fetch(`${BASE}/health`)).ok) break; } catch {} await new Promise(r => setTimeout(r, 200)); }
  const cookie = ((await fetch(`${BASE}/api/login`, { method: "POST", body: JSON.stringify({ password: PW }) })).headers.get("set-cookie") || "").split(";")[0];
  const H = { cookie, "content-type": "application/json" };
  const api = async (p, o = {}) => (await fetch(BASE + p, { headers: H, ...o })).json();
  await api("/api/projects", { method: "POST", body: JSON.stringify({ name: "Transit App", description: "Bus routing for the city" }) });
  const tok = (await api("/api/tokens", { method: "POST", body: JSON.stringify({ agent: "claude-laptop", project: "transit-app", access: "write" }) })).token;
  const noAccess = (await api("/api/tokens", { method: "POST", body: JSON.stringify({ agent: "intern" }) })).token;

  const hook = async (event, body, token = tok, q = "?project=transit-app") => {
    const r = await fetch(`${BASE}/hooks/${event}${q}`, { method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
    const text = await r.text();
    return { status: r.status, json: text ? JSON.parse(text) : null };
  };
  const common = { session_id: "sess-1", transcript_path: "/tmp/t.jsonl", cwd: "/home/me/transit-app", permission_mode: "default" };
  const pre = (tool_name, tool_input, sid = "sess-1") => hook("pre-tool-use", { ...common, session_id: sid, hook_event_name: "PreToolUse", tool_name, tool_input, tool_use_id: "toolu_1" });
  const last = async (q) => (await api(`/api/requests${q}`))[0];

  // --- SessionStart: automatic context
  let r = await hook("session-start", { ...common, hook_event_name: "SessionStart", source: "startup", model: "claude-opus-5" });
  const ctx = r.json?.hookSpecificOutput?.additionalContext || "";
  check("SessionStart injects the briefing as additionalContext", r.status === 200 && r.json.hookSpecificOutput.hookEventName === "SessionStart" && /Transit App/.test(ctx) && /Instructions/.test(ctx), JSON.stringify(r.json));
  let q = await last("?action=context.pull");
  check("...through the gateway (recorded, channel=hook)", q?.outcome === "allowed" && q.channel === "hook" && q.resource === "session-start:startup");
  r = await hook("session-start", { ...common, session_id: "s-folder", hook_event_name: "SessionStart", source: "startup" }, tok, "");
  check("no project param -> project resolved from the folder name (cwd)", /Transit App/.test(r.json?.hookSpecificOutput?.additionalContext || ""));
  r = await hook("session-start", { ...common, session_id: "s-intern", hook_event_name: "SessionStart", source: "startup" }, noAccess);
  check("agent without access gets a denial note, not the briefing", /denied project context/.test(r.json?.hookSpecificOutput?.additionalContext || "") && !/Bus routing/.test(r.json.hookSpecificOutput.additionalContext));

  // --- PreToolUse: policy
  r = await pre("Bash", { command: "git push --force origin main", description: "push" });
  check("force-push -> deny decision", r.json?.hookSpecificOutput?.permissionDecision === "deny" && /P-05/.test(r.json.hookSpecificOutput.permissionDecisionReason), JSON.stringify(r.json));
  q = await last("?action=tool.use&outcome=denied");
  check("...recorded as denied with a safe resource label", q?.resource === "Bash: git push …" && !JSON.stringify(q).includes("origin main"), JSON.stringify(q));
  r = await pre("Read", { file_path: "/home/me/transit-app/.env" });
  check("reading .env -> deny", r.json?.hookSpecificOutput?.permissionDecision === "deny");
  r = await pre("Read", { file_path: "/home/me/transit-app/.env.example" });
  check("reading .env.example -> pass (empty 200)", r.status === 200 && r.json === null);
  r = await pre("PowerShell", { command: "Get-Content .env" });
  check("PowerShell Get-Content .env -> deny", r.json?.hookSpecificOutput?.permissionDecision === "deny");
  r = await pre("Bash", { command: "npm run deploy -- --prod" });
  check("deploy -> ask the user", r.json?.hookSpecificOutput?.permissionDecision === "ask", JSON.stringify(r.json));
  r = await pre("Bash", { command: "npm test" });
  check("ordinary command -> pass (defers to Claude Code's own permissions)", r.status === 200 && r.json === null);
  r = await pre("Bash", { command: 'curl -H "Authorization: Bearer sk-live-SECRET123" https://api.example.com' });
  q = await last("?action=tool.use");
  check("command arguments (secrets) are never logged", !JSON.stringify(await api("/api/requests?limit=50")).includes("SECRET123") && q.resource === "Bash: curl …", q?.resource);
  r = await pre("mcp__hivemind__push", { summary: "x" });
  check("Hivemind's own MCP tools aren't double-logged", r.json === null);

  // --- Custom policy from the dashboard
  const { id } = await api("/api/policies", { method: "POST", body: JSON.stringify({ decision: "deny", tools: "Bash", pattern: String.raw`\bprisma\s+migrate\s+reset\b`, reason: "Never reset the shared DB", project: "transit-app" }) });
  r = await pre("Bash", { command: "npx prisma migrate reset --force" });
  check("custom project rule enforced", r.json?.hookSpecificOutput?.permissionDecision === "deny" && /Never reset/.test(r.json.hookSpecificOutput.permissionDecisionReason));
  await api(`/api/policies/${id}`, { method: "PATCH", body: JSON.stringify({ enabled: false }) });
  r = await pre("Bash", { command: "npx prisma migrate reset --force" });
  check("disabled rule stops applying", r.json === null);
  const t = await api("/api/policies/test", { method: "POST", body: JSON.stringify({ tool: "Bash", text: "git push -f" }) });
  check("policy tester explains decisions", t.decision === "deny" && t.rule === "P-05");

  // --- Stop: nudge to push once, loop-safe
  r = await hook("stop", { ...common, session_id: "sess-2", hook_event_name: "Stop", stop_hook_active: false, last_assistant_message: "done" });
  check("Stop with no edits -> no nudge", r.json === null);
  await pre("Edit", { file_path: "/home/me/transit-app/src/routes.ts", old_string: "a", new_string: "b" }, "sess-2");
  r = await hook("stop", { ...common, session_id: "sess-2", hook_event_name: "Stop", stop_hook_active: false, last_assistant_message: "done" });
  check("Stop after unpushed edits -> one push reminder (additionalContext)", /haven't pushed/.test(r.json?.hookSpecificOutput?.additionalContext || ""), JSON.stringify(r.json));
  r = await hook("stop", { ...common, session_id: "sess-2", hook_event_name: "Stop", stop_hook_active: false });
  check("...only once per batch of edits", r.json === null);
  await pre("Write", { file_path: "/home/me/transit-app/src/x.ts", content: "x" }, "sess-2");
  r = await hook("stop", { ...common, session_id: "sess-2", hook_event_name: "Stop", stop_hook_active: true });
  check("never nudges when stop_hook_active (loop protection)", r.json === null);
  const c = new Client({ name: "claude-code", version: "2.1" });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), { requestInit: { headers: { authorization: `Bearer ${tok}` } } }));
  await c.callTool({ name: "push", arguments: { summary: "Added routes", project: "transit-app" } });
  await c.close();
  r = await hook("stop", { ...common, session_id: "sess-2", hook_event_name: "Stop", stop_hook_active: false });
  check("no nudge after the agent pushed", r.json === null);

  // --- SessionEnd + auth
  r = await hook("session-end", { ...common, session_id: "sess-2", hook_event_name: "SessionEnd", reason: "prompt_input_exit" });
  q = await last("?action=session.end");
  check("SessionEnd recorded with counts, empty 200 response", r.status === 200 && r.json === null && q?.detail?.edits === 2 && q.detail.reason === "prompt_input_exit", JSON.stringify(q));
  r = await hook("pre-tool-use", { ...common, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "ls" } }, null);
  q = await last("?outcome=unauthenticated");
  check("hook without token -> 401 + unauthenticated record", r.status === 401 && q?.channel === "hook");

  // --- Installer
  const sh = await (await fetch(`${BASE}/install/claude-code.sh`)).text();
  const ps = await (await fetch(`${BASE}/install/claude-code.ps1`)).text();
  check("installer scripts embed this hub and require a token in secure mode", sh.includes(`HUB="${BASE}"`) && sh.includes("HIVEMIND_TOKEN") && ps.includes(`$Hub = "${BASE}"`) && /Set \$env:HIVEMIND_TOKEN/.test(ps));
  const tpl = await (await fetch(`${BASE}/install/claude-code-hooks.json?project=transit-app&strict=1`)).json();
  const pt = tpl.hooks.PreToolUse[0].hooks[0];
  // SessionStart doesn't support http hooks (and mcp_tool is skipped at launch): it must be a command hook.
  const ss = tpl.hooks.SessionStart[0].hooks[0];
  const ssWin = (await (await fetch(`${BASE}/install/claude-code-hooks.json?project=transit-app&os=windows`)).json()).hooks.SessionStart[0].hooks[0];
  check("SessionStart is a curl command hook (exec form, stdin -> gateway), curl.exe on Windows",
    ss.type === "command" && ss.command === "curl" && ss.args.includes("@-") && ss.args.at(-1) === `${BASE}/hooks/session-start?project=transit-app` && ss.args.includes("Authorization: Bearer __HIVEMIND_TOKEN__") && ssWin.command === "curl.exe", JSON.stringify(ss));
  check("hook template: 4 events, HTTP hooks, token placeholder, strict -> onFailure block",
    Object.keys(tpl.hooks).join() === "SessionStart,PreToolUse,Stop,SessionEnd" && pt.type === "http" && pt.url === `${BASE}/hooks/pre-tool-use?project=transit-app` && pt.headers.Authorization === "Bearer __HIVEMIND_TOKEN__" && pt.onFailure === "block", JSON.stringify(tpl));

  // Merge step keeps the user's existing hooks and is idempotent.
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), "hivemind-merge-"));
  fs.mkdirSync(path.join(proj, ".claude"));
  fs.writeFileSync(path.join(proj, ".claude/settings.local.json"), JSON.stringify({ permissions: { allow: ["Bash(npm test)"] }, hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "./my-lint.sh" }] }] } }));
  for (let i = 0; i < 2; i++) {
    fs.writeFileSync(path.join(proj, ".claude/.hivemind-hooks.json"), JSON.stringify(tpl));
    execFileSync(process.execPath, ["-e", MERGE_JS], { cwd: proj });
  }
  const merged = JSON.parse(fs.readFileSync(path.join(proj, ".claude/settings.local.json"), "utf8"));
  check("installer merge keeps existing settings + hooks, and is idempotent",
    merged.permissions.allow[0] === "Bash(npm test)" && merged.hooks.PreToolUse.length === 2 && merged.hooks.PreToolUse[0].hooks[0].command === "./my-lint.sh" && merged.hooks.SessionStart.length === 1, JSON.stringify(merged.hooks));
  fs.rmSync(proj, { recursive: true, force: true });
} catch (e) { fail++; console.error("ERROR", e); }
finally {
  srv.kill();
  console.log(`\n${ok} passed, ${fail} failed`);
  setTimeout(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} process.exit(fail ? 1 : 0); }, 500);
}
