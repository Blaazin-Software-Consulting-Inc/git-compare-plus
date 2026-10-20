# Git Branch & Worktree Compare

A local Cursor / VS Code extension for reviewing what a git **worktree** or **branch** changes
compared with `main` (or any other branch). It works with a single repository or with many
repositories in one window, such as `my-services.code-workspace`.

## Use

Click the **Git Branch & Worktree Compare** icon in the activity bar (the left-hand icon strip).
The sidebar has two sections.

**Repositories**: every repo in the window. In a single-repo window it opens already expanded.

```
orders-service     feature/login-retry
├─ Worktrees  2
│  ├─ feature/login-retry   main worktree
│  └─ claude/feature-x             .claude/worktrees/feature-x
├─ Branches  14
└─ Remote Branches  31
```

**Order:** in each group, the repo's default branch comes first, then `main`, then `master`.
Everything else follows, newest commit first. The main worktree is always first under Worktrees.
Each worktree and branch shows the age of its latest commit (`3 days ago`). **Compare With…**
lists branches in the same order.

- **$(git-compare) button** (hover over a repo, worktree or branch): compare it with the repo's
  **comparison base**. That's the repo's default branch (`origin/HEAD`, which is `master` or
  `main` depending on the repo) unless you've set something else.
- **Right-click → Compare With…**: pick the default branch, another worktree, any branch, or type
  a tag or commit ID.
- **Right-click a worktree or branch → Set as Comparison Base**: from then on, the compare button
  for that repo uses it. The base gets a $(target) marker, and the repo row shows
  `base: …`. **Clear Comparison Base** goes back to the default branch. The choice is saved per
  workspace.
- **Right-click a worktree → Open Worktree in New Window**.
- **Title bar $(diff-multiple)**: compare every repo's main worktree with its own default branch
  in one go. **$(cloud-download)** fetches every repo.

Each repo row shows when it was last fetched (`fetched 3 h ago`). If that's longer than
`staleFetchHours`, the row turns yellow, because comparisons with `origin/…` may be missing newer
commits.

### Git actions (right-click)

Only actions you'd take while reviewing are here. Commit, push, pull, merge, rebase and stash
stay in Cursor's Source Control panel.

| Action | On | Safety |
| --- | --- | --- |
| **Fetch** | repo (or title bar: all repos) | Runs without prompting for credentials; if git needs a password it hasn't stored, the fetch fails quickly and the reason is shown. |
| **Create Branch From Here…** | repo, worktree, branch | Doesn't switch to the new branch. Optionally creates a worktree for it right after. |
| **Create Worktree…** | branch not checked out anywhere, or a remote branch | A remote branch gets a local branch with the same name that tracks it. The suggested folder is `<repo>.worktrees/<branch>` next to the repo. |
| **Switch Main Worktree to This Branch** | branch not checked out anywhere, or a remote branch | Refused while the main worktree has uncommitted changes. Nothing is carried over or stashed for you. |
| **Remove Worktree(s)…** | one or more linked worktrees | Confirmation names each folder and how many uncommitted files would be **permanently deleted**, plus the total. It also warns when a worktree was created by Claude Code. Branches are kept. |
| **Delete Branch(es)…** | one or more local branches not checked out anywhere | Confirmation lists how many commits each branch has that aren't in the default branch and would be lost, plus the total. |

**Deleting several at once:** select multiple items with Cmd/Shift-click, even across repos.
Then right-click, or press **Cmd+Backspace** (**Delete** on Windows/Linux). One confirmation
covers the whole selection. Items that can't be deleted are listed as **Skipped** with the reason:
a checked-out branch, a remote branch, or the main worktree. With the Delete key, a selection that
mixes worktrees and branches removes the worktrees first. That way, a branch whose only
checkout was one of those worktrees is deleted in the same pass.

**Changes** starts with three header rows that say exactly what was compared. Click a row to
change that part, and the comparison re-runs:

```
✎  Comparing: feature-x    worktree · INCLUDING uncommitted edits          ← click: include / exclude
⇄  With: origin/master     default branch · click to change               ← click: pick another base
⑂  Showing: changes since branch point · click for all differences        ← click: switch mode
```

Below the header are the changed files, with A/M/D/R/U badges. When several repos are compared,
files are grouped by repo; repos with no changes are hidden and counted at the top. Click a file
to open its diff in the editor.

The title bar has **Open All Changes** (every file in one scrolling diff), **Refresh Comparison**
(re-run now; normally this happens automatically), **Fetch and Refresh** and **Clear**. Its `…` menu has the same three header actions.

If the base is a remote branch that hasn't been fetched recently, the **With:** row turns into a
warning: `fetched 3 days ago, may be out of date`.

### Staying current

Both views update themselves; you only need **Refresh** if you've turned automatic refresh off.

| View | Updates when | How |
| --- | --- | --- |
| **Repositories** | You commit, switch, create or delete branches, add or remove worktrees, or fetch, whether in Source Control, the terminal or Claude Code | Follows Cursor's git change events. Each repo reloads about 1 s after changes stop, and the tree redraws only if something actually changed. |
| **Changes** | Files change in a compared worktree (edits, saves, new or deleted files), or the git state of a compared repo changes | Watches the compared worktree folders, including ones not open in this window, plus git events for the repos involved. Re-runs about 1.5 s after changes stop and redraws only if the results differ. Turn off with `branchCompare.autoRefresh`. |
| **Ages** (`3 h ago`, stale fetch) | Every minute | Redraw only, no git commands. |

