#!/usr/bin/env bash
# Builds the public submission copy of Allevia in a new temporary directory: the tracked tree of one commit, minus the
# files that hold real business data, as ONE commit with no history, plus a LICENSE (MIT, unless the tree has one).
# It then runs the repo's hygiene test and a secrets scan on exactly that copy, and prints what it left out.
#
#   scripts/export-public.sh [--ref <commit>] [--out <dir>] [--exclude <path or glob>]... [--keep-real-material] [--no-tests]
#
# What stays out (by default): the evals, notes, screenshots and generated posters or reels that show the founder's real
# businesses. Only the founder can say they may ship (issues #12 and #13); then pass --keep-real-material. The public copy
# shows the synthetic business (Shiftly, `seed-demo`) in docs/demo-screens/ instead.
#
# Safety:
# - It never pushes and never adds a remote. Publishing is a separate, manual step (docs/submission-checklist.md §2).
# - The source repo is only read (`git archive`): its branches, history, index and working tree are not touched.
# - `git archive` exports tracked files only, so data/, models/, node_modules/ and env files cannot come along; they
#   are excluded again below in case one was ever tracked.
# - Only the synthetic demo company (scripts/seed-demo.ts, tests/fixtures/) is the data the copy ships with.
# Env: EXPORT_AUTHOR_NAME (default "Ankit Vohra"), EXPORT_AUTHOR_EMAIL (default the GitHub noreply address).
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REF="HEAD"
OUT=""
RUN_TESTS=1
KEEP_REAL=0
EXTRA=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --ref) REF="$2"; shift 2 ;;
    --out) OUT="$2"; shift 2 ;;
    --exclude) EXTRA+=("$2"); shift 2 ;;
    --keep-real-material) KEEP_REAL=1; shift ;;
    --drop-screenshots) shift ;; # the old name of what is now the default
    --no-tests) RUN_TESTS=0; shift ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

