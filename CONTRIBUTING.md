# Contributing to Git Compare+

Issues and pull requests are welcome at
https://github.com/Blaazin-Software-Consulting-Inc/git-compare-plus.

## Build and test

```bash
npm install
npm test          # vitest: unit tests + real-git integration tests (temp repos, worktrees, a local bare "remote")
npm run build     # type check (tsc --noEmit) + esbuild bundle → dist/extension.js
npm run package   # minified build + git-compare-plus.vsix
npm run budget    # fail if the bundle or the .vsix is over its size budget
npm run bench     # time the main actions on git/git (cloned once into .bench/, ~270 MB);
                  # --check fails if a median is over its limit, --json writes the results
npm run test:host # downloads VS Code 1.90 into .vscode-test/, activates the extension in it,
                  # checks it activates only after startup, every command is registered,
                  # and activate() is within its time budget
npm run generate:icons   # rewrite media/diff-bar/*.svg after changing src/views/diffBar.ts
npm run generate:icon    # redraw media/icon.png (keep media/icon.svg in step)
```

CI (`.github/workflows/ci.yml`) runs the tests, packaging, the budget and the host test on macOS,
Linux and Windows, and the benchmark with `--check` on Linux.

To try a build, install the `.vsix` and run **Developer: Reload Window**:

```bash
code --install-extension git-compare-plus.vsix --force
```

```bash
cursor --install-extension git-compare-plus.vsix --force
```

In Cursor, add `--profile <name>` to install into a profile other than Default.

## Layout

| Path                            | Role                                                                 |
| ------------------------------- | -------------------------------------------------------------------- |
| `src/extension.ts`              | Activation, commands, branch picker, opening diffs                   |
| `src/comparison.ts`             | Comparison logic: subjects, bases, modes, uncommitted handling — no `vscode` import |
| `src/git/gitCli.ts`             | Runs git commands: worktrees, branches, diffs, file contents, worktree snapshots, fetch |
| `src/git/parsers.ts`            | Pure parsers for git's output                                        |
| `src/repoDiscovery.ts`          | Finds repos via the built-in git extension, with workspace folders as fallback |
| `src/repos.ts`                  | Groups worktrees under their repo                                    |
| `src/views/repositoriesView.ts` | Repositories tree                                                    |
| `src/views/changesView.ts`      | Changes tree + A/M/D/R/U badges                                      |
| `src/views/changesHeader.ts`    | Wording of the three header rows (subject / base / mode)             |
| `src/views/diffBar.ts`          | Green/red diff-bar icons and the coloured hover; `npm run generate:icons` writes `media/diff-bar/` |
| `src/views/commitText.ts`       | Wording of the Commits group and commit rows                          |
| `src/views/fileTree.ts`         | Groups changed files into compacted folders for the tree layout       |
| `src/swapSides.ts`              | Swap Sides: subject ↔ base, keeping each side's uncommitted choice    |
| `src/views/lineStatsText.ts`    | Wording of `+12 −3` line counts (files, repo rows, view title)       |
| `src/review/fingerprints.ts`    | Identity of each file's diff (blob IDs of both sides) for reviewed marks |
| `src/review/reviewStore.ts`     | Reviewed marks saved per repo, pinned to a diff fingerprint          |
| `src/review/reviewToggles.ts`   | Groups checkbox changes into store writes                            |
| `src/baseStore.ts`              | Comparison base saved per repo                                       |
| `src/gitActions.ts`             | Fetch, create/remove worktree, create/delete/switch branch, with their confirmation dialogs |
| `src/operations.ts`             | Safety checks for those actions (counts of what would be lost), naming rules, fetch age |
| `src/views/content.ts`          | `git-compare-plus:` documents (file content at a revision)           |
| `src/aheadBehind.ts`            | Commits ahead of / behind the default Against for each row (`↑3 ↓12`) |
| `src/commits/commitSearch.ts`   | Search kinds and their `git log` arguments                              |
| `src/commits/commitsView.ts`    | Commits view: search results and expandable commit details            |
| `src/commits/commitActions.ts`  | The actions every commit list shares (review, select/compare, copy, …) |
| `src/commits/commitTarget.ts`   | "A commit in a repo", the shape all commit lists hand to those actions |
| `src/history/historyModel.ts`   | History: previous version of each entry, ◀ ▶ stepping, wording          |
| `src/history/historyView.ts`    | History view, its commit comparisons, and the ◀ ▶ editor buttons       |
| `src/blame/blameController.ts`  | Current-line blame: end-of-line note, hover, status bar, hover actions |
| `src/blame/blameText.ts`        | Wording of the blame note, status text and hover (escaped, with command links) |
| `src/views/commitDiff.ts`       | Open one commit's changes in a multi-file diff (Commits group, blame)  |
| `src/stashes.ts`                | A stash's files (tracked + untracked), its wording, the Drop confirmation |
| `src/branchLocation.ts`         | Where a branch is checked out, and what Open… offers for it            |
| `src/goTo.ts`                   | Go to… entries, and which worktree the status bar describes           |
| `src/views/worktreeStatus.ts`   | The status bar item and the Go to… picker                             |
| `src/sideChoices.ts`            | The grouped choices for "What do you want to review?" / "Compare it with…" |
| `src/views/sidePicker.ts`       | Renders those choices as a quick pick; Search commits…; typed refs    |
| `src/paths.ts`                  | Path comparison (separators, Windows case) and short path display     |
| `src/defaultBranch.ts`          | Which branch is a repo's default: remote setting, per-repo overrides, fallbacks |
| `src/treeOrder.ts`              | Order of worktrees and branches: default/main/master first, then newest |
| `src/branchCandidates.ts`       | Order of branch names when comparing several repos at once          |
| `src/logger.ts`                 | Structured logging to an output channel                              |
| `src/autoRefresh/gitEvents.ts`  | Follows the editor's git change events, waiting for changes to stop per repo |
| `src/autoRefresh/changesAutoRefresh.ts` | Re-runs Changes: folder watchers + git events → one non-overlapping re-run |
| `src/autoRefresh/scheduling.ts` | Waiting for changes to stop, combining overlapping re-runs, change detection |
| `src/autoRefresh/watchPaths.ts` | Which folders are watched and which changes are ignored             |
| `bench/bench.ts`                | The speed benchmark: what is timed, on which repo, and the CI limits   |
| `src/autoRefresh/failureTracker.ts` | Background-failure tracking: when to show the stale message, when to notify once |

