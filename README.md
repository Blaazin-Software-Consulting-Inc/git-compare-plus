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
| **Remove Worktree…** | linked worktree | Confirmation names the folder and how many uncommitted files would be **permanently deleted**. It also warns when the worktree was created by Claude Code. The branch is kept. |
| **Delete Branch…** | local branch not checked out anywhere | Confirmation says how many commits aren't in the default branch and would be lost. |

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
(re-run after edits), **Fetch and Refresh** and **Clear**. Its `…` menu has the same three header actions.

If the base is a remote branch that hasn't been fetched recently, the **With:** row turns into a
warning: `fetched 3 days ago, may be out of date`.

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
| `src/branchCandidates.ts`       | Ordering of the Compare With… list                                   |
| `src/logger.ts`                 | Structured logging to an output channel                              |

## Design notes

- **Git is run directly, not through the editor's git API.** The built-in API only knows repos
  that are open in the window. Linked worktrees (for example `.claude/worktrees/*`) usually
  aren't, so it can't list or read them. The built-in extension is still used to discover repos
  and to find the git binary.
- **Default branch**: `origin/HEAD`, falling back to `origin/main`, `origin/master`, `main`, then
  `master`. To fix a repo where `origin/HEAD` isn't set, run `git remote set-head origin --auto`.
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
