// Simulates two agents working through the hub over real MCP. Hub must be running.
//   npm run demo        (watch the dashboard while it runs)
// alice owns the API, bob owns the website.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const HUB = process.env.HUB_URL || "http://localhost:4100";
const PAUSE = Number(process.env.DEMO_PAUSE_MS || 2500);
const TOKEN = process.env.HIVEMIND_TOKEN ? `&token=${process.env.HIVEMIND_TOKEN}` : "";
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function connect(name) {
  const client = new Client({ name: `demo-${name}`, version: "1.0.0" });
  // Secure hubs: pass per-agent tokens as ALICE_TOKEN / BOB_TOKEN.
  const tok = process.env[`${name.toUpperCase()}_TOKEN`];
  const opts = tok ? { requestInit: { headers: { authorization: `Bearer ${tok}` } } } : {};
  await client.connect(new StreamableHTTPClientTransport(new URL(`${HUB}/mcp?agent=${name}${TOKEN}`), opts));
  return {
    client,
    async call(tool, args = {}) {
      const res = await client.callTool({ name: tool, arguments: args });
      const out = res.content.map(c => c.text).join("\n");
      console.log(`\n\x1b[36m[${name}] ${tool}\x1b[0m${res.isError ? " \x1b[31m(error)\x1b[0m" : ""}\n${out.split("\n").slice(0, 6).join("\n")}${out.split("\n").length > 6 ? "\n…" : ""}`);
      return out;
    },
  };
}

const alice = await connect("alice");
const bob = await connect("bob");
const prompts = await alice.client.listPrompts();
console.log(`Connected. Slash-command prompts available: ${prompts.prompts.map(p => "/" + p.name).join(", ")}`);

await alice.call("pull", { project: "hackathon-site", task: "api" });
await sleep(PAUSE);
await alice.call("push", {
  summary: "Signup now collects a name and returns the person's waitlist position. Added a waitlist count endpoint and rate limiting.",
  changes: ["POST /api/signup takes { email, name } and returns { id, email, name, position }", "New GET /api/waitlist/count returns { count }", "Rate limit: 5 signups/min per IP; 429 when exceeded"],
  decisions: ["Name is required at signup, because we want to personalize the waitlist confirmation email"],
  breaking_changes: ["POST /api/signup now REQUIRES `name`; requests without it get 400", "Signup response adds `name` and `position`"],
  files_touched: ["api/src/routes/signup.ts", "api/src/routes/waitlist.ts", "api/prisma/schema.prisma"],
  next_steps: ["Document the 429 response body"],
  links: ["https://github.com/example/hackathon-site/pull/12"],
  branch: "feat/signup-v2", commit: "a1b2c3d",
});
await sleep(PAUSE * 4);

await bob.call("pull", { project: "hackathon-site", task: "website" });
await bob.call("read_messages");
await sleep(PAUSE);
await bob.call("push", {
  summary: "Signup form wired to the new API shape with a success state and a live waitlist counter.",
  changes: ["Added a name field to the signup form", "Success state shows 'You're #<position> on the waitlist'", "Hero shows a live counter polling GET /api/waitlist/count every 10s"],
  next_steps: ["Friendly error state for 429 rate limit"],
  files_touched: ["web/components/SignupForm.tsx", "web/components/WaitlistCounter.tsx"],
  branch: "feat/signup-form", commit: "e4f5a6b",
});
await bob.call("send_message", { to: "alice", text: "Form is on the new signup shape. What does the 429 body look like? Want to show a friendly retry message." });
await sleep(PAUSE);
await alice.call("read_messages");
await alice.call("send_message", { to: "bob", text: "429 returns { error: \"rate_limited\", retryAfter: <seconds> }." });
await alice.call("handoff", { title: "Signup API v2 done", recap: "Signup v2 is merged on feat/signup-v2: name required, position returned, waitlist count endpoint, 5/min/IP rate limit returning 429 { error: 'rate_limited', retryAfter }. Next: move rate-limit config to env (RATE_LIMIT_PER_MIN). Gotcha: Prisma migration 0003 must run before deploying." });

console.log("\nDemo done. The conductor batches pushes; watch the dashboard for its commits.");
process.exit(0);
