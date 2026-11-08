// Wipes data/ and seeds one realistic project. No model calls. Run with the hub STOPPED: `npm run seed`.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const DATA = process.env.HIVEMIND_DATA_DIR || path.join(here, "..", "data");
fs.rmSync(DATA, { recursive: true, force: true });

const brain = await import("./store/brain.js");
const db = await import("./store/db.js");
await brain.init();

const p = await brain.createProject({ name: "Hackathon Site", description: "Landing page + waitlist signup for our hackathon project. Next.js frontend, Express API, Postgres.", actor: "human" });
const s = p.slug;

await brain.writeDoc(s, "instructions", { actor: "human", message: "Set team rules", content: `# Instructions: Hackathon Site

Rules every agent must follow. **Only humans edit this file.**

## Rules

- Pull your briefing (\`/pull <task>\`) before starting work. Push (\`/push\`) after every meaningful change.
- Message the affected teammate **before** making a breaking change to an API, env var, or schema.
- TypeScript everywhere. No \`any\` in exported types.
- Never commit secrets. Env vars go in \`.env.example\` with dummy values.

## Stack

- Frontend: Next.js 15 (app router) + Tailwind. API: Express on port 4000. DB: Postgres via Prisma.
- Deploy: frontend on Amplify, API on App Runner.

## Definition of done

- Works locally, typed, and pushed to Loom with any breaking changes called out.
` });

await brain.writeDoc(s, "brief", { actor: "human", message: "Initial brief", content: `# Hackathon Site

Landing page + waitlist signup for our hackathon project.

<!-- pin -->
> **Demo is Sunday 2pm.** Feature freeze Saturday midnight. Anything not done by then gets cut.
<!-- /pin -->

## Current state

- Landing page hero + features section done.
- Signup form exists but isn't wired to the API yet.
- \`POST /api/signup\` exists; takes \`{ email }\`, returns \`{ id, email }\`.

## Architecture

- \`web/\`: Next.js app. \`api/\`: Express + Prisma. Shared types in \`packages/types\`.

## Who's on what

_Nobody connected yet._

## Open questions

- Do we want a live waitlist counter on the landing page?
` });

await brain.writeDoc(s, "playbook", { task: "website", actor: "human", message: "Website playbook", content: `# Playbook: website

You're working on the **Next.js frontend** in \`web/\`.

## Goals right now

1. Wire the signup form to \`POST /api/signup\`.
2. Show a success state after signup.

## Conventions

- Tailwind only. Brand violet \`#8b7cff\`. Components in \`web/components/\`, one per file.

## Watch out for

- API base URL comes from \`NEXT_PUBLIC_API_URL\` (port 4000 locally).
` });

await brain.addDecision(s, { actor: "human", title: "Email-only signup for the demo", body: "No passwords or OAuth for the hackathon. Collect email and send a magic link later if we continue the project.\n\n**Why:** fastest path to a working demo; auth isn't what we're judged on." });
await brain.addDecision(s, { actor: "human", title: "Postgres via Prisma", body: "Use Postgres with Prisma for the waitlist.\n\n**Why:** typed client, easy migrations, team already knows it." });

await brain.addLinks(s, [
  { label: "Repository (example)", url: "https://github.com/anthropics/anthropic-sdk-typescript", kind: "repo" },
  { label: "Figma: landing page", url: "https://www.figma.com/file/example/landing", kind: "design" },
  { label: "Staging", url: "https://staging.example.dev", kind: "deploy" },
], "human");

await brain.addFile(s, "signup-api-spec.md", Buffer.from(`# Signup API spec (v1)

## POST /api/signup
Request: \`{ "email": string }\`
Response 201: \`{ "id": string, "email": string }\`
Errors: 400 invalid email, 409 already signed up.
`), "human");

await brain.snapshot(s, "seed", "human");
db.activity("human", "project", `Seeded **${p.name}**: instructions, brief, website playbook, 2 decisions, 3 links, 1 file`, { project: s });
console.log(`Seeded "${p.name}". Start the hub with: npm start`);
