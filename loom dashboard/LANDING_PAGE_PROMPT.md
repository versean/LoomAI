# Prompt: Build the landing page for Hivemind

You are building a **marketing landing page** for a product called **Hivemind**. Everything you need to know about the product, the audience, the message, and the look is below. Read it all before you start. Build a single polished, responsive page.

---

## 1. What Hivemind is (one paragraph)

Hivemind is **a shared brain and secure gateway for your AI coding agents.** Developers now work with several AI agents at once (multiple Claude Code sessions, Codex, Cursor) and every one of them starts each session knowing nothing, can't see what the others did, and runs commands nobody is watching. Hivemind connects all of them to one central hub. Every new session automatically starts with the project's context. Agents push what they did, an **Overseer AI** keeps the project's knowledge organized, agents can message each other, and a **gateway** checks and records every request, blocking things an agent shouldn't do (like reading secrets or force-pushing). You keep working in the AI tools you already use; Hivemind works behind them.

**Short taglines to choose from (or improve on):**
- "One brain for all your AI agents."
- "Your AI agents, finally on the same page."
- "Shared memory and a secure gateway for every AI agent you run."
- "Every session starts where the last one left off."

---

## 2. The problem (why it exists)

Write this section so a developer nods along. These are real pains:

1. **Every new session starts from zero.** You re-explain the project, the decisions, the conventions, every single time.
2. **Agents can't see each other.** Your frontend agent doesn't know your backend agent just changed the API. You become the copy-paste messenger between them.
3. **Knowledge is scattered.** Important decisions live in dozens of chat sessions you'll never find again.
4. **Nobody's watching what agents do.** AI agents run shell commands and edit files on your machine. There's no central place to see what they did, or to stop the dangerous stuff (reading `.env` files, force-pushing, deploying).

---

## 3. How it works (the core loop: show this visually)

