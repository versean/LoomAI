// Thin, serialized wrapper around a git repo. Every write in the brain goes through here,
// so every change is a commit, every commit has an author, and nothing is ever rewritten.
//
// Deliberately missing: reset, rebase, push --force, tag -d, commit --amend.
// No caller (and therefore no agent or conductor) can destroy history.

import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { currentUser } from "../context.js";

export const AUTHORS = {
  conductor: { name: "conductor", email: "conductor@hivemind.local" },
  human: { name: "human", email: "human@hivemind.local" },
  system: { name: "hivemind", email: "system@hivemind.local" },
};
// A "human" commit is attributed to the signed-in person making the request, when there is one.
export const authorFor = (actor) => {
  if (actor === "human") { const u = currentUser(); if (u?.email) return { name: u.name, email: u.email }; }
  return AUTHORS[actor] || { name: actor, email: `${actor}@agents.hivemind.local` };
};

export class GitRepo {
  constructor(dir) {
    this.dir = dir;
    this.chain = Promise.resolve();
  }

  // Serialize all git operations: one writer at a time.
  lock(fn) {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => {});
    return run;
  }

  raw(args, { author, input } = {}) {
    const env = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
    if (author) {
      env.GIT_AUTHOR_NAME = env.GIT_COMMITTER_NAME = author.name;
      env.GIT_AUTHOR_EMAIL = env.GIT_COMMITTER_EMAIL = author.email;
    }
    return new Promise((resolve, reject) => {
      const child = execFile("git", ["-c", "core.autocrlf=false", "-c", "core.quotepath=false", "-c", "core.longpaths=true", ...args],
        { cwd: this.dir, env, maxBuffer: 64 * 1024 * 1024, encoding: "utf8" },
        (err, stdout, stderr) => err ? reject(new Error(`git ${args[0]}: ${stderr || err.message}`)) : resolve(stdout));
      if (input !== undefined) { child.stdin.end(input); }
    });
  }

  async init() {
    fs.mkdirSync(this.dir, { recursive: true });
    if (!fs.existsSync(path.join(this.dir, ".git"))) {
      await this.raw(["init", "-q", "-b", "main"]);
      fs.writeFileSync(path.join(this.dir, "README.md"), "# Hivemind brain\n\nEvery change here is a commit. Snapshots are tags under `snap/` and `auto/`.\n");
      await this.raw(["add", "-A"]);
      await this.raw(["commit", "-q", "-m", "Initialize brain"], { author: AUTHORS.system });
    }
  }

  // Write files and commit them atomically. files: { "rel/path.md": "content" | null (delete) }
  commit(files, message, actor) {
    return this.lock(async () => {
      const touched = [];
      for (const [rel, content] of Object.entries(files)) {
        const abs = this.abs(rel);
        if (content === null) { if (fs.existsSync(abs)) { fs.rmSync(abs); touched.push(rel); } continue; }
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        const prev = fs.existsSync(abs) ? fs.readFileSync(abs) : null;
        const next = Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8");
        if (prev && prev.equals(next)) continue;
        fs.writeFileSync(abs, next);
        touched.push(rel);
      }
      if (!touched.length) return null;
      await this.raw(["add", "-A", "--", ...touched]);
      await this.raw(["commit", "-q", "-m", message, "--", ...touched], { author: authorFor(actor) });
      return (await this.raw(["rev-parse", "HEAD"])).trim();
    });
  }

  abs(rel) {
    const p = path.normalize(path.join(this.dir, rel));
    if (!p.startsWith(path.normalize(this.dir))) throw new Error("Path escapes brain");
    return p;
  }

  read(rel) {
    const p = this.abs(rel);
    return fs.existsSync(p) ? fs.readFileSync(p, "utf8") : null;
  }
  readBuffer(rel) { const p = this.abs(rel); return fs.existsSync(p) ? fs.readFileSync(p) : null; }
  exists(rel) { return fs.existsSync(this.abs(rel)); }
  list(relDir) {
    const p = this.abs(relDir);
    return fs.existsSync(p) ? fs.readdirSync(p, { withFileTypes: true }) : [];
  }

  async head() { return (await this.raw(["rev-parse", "--short", "HEAD"])).trim(); }

  // History for a path (or a directory). Never truncated in storage; limit is only for display.
  async log(rel = ".", limit = 200) {
    const out = await this.raw(["log", `-n${limit}`, "--format=%H%x1f%h%x1f%an%x1f%aI%x1f%s%x1e", "--", rel]);
    return out.split("\x1e").map(s => s.trim()).filter(Boolean).map(line => {
      const [sha, short, author, at, subject] = line.split("\x1f");
      return { sha, short, author, at, subject };
    });
  }

  async show(sha, rel) {
    if (!/^[0-9a-f]{4,40}$/i.test(sha) && !/^[\w./-]+$/.test(sha)) throw new Error("bad ref");
    try { return await this.raw(["show", `${sha}:${rel.replace(/\\/g, "/")}`]); } catch { return null; }
  }

  async filesAt(ref, relDir) {
    try {
      const out = await this.raw(["ls-tree", "-r", "--name-only", ref, "--", relDir]);
      return out.split("\n").filter(Boolean);
    } catch { return []; }
  }

  // Tags are the backups. Annotated, never deleted by any code path.
  tag(name, message, actor) {
    return this.lock(async () => {
      await this.raw(["tag", "-a", name, "-m", message || name], { author: authorFor(actor) });
      return name;
    });
  }

  async tags(prefix) {
    const out = await this.raw(["for-each-ref", "--sort=-creatordate", "--format=%(refname:short)%1f%(objectname:short)%1f%(*objectname:short)%1f%(creatordate:iso-strict)%1f%(taggername)%1f%(contents:subject)", `refs/tags/${prefix}`]);
    return out.split("\n").filter(Boolean).map(line => {
      const [name, obj, target, at, by, message] = line.split("\x1f");
      return { name, commit: target || obj, at, by, message };
    });
  }

  // Optional off-machine backup: push commits + tags to a remote (never force).
  async pushBackup(remoteUrl) {
    if (!remoteUrl) return false;
    return this.lock(async () => {
      try { await this.raw(["remote", "add", "backup", remoteUrl]); } catch {}
      await this.raw(["push", "-q", "backup", "main", "--tags"]);
      return true;
    });
  }
}
