// A small synthetic vault, built in a temp dir as a real git repo with dated commits, for the brain source and the
// pipeline tests. SYNTHETIC: invented names and facts, same shapes as a real company vault. Nothing here is real.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export const VAULT_FILES: Record<string, string> = {
  "README.md": `# Widget Co vault

Start with [[00-command/PENDING]], then the decisions in [[60-decisions/001-human-review]].
`,
  "10-company/overview.md": `# Company brief

Widget Co sells hand-made widgets on Instagram and through its website.
The founder, Meera, reviews every post before it goes out. Ask questions at help@widget.example.

## Server access
The shop runs on a rented box; the admin password lives with the founder.

## Channels
Instagram is the main channel: reels bring most new buyers. See [[60-decisions/001-human-review|the review rule]] and
[[15-tech/access]] for the setup. Inline code is not a link: \`[[README]]\`.
`,
  "60-decisions/001-human-review.md": `# 001 — Human review for every post
**Date** 2026-10-01 · **Status** accepted · **Decided by** founder

**Context.** Two auto-posted reels had the wrong price in September.

**Decision.** Every post and reel waits for the founder's approval before it is published.

**Consequences.** Posting slows by a day. The scout agent drafts, the founder approves.
`,
  "70-reports/daily/2026-10-10.md": `# Daily brief 2026-10-10

Instagram reels reached 1,200 accounts yesterday. Sign-ups: 14.
Following [[60-decisions/001-human-review]], 3 reels wait for approval.
`,
  "00-command/PENDING.md": `# Pending

## Founder only — NOW
| # | action | why |
|---|---|---|
| N1 | **Approve the October reels** | they are drafted |
| N2 | ~~Renew the domain~~ DONE 2026-10-09 | the site stays up |

## Agent work
- Draft three reels for the Diwali sale (owner: scout)
`,
  "agents/scout.md": `# Scout

Drafts reels and posts for Widget Co. Reads [[60-decisions/001-human-review]].
`,
  "15-tech/access.md": "# Access\n\nThe box key is in the usual place.\n",
  "70-reports/security-audit-2026-10-07.md": "# Security audit\n\nNothing to see.\n",
  "registry/agents/scout.yaml": `id: scout
name: Scout (drafts)
department: content
kind: scheduled
status: active
does: Drafts reels and posts.
connectors:
  - instagram
`,
  "registry/connectors/instagram.yaml": `id: instagram
name: Instagram connector
purpose: Publishes approved reels and reads their numbers.
status: connected
used_by:
  - scout
`,
  "registry/departments/content.yaml": `id: content
name: Content
purpose: Makes the posts and reels.
agents:
  active: [scout]
`,
  "assets/logo.png": "not really a png",
};

interface Commit { subject: string; date: string; files: Record<string, string | null>; mv?: [string, string] }

// The history: the founder sets the vault up; an agent files the report; the librarian renames and edits the brief
// (so --follow matters); a commit under Allevia's reserved namespace touches the README (it must be ignored).
export const VAULT_COMMITS: Commit[] = [
  {
    subject: "set up the vault", date: "2026-10-01T09:00:00+05:30",
    files: Object.fromEntries(Object.entries(VAULT_FILES).filter(([p]) => p !== "70-reports/daily/2026-10-10.md" && p !== "10-company/overview.md")
      .map(([p, t]) => [p, t]).concat([["10-company/brief-draft.md", VAULT_FILES["10-company/overview.md"]!.replace("Widget Co sells", "Widget Co makes")]])),
  },
  { subject: "agent:scout: daily brief 2026-10-10", date: "2026-10-10T08:00:00+05:30", files: { "70-reports/daily/2026-10-10.md": VAULT_FILES["70-reports/daily/2026-10-10.md"]! } },
  {
    subject: "agent:librarian: file the brief under its final name", date: "2026-10-11T10:00:00+05:30",
    mv: ["10-company/brief-draft.md", "10-company/overview.md"], files: { "10-company/overview.md": VAULT_FILES["10-company/overview.md"]! },
  },
  { subject: "agent:allevia-guard: touch the readme", date: "2026-10-12T10:00:00+05:30", files: { "README.md": `${VAULT_FILES["README.md"]!}\n` } },
];

function git(dir: string, args: string[], env: Record<string, string> = {}): string {
  return execFileSync("git", ["-C", dir, "-c", "user.name=Fixture Founder", "-c", "user.email=founder@fixture.example", "-c", "commit.gpgsign=false", ...args], {
    encoding: "utf8", env: { ...process.env, ...env },
  });
}

export function writeVaultFile(dir: string, rel: string, text: string): void {
  mkdirSync(dirname(join(dir, rel)), { recursive: true });
  writeFileSync(join(dir, rel), text);
}

// Builds the vault and returns its path plus a cleanup.
export function makeFixtureVault(): { dir: string; head: string; commit: (c: Commit) => string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "allevia-vault-"));
  git(dir, ["init", "-q", "-b", "main"]);
  const commit = (c: Commit): string => {
    if (c.mv) git(dir, ["mv", c.mv[0], c.mv[1]]);
    for (const [rel, text] of Object.entries(c.files)) {
      if (text === null) git(dir, ["rm", "-q", rel]);
      else writeVaultFile(dir, rel, text);
    }
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-q", "-m", c.subject], { GIT_AUTHOR_DATE: c.date, GIT_COMMITTER_DATE: c.date });
    return git(dir, ["rev-parse", "HEAD"]).trim();
  };
  let head = "";
  for (const c of VAULT_COMMITS) head = commit(c);
  return { dir, head, commit, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
