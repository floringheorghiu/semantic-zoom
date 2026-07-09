#!/bin/bash
# SessionStart hook — Worktree hygiene (see CLAUDE.md "Worktree hygiene").
#
# Detects worktrees whose job is done (branch fully merged into main) or that
# look stale/abandoned, and reports them so Claude can proactively surface a
# cleanup proposal to the user at the start of the session. This script only
# DETECTS and REPORTS — it never merges, removes, or deletes anything.

set -u

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || exit 0
cd "$REPO_ROOT" || exit 0

MAIN_BRANCH="main"
git rev-parse --verify "$MAIN_BRANCH" >/dev/null 2>&1 || exit 0

CURRENT_WT="$(git rev-parse --show-toplevel)"
MERGED="$(git branch --merged "$MAIN_BRANCH" 2>/dev/null | sed 's/^[*+ ]*//')"
STALE_DAYS=14

FINDINGS=""

wt_path=""
wt_branch=""
finish_entry() {
  if [ -z "$wt_path" ] || [ -z "$wt_branch" ] || [ "$wt_branch" = "$MAIN_BRANCH" ]; then
    return
  fi
  if [ "$wt_path" = "$CURRENT_WT" ]; then
    return # never flag the worktree this session is running in
  fi
  if printf '%s\n' "$MERGED" | grep -qx "$wt_branch"; then
    FINDINGS="${FINDINGS}- MERGED: \`$wt_path\` (branch \`$wt_branch\`) is fully merged into \`$MAIN_BRANCH\` — safe to remove (git worktree remove, then git branch -d).\n"
  else
    last_epoch="$(git log -1 --format=%ct "$wt_branch" 2>/dev/null || echo 0)"
    now_epoch="$(date +%s)"
    age_days=$(( (now_epoch - last_epoch) / 86400 ))
    if [ "$last_epoch" != "0" ] && [ "$age_days" -gt "$STALE_DAYS" ]; then
      FINDINGS="${FINDINGS}- STALE: \`$wt_path\` (branch \`$wt_branch\`) has no commits in ${age_days} days and is not merged into \`$MAIN_BRANCH\` — worth reviewing (merge or drop).\n"
    fi
  fi
}

while IFS= read -r line; do
  case "$line" in
    worktree\ *) wt_path="${line#worktree }" ;;
    branch\ *) wt_branch="${line#branch refs/heads/}" ;;
    "") finish_entry; wt_path=""; wt_branch="" ;;
  esac
done < <(git worktree list --porcelain; printf '\n')
finish_entry

if [ -n "$FINDINGS" ]; then
  context="Worktree hygiene check (CLAUDE.md): the following worktree(s) look done or stale — surface this to the user proactively with a proposed cleanup, per CLAUDE.md's rule to never auto-merge or auto-remove:\n${FINDINGS}"
  jq -n --arg ctx "$context" '{hookSpecificOutput: {hookEventName: "SessionStart", additionalContext: $ctx}}'
fi
exit 0