Changes inside `.git`, `node_modules`, `dist`, `build`, `out`, `coverage`, `cdk.out` and
similar folders don't trigger a re-run.

**Fetching is never automatic:** it contacts your git host using your credentials. If Cursor's
own `git.autofetch` is on, the remote branches it fetches show up here automatically.

### What is compared

**What you're reviewing (right-hand side)**

| You select                 | Right-hand side                                                           |
| -------------------------- | ------------------------------------------------------------------------- |
| repo / worktree (default)  | the files on disk: commits plus staged, unstaged and untracked edits      |
| repo / worktree, committed only | the worktree's last commit (HEAD). The header says how many uncommitted files are **NOT included** |
| branch                     | the branch's latest commit                                                |

For the files-on-disk case, the right-hand side is the real file, so you can edit it directly in
the diff editor.

**What it's compared with (left-hand side)**

| Base                                  | Left-hand side                                                    |
| ------------------------------------- | ----------------------------------------------------------------- |
| default branch / any branch or ref    | that branch (where your work split off from it, by default)       |
| worktree, committed only              | that worktree's last commit (HEAD); its uncommitted files are counted as NOT included |
| worktree, including uncommitted edits | a **snapshot** of that worktree's files on disk, retaken on every Refresh |

**Mode**

- **Changes since branch point** (default): like a pull request. The comparison starts from where
  your branch split off from the base, so commits added to `main` after that don't show up as
  changes.
- **All differences**: every difference between the two sides. This mode is required when the base
  includes uncommitted edits, because those edits have no branch point.

A snapshot is built from a temporary copy of the worktree's git index. That worktree's files and
staging area are never modified. The only side effect is that git stores unreferenced copies of
the edited files, which `git gc` cleans up later.

| Setting                            | Default            | Meaning                                                             |
| ---------------------------------- | ------------------ | ------------------------------------------------------------------- |
| `branchCompare.includeUncommitted` | `true`             | Start worktree comparisons with uncommitted edits included.         |
| `branchCompare.includeUntracked`   | `true`             | Treat never-added files as uncommitted edits (shown, or counted).   |
| `branchCompare.compareMode`        | `sinceBranchPoint` | Starting mode: `sinceBranchPoint` or `allDifferences`.               |
| `branchCompare.staleFetchHours`    | `24`               | After this many hours without a fetch, a repo is flagged as out of date. |
| `branchCompare.autoRefresh`        | `true`             | Re-run the comparison in Changes automatically when its inputs change.   |

Logs are under **View → Output → Git Branch & Worktree Compare**. For more detail, run
**Developer: Set Log Level…** and choose Debug.

## Develop

```bash
npm install
npm test          # vitest: unit tests + real-git integration tests (temp repos, worktrees, a local bare "remote")
npm run build     # tsc → dist/
npm run package   # build + branch-compare.vsix
```

Install or update it in each Cursor profile that should have it, then run **Developer: Reload Window**:

```bash
/Applications/Cursor.app/Contents/Resources/app/bin/cursor --install-extension branch-compare.vsix --profile <your-profile> --force
```

```bash
/Applications/Cursor.app/Contents/Resources/app/bin/cursor --install-extension branch-compare.vsix --profile <your-profile> --force
```

`--profile` matters. Without it, the extension goes into the Default profile, but Cursor opens
`my-services.code-workspace` with **<your-profile>**.

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
| `src/baseStore.ts`              | Comparison base saved per repo                                       |
| `src/gitActions.ts`             | Fetch, create/remove worktree, create/delete/switch branch, with their confirmation dialogs |
| `src/operations.ts`             | Safety checks for those actions (counts of what would be lost), naming rules, fetch age |
| `src/views/content.ts`          | `branch-compare:` documents (file content at a revision)             |
| `src/treeOrder.ts`              | Order of worktrees and branches: default/main/master first, then newest |
| `src/branchCandidates.ts`       | Order of branch names when comparing several repos at once          |
| `src/logger.ts`                 | Structured logging to an output channel                              |
| `src/autoRefresh/gitEvents.ts`  | Follows Cursor's git change events, waiting for changes to stop per repo |
| `src/autoRefresh/changesAutoRefresh.ts` | Re-runs Changes: folder watchers + git events → one non-overlapping re-run |
| `src/autoRefresh/scheduling.ts` | Waiting for changes to stop, combining overlapping re-runs, change detection |
| `src/autoRefresh/watchPaths.ts` | Which folders are watched and which changes are ignored             |

## Design notes

- **Git is run directly, not through the editor's git API.** The built-in API only knows repos
  that are open in the window. Linked worktrees (for example `.claude/worktrees/*`) usually
  aren't, so it can't list or read them. The built-in extension is still used to discover repos
  and to find the git binary.
- **Default branch**: `origin/HEAD`, falling back to `origin/main`, `origin/master`, `main`, then
  `master`. To fix a repo where `origin/HEAD` isn't set, run `git remote set-head origin --auto`.
- **Automatic refresh redraws only when something changed.** Cursor reports a repo change after
  every `git status` it runs, including on window focus. Comparing results before redrawing keeps
  the tree still. It also stops the comparison triggering itself: a base snapshot writes git
  objects, which can prompt one more status run, and the re-run that follows finds identical
  results and stops.
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