1. **Connect once.** One command in your project folder connects Claude Code (or any MCP-compatible agent) to Hivemind.
2. **Start any session → it already knows the project.** The project briefing (rules, current state, decisions, who's working on what) is loaded automatically at session start.
3. **Agents push what they do.** `/push` sends a structured update: what changed, decisions, breaking changes.
4. **The Overseer organizes it.** An AI curator updates the project brief, writes per-task briefings, records decisions, and **automatically notifies teammates' agents about breaking changes**.
5. **Every request goes through the gateway.** It identifies which agent is asking, checks its permissions, routes the request, and records the outcome. Dangerous tool calls are blocked before they run.
6. **You watch it all on one dashboard.** Live activity, every request (allowed or denied), every change with a diff.

A good visual: several agent icons (Claude Code, Codex, Cursor) on the left → a central glowing "gateway / brain" node → project knowledge on the right, with a live activity log underneath.

---

## 4. Features (one card or block each; keep copy short)

**Automatic context**
Every new Claude Code session starts with the project briefing already loaded: goals, rules, decisions, current state, teammates. No more re-explaining.

**Shared project brain**
Each project has a living brief, team rules, per-task playbooks (e.g. "website", "api"), an append-only decision log, links, and files. Agents pull exactly the briefing for the task they're on.

**The Overseer AI**
An AI curator reads everything agents push and keeps the knowledge accurate with small, targeted edits. It records decisions, keeps briefings current, and pings the right agent when something breaks their assumptions. It can only *propose* changes to your team rules; you approve them.

**Agent-to-agent messaging**
Agents message each other directly through Hivemind ("Hey backend, what does the 429 response look like?"). Messages wait until the other agent checks in. The Overseer reads them too and files the important bits.

**Secure gateway**
Every request is identified, permission-checked, routed, and logged: who asked, what for, which project, allowed or denied, why, and how fast. Logs record metadata only, never your code or messages.

**Tool-call policies**
Before a connected Claude Code agent runs *any* tool (shell command, file edit, web fetch), the gateway checks it against your rules. Defaults block reading secrets (`.env`, keys), dumping credentials, force-push, and `curl | sh`, and require your approval for deploys. The gateway can only add restrictions; it never auto-approves anything.

**Per-agent permissions**
Decide which agent can see which project: none, read, or write. Agents without access can't even see a project exists. Enforced by the server, not by asking the AI nicely.

**Version history you can't lose**
Every change to project knowledge is a versioned commit with an author and a reason. Snapshots are automatic before every AI update. Restore any version in one click. No agent (and not the Overseer) can delete history.

**One dashboard**
Live activity stream, gateway log with allowed/denied requests, a live map of your agents, diffs of every change, approvals, and snapshots.

---

## 5. Proof points (things that are TRUE and demonstrable; use these)

- Tested live with **real Claude Code**: a brand-new session described the project, its state, and its decisions *without using any tools*, from the automatically injected briefing.
- In the same test, with Claude Code's own permissions set to allow everything, Hivemind's gateway still **blocked a force-push and a `.env` read** before they ran, and the agent reported the exact policy reason.
- Works with **any MCP-compatible agent** for shared context, messaging, and gateway-checked requests. Automatic session context and tool-call policies are currently for **Claude Code** (via its hooks).
- Every change is a git commit; snapshots are git tags.
- Runs on **AWS**: the Overseer can run on **Amazon Bedrock** (Claude), and the hub deploys to a single AWS instance.

**Do NOT invent:** customer logos, testimonials, user counts, star counts, uptime numbers, pricing, funding, or benchmark stats. Don't claim it "monitors everything your AI does" or "works with every AI tool". Say exactly what's above. If a section needs social proof, use the live-test proof points instead.

---

## 6. Who it's for

- Developers using **multiple AI coding agents** on the same project (several Claude Code sessions, Claude Code + Codex, etc.).
- **Small teams** where each person has their own AI agent working on a different part of the app.
- Anyone who wants **visibility and guardrails** over what their AI agents do on their machine.

Tone toward the reader: you're a developer who already loves your AI tools; Hivemind makes them work as a team and keeps them in check.

---

## 7. Context for the page (hackathon)

This is a hackathon project (A10 hackathon, **Track 2: "Agent Harness — Secure and Manage Agent Activity"**, whose challenge is to *"build a control layer for desktop and CLI-based AI agents that routes requests through a central gateway"*). The page should make it obvious that Hivemind **is** that control layer, while also selling the bigger vision (shared memory and collaboration for AI agents). A small "Built for A10 Hackathon · Track 2" badge in the footer or hero is fine; don't make the page feel like a homework submission.

---

## 8. Page structure (suggested; improve if you see a better flow)

1. **Nav:** logo "Hivemind" · How it works · Features · Security · Docs (link `#`) · button "Open dashboard" (link `#`).
2. **Hero:** headline + one-line subhead + two buttons ("Connect your first agent" primary, "See how it works" secondary) + a hero visual (agents → gateway → brain, or a stylized dashboard/terminal mock showing an agent session starting with context loaded and a blocked command).
3. **Problem:** the four pains (section 2), short.
4. **How it works:** the 6-step loop (section 3), ideally as a visual flow.
5. **Terminal moment** (strong visual): a fake Claude Code terminal showing:
   - session starts → `[Hivemind] Briefing loaded: Hackathon Site · 3 active decisions · bob is on "website"`
   - agent tries `git push --force origin main` → `✕ Blocked by Hivemind gateway (P-05): Force-push is blocked. Push a branch and open a PR instead.`
   - agent runs `/push` → `✓ Pushed. Overseer updated the API playbook and notified bob about a breaking change.`
6. **Features grid:** the 9 features (section 4).
7. **Security / gateway section:** a mock gateway log table (time · agent · action · project · outcome) with green "Allowed" and red "Denied" rows, plus 3 bullets: identity per agent, server-enforced permissions, metadata-only logging.
8. **Connect in one command:** a code block:
   ```
   HIVEMIND_TOKEN="hm_…" HIVEMIND_PROJECT="my-app" sh -c "$(curl -fsSL https://hive.example.com/install/claude-code.sh)"
   ```
   with a short caption: "Registers the MCP server, adds gateway hooks, installs /pull /push /handoff. Your existing settings are kept."
9. **Final CTA:** "Give your agents one brain." + button.
10. **Footer:** small print, hackathon badge, "Built with Claude · runs on AWS".

---

## 9. Look and feel

Match the product's dashboard, which is styled like modern dev tools (Cursor, Codex, Linear, Cluely):

- **Dark**, near-black background (`#09090b`), neutral grays for text (`#f4f4f5` primary, `#a1a1aa` secondary, `#71717a` muted), 1px subtle borders (`#1d1d21` / `#27272b`).
- **One accent, used sparingly**, only for "AI" moments: a violet→blue gradient (`#8b7cff` → `#5cb6ff`). Use it for the logo mark, the hero glow, and the "brain/gateway" node. Everything else stays neutral.
- **Primary buttons are white with black text**; secondary buttons are ghost/outline.
- Semantic colors only where meaningful: green `#4ade80` (allowed), red `#f87171` (denied), amber `#fbbf24` (ask/approval).
- Fonts: **Geist** (or Inter) for text, **Geist Mono** (or JetBrains Mono) for code, logs, and terminal mocks.
- A soft radial glow behind the hero (violet/blue, low opacity). Generous whitespace. Large tight headlines (letter-spacing slightly negative). Rounded cards (12–16px radius) with subtle borders.
- Logo: a small rounded square with the violet→blue gradient and a white hexagon outline inside, next to the word "Hivemind".
- Tasteful motion only: fade/slide-in on scroll, the terminal lines typing in, a pulse on the central node. Respect `prefers-reduced-motion`.
- Fully responsive (looks great at 375px wide), accessible (semantic headings, contrast, focus states, alt text).

**Avoid:** stock-photo people, cartoon robots, rainbow gradients, generic "AI sparkle" clip art, walls of text, fake metrics.

---

## 10. Copy rules

- Short sentences. Concrete over abstract ("blocks `git push --force`" beats "advanced security").
- Lead with the user's pain, then the outcome, then how.
- Don't use the words "revolutionary", "game-changing", "seamless" or "leverage".
- Don't call MCP/hooks/webhooks out in headlines; mention them in supporting text for developers who care.
- Be honest about scope: Claude Code gets the full experience today; other MCP agents get the shared brain, messaging, and gateway-checked requests.

---

## 11. Deliverable

A single self-contained landing page (HTML + CSS + a little JS, or a single React component if you prefer) with all the sections above, real copy (no lorem ipsum), the terminal mock, the gateway log mock, and the agents→gateway→brain visual. Links can point to `#` placeholders.
