#!/usr/bin/env bash
# scripts/vercel-ignore-build.sh — make Vercel refuse to deploy a commit whose CI failed.
#
# NOT ENABLED. This file does nothing until somebody sets it as Vercel's "Ignored Build Step":
#
#   Vercel -> Project -> Settings -> Git -> Ignored Build Step -> Custom
#   Command:  bash scripts/vercel-ignore-build.sh
#   Then add a repo-scoped GitHub token as the GH_TOKEN environment variable in Vercel.
#
# It is left switched off deliberately. Changing when a project deploys is a decision about how the
# team works, and making it silently on somebody's behalf — in a repository where the deploy budget
# is 100 builds a day and a stuck deploy is an outage — is not a change to slip into a patch.
#
# HOW VERCEL READS THIS: exit 0 means "skip the build", exit 1 means "build". That is inverted
# relative to every other script in this directory, and getting it backwards means either deploying
# everything or deploying nothing. It is spelled out at each exit below.
#
# IT FAILS TOWARDS DEPLOYING. If the token is missing, GitHub is unreachable, or the checks have not
# reported yet, this script BUILDS. A deploy gate that blocks when its own dependency is down turns
# a GitHub outage into an inability to ship, which is worse than the problem it solves. The gate is
# for a commit that is KNOWN BAD, not for one whose state is unknown.

set -uo pipefail

REPO="${VERCEL_GIT_REPO_OWNER:-}/${VERCEL_GIT_REPO_SLUG:-}"
SHA="${VERCEL_GIT_COMMIT_SHA:-}"

say() { printf '[ignore-build] %s\n' "$*"; }

if [ -z "${GH_TOKEN:-}" ]; then
  say "GH_TOKEN is not set — cannot ask GitHub whether checks passed. BUILDING."
  exit 1
fi
if [ -z "$SHA" ] || [ "$REPO" = "/" ]; then
  say "no commit or repository in the environment (is this a Vercel build?). BUILDING."
  exit 1
fi

say "asking GitHub about ${REPO}@${SHA:0:7}"

RESPONSE="$(curl -sS -m 20 \
  -H "Authorization: Bearer $GH_TOKEN" \
  -H "Accept: application/vnd.github+json" \
  "https://api.github.com/repos/${REPO}/commits/${SHA}/check-runs?per_page=100" 2>/dev/null)" || {
  say "GitHub API call failed. BUILDING (this gate never blocks on its own outage)."
  exit 1
}

# The `gate` job in .github/workflows/ci.yml is the single check to consult: it already aggregates
# every other job and treats a skipped or cancelled job as not-a-pass.
CONCLUSION="$(printf '%s' "$RESPONSE" | node -e '
  let s = "";
  process.stdin.on("data", (d) => (s += d)).on("end", () => {
    try {
      const runs = (JSON.parse(s).check_runs || []).filter((r) => r.name === "gate");
      if (!runs.length) return process.stdout.write("absent");
      // Most recent first; GitHub returns newest first but sorting makes that explicit.
      runs.sort((a, b) => new Date(b.started_at) - new Date(a.started_at));
      process.stdout.write(runs[0].status === "completed" ? String(runs[0].conclusion) : "pending");
    } catch { process.stdout.write("unreadable"); }
  });
' 2>/dev/null)"

case "$CONCLUSION" in
  failure|timed_out|cancelled|action_required)
    say "CI gate concluded '$CONCLUSION'. SKIPPING THE BUILD."
    say "Fix the failing checks and push again; this commit will not be deployed."
    exit 0   # 0 = skip
    ;;
  success)
    say "CI gate passed. BUILDING."
    exit 1   # 1 = build
    ;;
  pending)
    # Vercel and Actions start at the same moment, so this is the COMMON case, not an edge case.
    # Blocking here would mean almost nothing ever deploys. Branch protection is the real gate;
    # this is a backstop for a commit already known to be bad.
    say "CI gate has not finished yet. BUILDING — branch protection is the real gate, this is a backstop."
    exit 1
    ;;
  absent)
    say "no 'gate' check found for this commit (an older commit, or CI did not run). BUILDING."
    exit 1
    ;;
  *)
    say "could not read the check result ('$CONCLUSION'). BUILDING."
    exit 1
    ;;
esac
