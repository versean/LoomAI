// Retrieval with sources: ranking, stable refs, originals, version pinning, access, fallback.
// No model calls: uses "sources" mode, and an invalid key to prove the answer mode falls back.
//   node test/retrieval.test.mjs
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const PORT = 4293, BASE = `http://localhost:${PORT}`, PW = "retrieval-test-pass";
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hivemind-ret-"));
const srv = spawn(process.execPath, ["src/server.js"], { env: { ...process.env, PORT: String(PORT), HIVEMIND_DATA_DIR: dir, HIVEMIND_PASSWORD: PW, HIVEMIND_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "sk-ant-invalid-for-tests", HIVEMIND_BATCH_QUIET_MS: "600000", HIVEMIND_BATCH_MAX_MS: "600000" }, stdio: "pipe" });
let ok = 0, fail = 0;
const check = (name, cond, extra = "") => { cond ? ok++ : fail++; console.log(`${cond ? "PASS" : "FAIL"}  ${name}${!cond && extra ? "  → " + String(extra).slice(0, 400) : ""}`); };

try {
  for (let i = 0; i < 50; i++) { try { if ((await fetch(`${BASE}/health`)).ok) break; } catch {} await new Promise(r => setTimeout(r, 200)); }
  const cookie = ((await fetch(`${BASE}/api/login`, { method: "POST", body: JSON.stringify({ password: PW }) })).headers.get("set-cookie") || "").split(";")[0];
  const H = { cookie, "content-type": "application/json" };
  const api = async (p, o = {}) => { const r = await fetch(BASE + p, { headers: H, ...o }); return { status: r.status, json: await r.json().catch(() => null) }; };

  // --- Build some knowledge
  await api("/api/projects", { method: "POST", body: JSON.stringify({ name: "Payments", description: "Checkout and billing" }) });
  await api("/api/projects", { method: "POST", body: JSON.stringify({ name: "Secret Lab" }) });
  await api("/api/projects/secret-lab/docs", { method: "PUT", body: JSON.stringify({ kind: "brief", content: "# Secret Lab\n\n## Current state\n\nThe payment provider for the lab is QUOKKA-PAY.\n" }) });
  await api("/api/projects/payments/docs", { method: "PUT", body: JSON.stringify({ kind: "brief", content: "# Payments\n\n## Current state\n\nCheckout uses Stripe Elements. Refunds are manual for now.\n\n## Architecture\n\nWebhooks land on /api/stripe/webhook.\n" }) });
  const d1 = (await api("/api/projects/payments/decisions", { method: "POST", body: JSON.stringify({ title: "Use PayPal for payments", body: "We picked PayPal because of marketplace payouts." }) })).json;
  const d2 = (await api("/api/projects/payments/decisions", { method: "POST", body: JSON.stringify({ title: "Switch payments to Stripe", body: "Stripe replaces PayPal: better subscriptions API and lower fees.", supersedes: d1.id }) })).json;
  await fetch(`${BASE}/api/projects/payments/files?name=refund-policy.md`, { method: "POST", headers: { cookie }, body: "# Refund policy\n\nCustomers can request a refund within 30 days. Refunds over $500 need finance approval.\n" });

  const tok = (await api("/api/tokens", { method: "POST", body: JSON.stringify({ agent: "backend", project: "payments", access: "read" }) })).json.token;
  const c = new Client({ name: "claude-code", version: "2" });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), { requestInit: { headers: { authorization: `Bearer ${tok}` } } }));
  const call = async (name, args) => { const r = await c.callTool({ name, arguments: args }); return { err: !!r.isError, text: r.content.map(x => x.text).join("\n") }; };
  const w = (await api("/api/tokens", { method: "POST", body: JSON.stringify({ agent: "writer", project: "payments", access: "write" }) })).json.token;
  const wc = new Client({ name: "w", version: "1" });
  await wc.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), { requestInit: { headers: { authorization: `Bearer ${w}` } } }));
  await wc.callTool({ name: "push", arguments: { project: "payments", summary: "Added Stripe webhook signature verification", changes: ["Verify Stripe-Signature header on /api/stripe/webhook"], breaking_changes: ["Webhook now rejects unsigned requests with 400"] } });
  await wc.callTool({ name: "handoff", arguments: { project: "payments", title: "Refunds spike", recap: "We explored automating refunds via the Stripe Refunds API. Blocked on finance approval rules for refunds over $500." } });
  await wc.callTool({ name: "send_message", arguments: { to: "backend", project: "payments", text: "Heads up: the webhook now needs the signing secret STRIPE_WEBHOOK_SECRET." } });
  await wc.callTool({ name: "send_message", arguments: { to: "someone-else", project: "payments", text: "private note about the walrus migration" } });

  // --- Ranking + refs (sources mode, deterministic)
  let r = await api("/api/ask", { method: "POST", body: JSON.stringify({ question: "Which payment provider did we decide on?", project: "payments", mode: "sources" }) });
  const refs = r.json.sources.map(s => s.ref);
  check("decisions rank first for a 'what did we decide' question", refs[0] === `decision:payments/${d2.id}`, refs.join(" | "));
  check("superseded decision is still found but marked", r.json.sources.some(s => s.ref === `decision:payments/${d1.id}` && s.status === "superseded"));
  r = await api("/api/ask", { method: "POST", body: JSON.stringify({ question: "marketplace payouts", project: "payments", mode: "sources" }) });
  const ix = (ref) => r.json.sources.findIndex(s => s.ref === ref);
  check("a superseded decision always brings its replacement, placed before it", ix(`decision:payments/${d1.id}`) >= 0 && ix(`decision:payments/${d2.id}`) >= 0 && ix(`decision:payments/${d2.id}`) < ix(`decision:payments/${d1.id}`), r.json.sources.map(s => s.ref).join(" | "));
  check("doc sources are pinned to a git version (ref has @sha)", r.json.sources.filter(s => s.kind === "brief").every(s => /@[0-9a-f]{7}$/.test(s.ref)), refs.join(" | "));
  check("never returns other projects' content", !JSON.stringify(r.json).includes("QUOKKA"));

  r = await api("/api/ask", { method: "POST", body: JSON.stringify({ question: "refunds over 500 dollars approval", mode: "sources" }) });
  check("finds the original file and the recap", r.json.sources.some(s => s.ref === "file:payments/refund-policy.md") && r.json.sources.some(s => s.kind === "conversation"), r.json.sources.map(s => s.ref).join(" | "));
  r = await api("/api/ask", { method: "POST", body: JSON.stringify({ question: "webhook signature breaking change", mode: "sources" }) });
  check("finds the agent's push", r.json.sources.some(s => s.kind === "push" && /Push by writer/.test(s.title)));

  // --- Agent tool: ask (answer mode -> falls back to sources without a working model)
  let t = await call("ask", { question: "What payment provider do we use?" });
  check("agent ask works and returns refs", !t.err && t.text.includes(`decision:payments/${d2.id}`) && /get_source/.test(t.text), t.text);
  check("model unavailable -> graceful fallback to ranked sources", /Overseer is unavailable/.test(t.text), t.text.slice(0, 200));
  t = await call("ask", { question: "walrus migration", mode: "sources" });
  check("agents can't retrieve other agents' private messages", !/walrus/.test(t.text), t.text);
  t = await call("ask", { question: "webhook signing secret", mode: "sources" });
  check("...but do get messages addressed to them", /STRIPE_WEBHOOK_SECRET|Message writer → backend/.test(t.text), t.text);
  t = await call("ask", { question: "QUOKKA payment provider", project: "secret-lab" });
  check("asking about a project without access -> denied by gateway", t.err && /no access to project secret-lab/.test(t.text), t.text);

  // --- get_source: complete originals
  t = await call("get_source", { ref: "file:payments/refund-policy.md" });
  check("get_source returns the complete original file", !t.err && /within 30 days/.test(t.text) && /finance approval/.test(t.text));
  t = await call("get_source", { ref: `decision:payments/${d1.id}` });
  check("get_source on a superseded decision says so", /status: superseded/.test(t.text) && new RegExp(`supersededBy: ${d2.id}`).test(t.text), t.text);
  const briefRef = (await api("/api/ask", { method: "POST", body: JSON.stringify({ question: "stripe elements checkout", mode: "sources", project: "payments" }) })).json.sources.find(s => s.kind === "brief").ref;
  await api("/api/projects/payments/docs", { method: "PUT", body: JSON.stringify({ kind: "brief", content: "# Payments\n\n## Current state\n\nCheckout moved to Stripe Checkout (hosted).\n" }) });
  t = await call("get_source", { ref: briefRef });
  check("a cited doc version stays exactly as cited after the doc changes (+ stale note)", /Stripe Elements/.test(t.text) && !/hosted/.test(t.text) && /changed since/.test(t.text), t.text);
  r = await api("/api/ask", { method: "POST", body: JSON.stringify({ question: "stripe checkout hosted", mode: "sources", project: "payments" }) });
  check("index refreshes after changes (new version is searchable)", r.json.sources.some(s => s.kind === "brief" && /hosted/.test(s.excerpt)));
  t = await call("get_source", { ref: "brief:secret-lab@HEAD" });
  check("get_source on another project -> denied", t.err && /no access/.test(t.text), t.text);
  t = await call("get_source", { ref: "not-a-ref" });
  check("invalid ref -> helpful error", t.err && /valid ref/.test(t.text));
  const priv = (await api("/api/ask", { method: "POST", body: JSON.stringify({ question: "walrus migration", mode: "sources" }) })).json.sources.find(s => s.kind === "message");
  t = await call("get_source", { ref: priv.ref });
  check("get_source on someone else's message -> not found", t.err, t.text);

  // --- Gateway records
  const q = (await api("/api/requests?action=context.query")).json;
  check("asks are recorded (metadata only, never the question)", q.length >= 3 && !JSON.stringify(q).includes("payment provider"), JSON.stringify(q[0]));
  const s = (await api("/api/requests?action=source.fetch")).json;
  check("source fetches are recorded with their ref", s.some(x => x.resource === "file:payments/refund-policy.md" && x.outcome === "allowed") && s.some(x => x.outcome === "denied"));

  // --- Dashboard source endpoint
  r = await api(`/api/source?ref=${encodeURIComponent("file:payments/refund-policy.md")}`);
  check("dashboard /api/source returns originals", r.status === 200 && /30 days/.test(r.json.content));
  await c.close(); await wc.close();
} catch (e) { fail++; console.error("ERROR", e); }
finally {
  srv.kill();
  console.log(`\n${ok} passed, ${fail} failed`);
  setTimeout(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} process.exit(fail ? 1 : 0); }, 500);
}
