// Pulls recent commits and open PRs for a project's linked GitHub repo, so briefings and
// the conductor know what actually landed. Public repos work without a token; set
// GITHUB_TOKEN for private repos and higher rate limits.

import * as brain from "./store/brain.js";
import * as db from "./store/db.js";

export function repoOf(slug) {
  for (const l of brain.listLinks(slug)) {
    const m = l.url.match(/^https?:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:[/?#]|$)/i);
    if (m && (l.kind === "repo" || !brain.listLinks(slug).some(x => x.kind === "repo"))) return `${m[1]}/${m[2]}`;
  }
  return null;
}

async function gh(path) {
  const headers = { accept: "application/vnd.github+json", "user-agent": "hivemind-hub" };
  if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const r = await fetch(`https://api.github.com${path}`, { headers });
  if (!r.ok) throw new Error(`GitHub ${r.status}: ${(await r.text()).slice(0, 160)}`);
  return r.json();
}

export async function sync(slug) {
  const repo = repoOf(slug);
  if (!repo) return null;
  try {
    const [info, commits, pulls] = await Promise.all([
      gh(`/repos/${repo}`), gh(`/repos/${repo}/commits?per_page=12`), gh(`/repos/${repo}/pulls?state=open&per_page=10`),
    ]);
    const data = {
      repo, url: info.html_url, defaultBranch: info.default_branch, stars: info.stargazers_count, language: info.language,
      commits: commits.map(c => ({ sha: c.sha.slice(0, 7), message: c.commit.message.split("\n")[0], author: c.author?.login || c.commit.author?.name, at: c.commit.author?.date, url: c.html_url })),
      pulls: pulls.map(p => ({ number: p.number, title: p.title, author: p.user?.login, branch: p.head?.ref, url: p.html_url, draft: p.draft, at: p.updated_at })),
    };
    const prev = db.getGithub(slug)?.data;
    db.setGithub(slug, repo, data);
    const fresh = prev ? data.commits.filter(c => !prev.commits?.some(p => p.sha === c.sha)) : [];
    if (fresh.length) db.activity("github", "github", `${fresh.length} new commit${fresh.length > 1 ? "s" : ""} on **${repo}**: ${fresh.slice(0, 3).map(c => `\`${c.sha}\` ${c.message}`).join(" · ")}`, { project: slug });
    return data;
  } catch (e) {
    db.setGithub(slug, repo, db.getGithub(slug)?.data || { repo }, e.message);
    throw e;
  }
}

export function startPolling() {
  const tick = () => { for (const p of brain.listProjects()) if (repoOf(p.slug)) sync(p.slug).catch(e => console.error("[github]", p.slug, e.message)); };
  setTimeout(tick, 3000);
  setInterval(tick, 10 * 60 * 1000);
}
