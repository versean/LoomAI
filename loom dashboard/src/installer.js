// One-command Claude Code setup. The scripts are generated with this hub's address baked in.
// They take everything else from environment variables so no secret ever goes in a URL:
//   HIVEMIND_TOKEN    agent token (secure mode)          HIVEMIND_PROJECT  project slug for this folder
//   HIVEMIND_AGENT    agent name (open mode only)        HIVEMIND_STRICT   1 = block tool calls if the hub is unreachable
//
// What they do, in the current folder:
//   1. register the Loom MCP server for Claude Code (user scope: every project)
//   2. merge Loom's HTTP hooks into .claude/settings.local.json (personal, not committed),
//      keeping any hooks you already have
//   3. install /push /pull /handoff slash commands into .claude/commands
//   4. make sure .claude/settings.local.json is git-ignored (it holds the agent token)

// SessionStart only supports `command` (and `mcp_tool`, which is skipped at launch because MCP servers
// aren't connected yet), so it uses curl in exec form: no shell, stdin = hook JSON, stdout = our JSON reply.
// -f makes non-2xx a silent non-blocking failure. Windows uses curl.exe (ships with Windows 10+;
// plain `curl` is an alias in Windows PowerShell).
export function hookTemplate(base, { project, agent, strict, secure, windows }) {
  const q = new URLSearchParams();
  if (project) q.set("project", project);
  if (!secure && agent) q.set("agent", agent);
  const qs = q.toString() ? `?${q}` : "";
  const h = (event, timeout, extra = {}) => ({
    type: "http", url: `${base}/hooks/${event}${qs}`, timeout,
    ...(secure ? { headers: { Authorization: "Bearer __HIVEMIND_TOKEN__" } } : {}),
    ...extra,
  });
  const sessionStartCmd = {
    type: "command", command: windows ? "curl.exe" : "curl", timeout: 15,
    args: ["-fsS", "--max-time", "12", "-X", "POST", "-H", "content-type: application/json",
      ...(secure ? ["-H", "Authorization: Bearer __HIVEMIND_TOKEN__"] : []),
      "--data-binary", "@-", `${base}/hooks/session-start${qs}`],
  };
  return {
    hooks: {
      SessionStart: [{ matcher: "startup|resume|clear|compact", hooks: [sessionStartCmd] }],
      PreToolUse: [{ matcher: "*", hooks: [h("pre-tool-use", 5, strict ? { onFailure: "block" } : {})] }],
      Stop: [{ hooks: [h("stop", 5)] }],
      SessionEnd: [{ hooks: [h("session-end", 2)] }],
    },
  };
}

export const MERGE_JS = `
const fs=require("fs"),p=".claude/settings.local.json",ours=JSON.parse(fs.readFileSync(".claude/.hivemind-hooks.json","utf8"));
let cur={};try{cur=JSON.parse(fs.readFileSync(p,"utf8").replace(/^\\uFEFF/,""))}catch{}
cur.hooks=cur.hooks||{};
for(const ev of Object.keys(ours.hooks)){const keep=(cur.hooks[ev]||[]).filter(g=>!JSON.stringify(g).includes("/hooks/"+({SessionStart:"session-start",PreToolUse:"pre-tool-use",Stop:"stop",SessionEnd:"session-end"})[ev]));cur.hooks[ev]=keep.concat(ours.hooks[ev]);}
fs.writeFileSync(p,JSON.stringify(cur,null,2)+"\\n");fs.unlinkSync(".claude/.hivemind-hooks.json");
`.trim();

export function shScript(base, secure) {
  return `#!/bin/sh
# Loom: connect Claude Code to ${base}
set -e
HUB="${base}"
TOKEN="\${HIVEMIND_TOKEN:-}"; PROJECT="\${HIVEMIND_PROJECT:-}"; AGENT="\${HIVEMIND_AGENT:-}"; STRICT="\${HIVEMIND_STRICT:-0}"
say() { printf '  %s\\n' "$1"; }
command -v claude >/dev/null 2>&1 || { echo "Claude Code ('claude') isn't on your PATH. Install it first: https://code.claude.com"; exit 1; }
${secure ? `[ -n "$TOKEN" ] || { echo "Set HIVEMIND_TOKEN to the agent token from the dashboard (Connect agent)."; exit 1; }` : `[ -n "$AGENT" ] || AGENT="$(whoami 2>/dev/null || echo agent)"`}
echo "Connecting Claude Code to Loom ($HUB)"

claude mcp remove hivemind -s user >/dev/null 2>&1 || true
${secure ? `claude mcp add --transport http -s user hivemind "$HUB/mcp" --header "Authorization: Bearer $TOKEN" >/dev/null` : `claude mcp add --transport http -s user hivemind "$HUB/mcp?agent=$AGENT" >/dev/null`}
say "MCP server registered (all your projects)"

mkdir -p .claude/commands
curl -fsSL "$HUB/install/claude-code-hooks.json?project=$PROJECT&agent=$AGENT&strict=$STRICT" | sed "s|__HIVEMIND_TOKEN__|$TOKEN|g" > .claude/.hivemind-hooks.json
if command -v node >/dev/null 2>&1; then
  node -e '${MERGE_JS.replace(/'/g, "'\\''")}'
  say "Hooks merged into .claude/settings.local.json"
elif [ ! -f .claude/settings.local.json ]; then
  mv .claude/.hivemind-hooks.json .claude/settings.local.json
  say "Hooks written to .claude/settings.local.json"
else
  cp .claude/settings.local.json .claude/settings.local.json.bak
  mv .claude/.hivemind-hooks.json .claude/settings.local.json
  say "Hooks written to .claude/settings.local.json (your old file is in settings.local.json.bak; merge any hooks you need)"
fi

for c in push pull handoff; do curl -fsSL "$HUB/kit/$c.md" -o ".claude/commands/$c.md"; done
say "Slash commands installed: /pull /push /handoff"

if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  grep -qxF ".claude/settings.local.json" .gitignore 2>/dev/null || echo ".claude/settings.local.json" >> .gitignore
  say ".claude/settings.local.json is git-ignored (it contains your agent token)"
fi
echo "Done. Start Claude Code here: the project briefing loads automatically and tool calls go through the Loom gateway."
`;
}

