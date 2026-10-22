# Changelog

All notable changes to Git Compare+. Versions before 1.0.0 were internal and not published.

## 1.0.0 (unreleased)

First public release, as **Git Compare+** (previously developed as "Git Branch & Worktree
Compare"). Settings, commands and views now use the `gitComparePlus.` prefix.

### Comparing

- Every comparison has two named sides: **Reviewing** (what changed, the right side of every
  diff) and **Against** (what it's compared with, the left side). A ⇄ button swaps them.
- **Compare…** asks two questions, "What do you want to review?" and "Compare it with…". Both
  pickers are grouped the same way: This window, Worktrees, Branches, Remote branches, Tags, and
  Commits (search recent commits), and accept any typed branch, tag or commit ID.
- Each repo's **default Against** (its default branch unless changed) is shown on its row
  (`against origin/main`) and used by the one-click compare button.
- Fork support: `gitComparePlus.remote` (e.g. `upstream`) and per-repo
  `gitComparePlus.defaultBranches`.

### Worktrees and branches

- Every branch says where it lives: in this window, in another worktree, or not checked out.
- **Open…** on a branch says what it will do before doing it: open its worktree in a new window,
  or, for a branch not checked out, switch this window to it (refused with uncommitted changes;
  never stashes) or create a worktree for it.
- Status bar: which worktree this window is on; click for **Go to…** with every worktree and
  branch and what picking it does.

### Blame

- The current line's author, age and commit message at the end of the line, with a hover offering
  Open Commit, Compare with Previous and Compare with Working Tree; the same in the status bar.
- Blames the editor's text, so unsaved edits show as uncommitted lines instead of shifting lines.

### History

- **History** view: commits that changed the active file (following renames), or a selection's
  lines. Compare any version with the previous one, the working tree, any branch, tag, commit or
  worktree, or another version.
- ◀ ▶ editor buttons step through a file's versions.

### Commits

- **Commits** view: search by message, author, file, changed text or ID, on every branch and tag.
  Commits expand to their author, parents and changed files.
- The same commit actions everywhere a commit is listed: Review This Commit, Review Changes Since,
  Review Against…, Select / Review Against Selected, Compare These Two, Show Details, Copy ID.

### Stashes

- **Stashes** under each repo, with their files (including untracked ones). Open, Apply (keep),
  Pop (apply and remove), and Drop after a confirmation that says what is lost.

### Lightweight

- About 77 KB to download, no runtime dependencies, no account, no telemetry; activates after the
  editor has started, never during startup. Size and activation budgets are checked in CI on
  macOS, Linux and Windows.

## 0.9.0

- Line counts (+/−) and green/red diff-bar icons per changed file; reviewed checkboxes that clear
  when a file changes; commits ahead/behind on worktree and branch rows; a Commits group in
  Changes; folder (tree) layout; Swap Sides; Open File / Open File at Base.

## 0.8.0

- Background refresh failures are shown in the views; one notification if they persist.

## 0.7.0

- Automatic refresh of both views on file and git changes.

## 0.6.0

- Worktrees and branches ordered default branch, main, master, then newest first, with ages.

## 0.5.0

- Multi-select delete for branches and worktrees, with one confirmation listing what is lost.

## 0.4.0

- First version: Repositories and Changes views; compare worktrees and branches with any base,
  including another worktree's uncommitted edits; fetch, create and remove worktrees, create,
  delete and switch branches.
