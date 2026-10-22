# Roadmap to 1.0

Status: agreed 2026-10-22. Each phase ends with tests, a build, a local install and a review
before the next one starts.

## Positioning

The GitLens features people actually use, made easier to understand. No account, no upgrade
prompts, no telemetry. The core is comparing worktrees, branches and commits. Blame and history
are built around that core.

"Lightweight" is a claim we have to be able to measure. Phase 0 sets budgets, and CI fails when
they're broken.

## Design principles (every phase)

- **One sidebar** with a few views. Rarely used views start collapsed.
- **Plain language over git jargon.** Say what will happen ("Open this branch in a new window"),
  not which git command runs.
- **Both sides of a comparison are always visible and named.** You can always see what you're
  reviewing and what it's compared with.
- **Every action that changes something says what it will do first.** Destructive actions confirm
  what would be lost, as the delete dialogs already do.
- **Quiet defaults:** line blame on; CodeLens, gutters and heatmap off.
- **No account, no sign-in prompts, no upgrade prompts.**

## Phases

### Phase 0: Foundations (done)

- Setting for the remote name and a per-repo default-branch override, so fork workflows
  (`origin` = your fork, `upstream` = the project) pick the right default branch.
- CI on macOS, Linux and Windows (GitHub Actions).
- Bundle into one file (esbuild); load each feature when it is first used.
- Performance budgets enforced in CI: package size limit, load time limit, and no git commands
  while nothing is shown.

### Phase 1: Clear comparison sides (done, awaiting review)

Replaces the "comparison base" idea, which is hard to explain, with two named sides.

- **Header rows rename to the sides:** `Reviewing:` (right side, what changed) and `Against:`
  (left side, what it's compared with). A ⇄ button on the header swaps them.
- **One "Compare…" flow, two questions:** "What do you want to review?" then "Compare it with…".
  Each picker groups the choices the same way: *This window*, *Worktrees*, *Branches*, *Remote
  branches*, *Tags*, *Commits* (search by message or ID), and *Type any ref*. The default branch
  is preselected as the second side.
- **Commits as either side** anywhere a branch can be used.
- **Diff tabs name both sides** consistently: `file.ts (origin/main ↔ feature-x)`.
- The repo's saved default (formerly "Set as Comparison Base") is now the **default Against**:
  every repo row shows `against origin/main`, with **Change Default Against…** on the repo row and
  **Use as Default Against** on worktrees and branches.

### Phase 2: Clear worktree and branch switching

GitLens made the difference between switching branches and opening a worktree hard to see. Here
the outcome is always stated before anything happens.

- **Every branch row says where it lives:** "in this window", "in worktree `feature-x`", or
  "not checked out".
- **One primary action per branch, "Open"**, whose result depends on where the branch lives and
  is stated up front:
  - already in a worktree → "Open worktree `feature-x` in a new window";
  - not checked out → a choice with the trade-off spelled out:
    - "Switch this window to it": changes the files in this folder; refused if you have
      uncommitted changes, never stashes for you;
    - "Create a worktree for it": a separate folder; your current work is untouched.
- **Status bar item** showing this window's worktree and branch. Clicking it opens "Go to…",
  listing worktrees and branches with the outcome of picking each one.

### Phase 3: Blame

- Blame for the current line at the end of the line (author, age, message), shown when the
  cursor settles.
- Blame hover: full message, author, date, and actions: Open Commit, Compare with Previous,
  Compare with Working Tree.
- Blame in the status bar.
- Blame cached per file version; unsaved edits are blamed from the editor's text.
- Settings to turn each part off.

### Phase 4: File and line history, with commit comparisons

- **File History** view for the current file (follows renames) and **Line History** for a
  selection.
- **Comparing commits from history**:
  - click a commit → that file compared with its previous version;
  - right-click → Compare with Previous, Compare with Working Tree, Compare with Branch…;
  - **Select for Compare**, then **Compare with Selected** on a second commit, the same pattern
    as the Explorer's "Select for Compare";
  - multi-select two commits → **Compare These Two**;
  - **Review This Commit** / **Review Since This Commit**: open the whole-repo comparison in
    Changes with that commit as one side.
- Back and forward buttons in the editor title to step through a file's past versions.

### Phase 5: Commit search and details

- Search commits by message, author, file, changed text, or ID.
- Commit details view: message, parents, files, and diffs. The Commits group in Changes and the
  history views open it.
- Every commit list (Commits group, history, search results) offers the same comparison actions
  as Phase 4.

### Phase 6: Stashes

- List stashes; show a stash's changes; apply, pop, and drop (drop confirms first).

### Release prep, then 1.0

- Final name (the current name is too narrow for blame and history), checked for marketplace and
  GitHub conflicts.
- Repository `Blaazin-Software-Consulting-Inc/<name>`; publisher ID and copyright for Blaazin
  Software Consulting Inc.
- LICENSE, CHANGELOG, a public README with a three-step quick start and screenshots, a
  marketplace icon, and the untrusted-workspace declaration.
- Measured size and load-time numbers in the README before claiming "lightweight".

## After 1.0, if users ask

Tags, remotes, and contributors views; CodeLens; blame gutter, heatmap, and changes gutter;
interactive rebase editor; a simple commit graph.

## Not planned

Launchpad and pull-request integrations, AI features, Cloud Patches, and anything that needs an
account or a server.