export function ps1Script(base, secure) {
  return `# Loom: connect Claude Code to ${base}
$ErrorActionPreference = "Stop"
$Hub = "${base}"
$Token = $env:HIVEMIND_TOKEN; $Project = $env:HIVEMIND_PROJECT; $Agent = $env:HIVEMIND_AGENT; $Strict = if ($env:HIVEMIND_STRICT) { $env:HIVEMIND_STRICT } else { "0" }
if (-not (Get-Command claude -ErrorAction SilentlyContinue)) { Write-Host "Claude Code ('claude') isn't on your PATH. Install it first: https://code.claude.com"; return }
${secure ? `if (-not $Token) { Write-Host 'Set $env:HIVEMIND_TOKEN to the agent token from the dashboard (Connect agent).'; return }` : `if (-not $Agent) { $Agent = $env:USERNAME }`}
Write-Host "Connecting Claude Code to Loom ($Hub)"

try { claude mcp remove hivemind -s user *> $null } catch {}
${secure ? `claude mcp add --transport http -s user hivemind "$Hub/mcp" --header "Authorization: Bearer $Token" | Out-Null` : `claude mcp add --transport http -s user hivemind "$Hub/mcp?agent=$Agent" | Out-Null`}
Write-Host "  MCP server registered (all your projects)"

New-Item -ItemType Directory -Force .claude/commands | Out-Null
$tpl = (Invoke-WebRequest -UseBasicParsing "$Hub/install/claude-code-hooks.json?project=$Project&agent=$Agent&strict=$Strict&os=windows").Content
$ours = ($tpl -replace '__HIVEMIND_TOKEN__', $Token) | ConvertFrom-Json
$path = Join-Path (Get-Location) ".claude/settings.local.json"
$cur = if (Test-Path $path) { (Get-Content $path -Raw) -replace '^\\uFEFF', '' | ConvertFrom-Json } else { New-Object psobject }
if (-not $cur.hooks) { $cur | Add-Member -NotePropertyName hooks -NotePropertyValue (New-Object psobject) -Force }
$slug = @{ SessionStart = "session-start"; PreToolUse = "pre-tool-use"; Stop = "stop"; SessionEnd = "session-end" }
foreach ($ev in $ours.hooks.PSObject.Properties.Name) {
  $keep = @($cur.hooks.$ev | Where-Object { $_ -and (($_ | ConvertTo-Json -Depth 20 -Compress) -notmatch ("/hooks/" + $slug[$ev])) })
  $cur.hooks | Add-Member -NotePropertyName $ev -NotePropertyValue (@($keep) + @($ours.hooks.$ev)) -Force
}
[IO.File]::WriteAllText($path, ($cur | ConvertTo-Json -Depth 20), (New-Object Text.UTF8Encoding $false))
Write-Host "  Hooks merged into .claude/settings.local.json"

foreach ($c in "push", "pull", "handoff") { Invoke-WebRequest -UseBasicParsing "$Hub/kit/$c.md" -OutFile ".claude/commands/$c.md" }
Write-Host "  Slash commands installed: /pull /push /handoff"

if (Get-Command git -ErrorAction SilentlyContinue) {
  git rev-parse --is-inside-work-tree *> $null
  if ($LASTEXITCODE -eq 0) {
    $gi = Join-Path (Get-Location) ".gitignore"
    if (-not ((Test-Path $gi) -and (Select-String -Path $gi -Pattern '^\\.claude/settings\\.local\\.json$' -Quiet))) { Add-Content -Path $gi -Value ".claude/settings.local.json" }
    Write-Host "  .claude/settings.local.json is git-ignored (it contains your agent token)"
  }
}
Write-Host "Done. Start Claude Code here: the project briefing loads automatically and tool calls go through the Loom gateway."
`;
}