## Design notes

- **Git is run directly, not through the editor's git API.** The built-in API only knows repos
  that are open in the window. Linked worktrees (for example `.claude/worktrees/*`) usually
  aren't, so it can't list or read them. The built-in extension is still used to discover repos
  and to find the git binary.
- **Default branch** (`src/defaultBranch.ts`): a `gitComparePlus.defaultBranches` override if one
  exists, otherwise `<remote>/HEAD` (`gitComparePlus.remote`, default `origin`), falling back to
  `<remote>/main`, `<remote>/master`, `main`, then `master`. An override naming a branch that
  doesn't exist is logged and ignored. To fix a repo where `<remote>/HEAD` isn't set, run
  `git remote set-head <remote> --auto`.
- **Activates after startup, never during it.** The only activation event is `onStartupFinished`,
  so blame and the status bar are ready once a file is open, without delaying the editor's start.
  Activation itself does no git work beyond finding the repositories; `npm run test:host` checks
  the activation event and that `activate()` stays within its budget. Locally `activate()` takes a
  few milliseconds; finding the repositories continues in the background after it returns.
- **Blame is cached per file version** (`src/blame/blameController.ts`). The editor's text goes to
  `git blame --incremental --contents -`, so unsaved edits don't shift the lines below them.
  Moving the cursor re-reads the cache. A git change in any repo clears it.
- **Automatic refresh redraws only when something changed.** The editor's git extension reports a
  repo change after every `git status` it runs, including on window focus. Comparing results before redrawing keeps
  the tree still. It also stops the comparison triggering itself: a base snapshot writes git
  objects, which can prompt one more status run, and the re-run that follows finds identical
  results and stops.
- **Reviewed marks are pinned to blob IDs, not revisions.** A file's fingerprint is the base-side
  blob plus the subject-side blob (files on disk are hashed the way `git hash-object` does). A
  revision changes for reasons unrelated to the file, such as another commit or any edit in a
  snapshot base, and would reset every mark. A blob ID changes only when that file does. In
  repos with clean filters (`core.autocrlf`, LFS), the hash on disk can differ from the committed
  blob, so a mark made with uncommitted edits included may not carry over to "committed only".
- **Git commands run with `GIT_OPTIONAL_LOCKS=0`** so they don't fight the editor's background
  `git status` for `index.lock`.
- **Credentials embedded in remote URLs are redacted** (`https://user:token@…` →
  `https://<redacted>@…`) before git's error output reaches the logs or an error message.
- **Destructive actions always check first, then confirm, then act** (`operations.ts` →
  modal dialog → git). Git's "force" options are only used after you confirm exactly what will
  be lost.
- **Context menus** depend on each item's state. Tree items carry flags such as
  `comparable.branch.local.checkedOut.base`, and `package.json` matches them with regexes;
  `test/menus.test.ts` checks each action appears exactly where it should.
