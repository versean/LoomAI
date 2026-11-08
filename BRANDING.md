# Loom AI — brand guide

Everything the landing page uses, in one place. Values match `index.html` exactly.

## Name and voice

- **Name:** Loom AI. Write it as two words, capital L, capital AI.
- **What it is:** a shared brain and secure gateway for your AI coding agents.
- **Hero line:** One brain for all your AI agents.
- **Voice:** plain, specific, developer-to-developer. Say what it does ("blocks `git push --force`"), not what it is ("advanced security").
- **Avoid:** "revolutionary", "game-changing", "seamless", "leverage", punchy two-fragment slogans, and invented numbers, logos or testimonials.
- **The curator** is called **the Overseer**. The hub is **Loom AI**. The storage is **the project brain**, with sections: projects, convos, files, summaries.

## Logo

- **Mark:** the blue looped ribbon. File: `assets/loom-mark.png` (512×512, transparent background).
- **Favicon:** `assets/favicon.png` (64×64).
- **Wordmark:** the mark, then "Loom" in white and "AI" in a cobalt gradient (`#7389FF` → `#2A45E8`, top to bottom).
- **Sizes used:** 26px in the nav and footer, 34px in the workflow hub, 46–54px in feature tiles.
- **Background:** always dark (`#08090A` or a dark tile). Don't place it on cobalt or light backgrounds.

## Colour

### Brand blue (cobalt)
| Role | Hex |
|---|---|
| Main brand blue | `#2A45E8` |
| Light highlight | `#6078FF` |
| Brightest highlight | `#96A8FF` |
| Deep shadow | `#1F34C4` |
| Darkest shadow | `#0E165C` |
| Blue text on dark | `#8EA2FF` |

Use cobalt sparingly: logo, the Loom AI tag in the terminal, focus rings, text selection. Everything else stays neutral. No cyan or sky blue.

### Neutrals
| Role | Hex |
|---|---|
| Page background | `#08090A` |
| Surface 1 (cards) | `#0F1012` |
| Surface 2 (raised) | `#151619` |
| Surface 3 (chips, code) | `#1C1D21` |
| Border subtle | `#1C1D21` |
| Border | `#26272C` |
| Border strong | `#34353B` |
| Main text | `#F7F8F8` |
| Secondary text | `#B4B6BC` |
| Muted text | `#8A8F98` (5.9:1 on the background) |

### Status (gateway log only)
| Role | Hex |
|---|---|
| Allowed | `#4ADE80` |
| Denied | `#F87171` |
| Waiting for approval | `#FBBF24` |

Status is never shown by colour alone: each one also has an icon and a word.

## Type

| Use | Font | Notes |
|---|---|---|
| Headlines | **Instrument Serif** (400) | Hero 48–76px, section heads 36–56px, line height ~1.0–1.05, tracking −0.015 to −0.02em |
| Body, UI | **Inter** (400/500/600) | Body 16–17px, line height 1.6 |
| Code, labels, logs | **Geist Mono** (400/500) | 11–13px |
| Statements | Inter 500 | 22–32px, first sentence white, rest muted grey (Linear-style two-tone) |

All three load from Google Fonts.

## Layout and surfaces

- Max content width 1180px, 32px side padding (16px on phones).
- Sections have 128px vertical padding (88px on phones).
- Rounded corners: 10px buttons, 14–16px cards and windows.
- Borders are 1px, low contrast. No drop-shadow-heavy cards and no background gradients or glows.
- Buttons: light primary (`#F7F8F8` on dark text), dark secondary, and text links with a small arrow.

## Motion

- One-time load: nav fades down, hero words rise one by one, the terminal tilts up into place, then the session types out.
- Scroll moments: the "Your agents finally work as a team" paragraph lights up word by word; FIG drawings draw themselves; the dashboard tilts up and its rows land in order; feature mocks lift in.
- Workflow figure: three people's agents (Dan · Claude Code, Sara · Codex, Priya · Cursor) send dot trains through their own gateway to Loom AI and the project brain. Push writes (summaries + convos, sometimes files) and never returns; pull reads and returns; rejected requests bounce off the gateway in red. It runs only while on screen and has a pause button.
- Easing `cubic-bezier(0.2, 0, 0, 1)`. Button press scales to 0.96.
- Everything respects reduced motion: it becomes simple fades or a still figure.

## Accessibility

- Text contrast meets WCAG AA on every surface.
- Visible focus ring (2px `#8EA2FF`) on every control; skip link to main content.
- Animated areas have a pause control or stop on their own; decorative motion is hidden from screen readers and described with a text label instead.