SHA="$(git -C "$REPO" rev-parse --verify "$REF^{commit}")"
if [[ -z "$OUT" ]]; then OUT="$(mktemp -d "${TMPDIR:-/tmp}/allevia-public.XXXXXX")"; fi
if [[ -e "$OUT" && -n "$(ls -A "$OUT" 2>/dev/null)" ]]; then echo "refusing: $OUT is not empty" >&2; exit 1; fi
case "$(cd "$(dirname "$OUT")" 2>/dev/null && pwd)/$(basename "$OUT")" in
  "$REPO"|"$REPO"/*) echo "refusing: the export must be outside the repository ($REPO)" >&2; exit 1 ;;
esac
mkdir -p "$OUT"

# What never ships. Real business data first, then anything that is local state.
EXCLUDE=(
  "data" "models" "node_modules" "web/node_modules" "web/dist" "site/dist" ".env" ".env.local"
  # eval reports quote real answers about Aamdani and AVS Atelier; the eval sets name their real entities
  # (the synthetic business's reports, docs/evals/*-demo_growth.md and evals/hero.yaml, ship)
  "docs/evals/2026-*-aamdani.md" "docs/evals/2026-*-avs_atelier.md" "evals/aamdani.yaml" "evals/avs.yaml" "evals/hero-aamdani.yaml"
  # notes written from private copies of the real graphs, or from their real drafts, numbers and brand files
  "docs/MORNING-REPORT.md" "docs/content-trials.md" "docs/proactive-trials.md" "docs/skills-trials.md"
  "docs/website-checkup-trials.md" "docs/design-research.md"
)
# Pictures and generated work that show the real businesses: screenshots of their screens, the posters, ads and reels made
# for them, the stand-up drafts. Left out unless the founder says to keep them (--keep-real-material).
REAL_MATERIAL=("docs/screenshots" "docs/creative-live" "docs/proactive")
if [[ "$KEEP_REAL" == 0 ]]; then EXCLUDE+=("${REAL_MATERIAL[@]}"); fi
EXCLUDE+=("${EXTRA[@]+"${EXTRA[@]}"}")

echo "Exporting $SHA to $OUT"
git -C "$REPO" archive --format=tar "$SHA" | tar -x -C "$OUT"

removed=()
shopt -s nullglob dotglob
for pat in "${EXCLUDE[@]}"; do
  for path in "$OUT"/$pat; do
    [[ -e "$path" || -L "$path" ]] || continue
    removed+=("${path#"$OUT"/}")
    rm -rf "$path"
  done
done
# any env file but the documented example
while IFS= read -r f; do removed+=("${f#"$OUT"/}"); rm -f "$f"; done < <(find "$OUT" -name '.env*' ! -name '.env.example' -type f)

if [[ ! -f "$OUT/LICENSE" && ! -f "$OUT/LICENSE.md" ]]; then
  cat > "$OUT/LICENSE" <<EOF
MIT License

Copyright (c) 2026 Ankit Vohra

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

Vendored third-party data and skills keep their own licences (vendor/playbooks/,
vendor/skills/, .claude/skills/brag-slim/).
EOF
  echo "Added LICENSE (MIT)."
fi

# A fresh repository: one commit, its own identity, no remote.
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
git -C "$OUT" init -q -b main
git -C "$OUT" config user.name "${EXPORT_AUTHOR_NAME:-Ankit Vohra}"
NOREPLY="Ankit-Vohra"; NOREPLY+="@users.noreply.github.com" # GitHub's noreply form, built in two parts for the hygiene scan
git -C "$OUT" config user.email "${EXPORT_AUTHOR_EMAIL:-$NOREPLY}"
git -C "$OUT" config commit.gpgsign false
git -C "$OUT" add -A

# ---------- scans, on exactly what is staged ----------
fail=0
echo "Secrets scan…"
SECRET_RE='(-----BEGIN [A-Z ]*PRIVATE KEY-----|AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,}|sk-ant-[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9]{32,}|xox[abpr]-[A-Za-z0-9-]{10,}|[MN][A-Za-z0-9_-]{23,25}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,38}|EAA[A-Za-z0-9]{60,}|(CLAUDE_CODE_OAUTH_TOKEN|ANTHROPIC_API_KEY|DISCORD_TOKEN|DISCORD_BOT_TOKEN)=[^[:space:]#]+)'
# Placeholders (`NAME=<token>`) and the suite's patterned fakes (ABCDEF…, 0123…, tok-…) are not secrets; the hygiene
# test below holds every tracked file to the stricter detectors as well.
FAKE_RE='=<|=\$|ABCDEFGHIJ|0123456789|abcdefghij|=["'"'"']?(tok|fake|example|dummy|test|xxx)'
if hits="$(git -C "$OUT" grep -I -n -o -E "$SECRET_RE" -- . ':!package-lock.json' ':!web/package-lock.json' | grep -v -i -E "$FAKE_RE" | cut -d: -f1,2)"; then
  echo "  possible secrets (file:line, values not shown):"; echo "$hits" | sed 's/^/    /'; fail=1
else echo "  none found"; fi
if git -C "$OUT" grep -n -E '^[A-Z_]+=[^[:space:]#]' -- .env.example >/dev/null 2>&1; then
  echo "  .env.example carries a value"; fail=1
fi

if [[ "$RUN_TESTS" == 1 ]]; then
  echo "Hygiene test (tests/hygiene.test.ts) on the export…"
  # The test needs the dependencies; borrow them from this checkout, or from the main checkout when this is a git
  # worktree (a worktree has no node_modules of its own). Never run `npm install` in the export itself.
  DEPS="$REPO/node_modules"
  if [[ ! -d "$DEPS" ]]; then
    MAIN="$(git -C "$REPO" worktree list --porcelain 2>/dev/null | awk '/^worktree /{print substr($0,10); exit}')"
    if [[ -n "$MAIN" && -d "$MAIN/node_modules" ]]; then DEPS="$MAIN/node_modules"; fi
  fi
  if [[ ! -d "$DEPS" ]]; then
    echo "  FAILED: no node_modules to run the test with (run npm install in $REPO, or pass --no-tests)"; fail=1
  else
    ln -s "$DEPS" "$OUT/node_modules"
    if (cd "$OUT" && npx --no-install vitest run tests/hygiene.test.ts >"$OUT/.hygiene.log" 2>&1); then
      echo "  passed"
    else
      echo "  FAILED (log: $OUT/.hygiene.log)"; fail=1
    fi
    rm -f "$OUT/node_modules"
  fi
fi

# Links that point at what was left out would be dead in the public repo: say which, so the pages can be fixed (a warning,
# not a failure: the founder may add the material back).
echo "Relative links in README.md and docs/**/*.md…"
broken="$(node "$REPO/scripts/maint/check-links.mjs" "$OUT")"
if [[ -n "$broken" ]]; then echo "  dead links in the copy (file -> target):"; echo "$broken" | sed 's/^/    /'; else echo "  none"; fi

if [[ "$fail" == 1 ]]; then
  echo "Not committed: fix the findings above, then commit in $OUT yourself." >&2
  exit 1
fi
rm -f "$OUT/.hygiene.log"
git -C "$OUT" commit -q -m "Allevia: Graph Hacks submission" -m "Exported from $SHA as one commit with no history."

echo
echo "Done: $OUT"
echo "  one commit: $(git -C "$OUT" rev-parse --short HEAD), $(git -C "$OUT" ls-files | wc -l | tr -d ' ') files, no remote"
echo "  left out:"
for r in "${removed[@]+"${removed[@]}"}"; do echo "    $r"; done
[[ ${#removed[@]} -eq 0 ]] && echo "    (nothing matched)"
echo "  also never exported: anything untracked or ignored (data/, models/, node_modules/, env files)"
if [[ "$KEEP_REAL" == 1 ]]; then
  echo "  REVIEW before publishing: --keep-real-material put the real businesses' screenshots, posters and reels in the copy"
  echo "  (docs/screenshots, docs/creative-live, docs/proactive). Keep them only with the founder's yes."
fi
echo "Nothing was pushed. To publish, follow docs/submission-checklist.md §2."
