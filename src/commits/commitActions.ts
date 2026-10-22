/**
 * commitActions — the actions every commit list offers, so a commit behaves the same wherever it
 * appears: the Commits group in Changes, the History view, and the Commits view.
 *
 *   Show Commit Details                     the commit, expanded, in the Commits view
 *   Open Commit (all files)                 every file it changed, in one multi-file diff
 *   Review This Commit                      Changes: Reviewing = the commit, Against = its parent
 *   Review Changes Since This Commit        Changes: Reviewing = the worktree, Against = the commit
 *   Review Against…                         Changes: Reviewing = the commit, Against = picked
 *   Select for Compare / Compare with Selected
 *                                           Changes: Reviewing = this, Against = the selected one
 *   Compare These Two (two rows selected)   Changes: Against = the older, Reviewing = the newer
 *   Copy Commit ID
 *
 * These are whole-commit comparisons, shown in Changes with its header, line counts and reviewed
 * marks. The History view adds file-level versions of the comparisons on top (historyView.ts).
 *
 * Each list hands its rows to `resolve` (extension.ts), which turns any row into a CommitTarget.
 */
import * as vscode from 'vscode';
import type { BaseSpec, CompareMode, RepoInfo, Subject } from '../comparison';
import type { GitCli } from '../git/gitCli';
import type { Logger } from '../logger';
import type { ComparisonSetup } from '../views/changesHeader';
import { openCommitChanges } from '../views/commitDiff';
import { commitTitle } from '../views/commitText';
import { olderFirst, type CommitTarget } from './commitTarget';

/** Collaborators from extension.ts. */
export interface CommitActionsDeps {
  getGit(): Promise<GitCli>;
  /** Any commit row (from any view) → its commit; undefined for other rows. */
  resolve(node: unknown): Promise<CommitTarget | undefined>;
  /** Show the commit in the Commits view. */
  showDetails(target: CommitTarget): Promise<void>;
  /** The grouped "Compare it with…" picker. */
  pickAgainst(repo: RepoInfo, reviewing: Subject, title: string): Promise<BaseSpec | undefined>;
  /** Show a comparison in Changes. */
  review(setup: ComparisonSetup): Promise<void>;
  /** Current settings needed for worktree comparisons. */
  settings(): { readonly includeUncommitted: boolean; readonly mode: CompareMode };
  readonly logger: Logger;
}

/** Registers the shared commit commands. */
export class CommitActions implements vscode.Disposable {
  private selected: CommitTarget | undefined;
  private readonly subscriptions: vscode.Disposable[];

  constructor(private readonly deps: CommitActionsDeps) {
    this.subscriptions = [
      this.command('showDetails', (target) => this.deps.showDetails(target)),
      this.command('openAll', async (target) => openCommitChanges(await this.deps.getGit(), target.repo, target.root, target.commit, this.deps.logger)),
      this.command('reviewCommit', (target) => this.reviewCommit(target)),
      this.command('reviewSince', (target) => this.reviewSince(target)),
      this.command('reviewAgainst', (target) => this.reviewAgainst(target)),
      this.command('select', (target) => this.select(target)),
      this.command('compareWithSelected', (target) => this.compareWithSelected(target)),
      this.command('copyId', (target) => vscode.env.clipboard.writeText(target.commit.sha)),
      vscode.commands.registerCommand('gitComparePlus.commit.compareTwo', (node: unknown, selection?: unknown[]) =>
        this.guard('compareTwo', () => this.compareTwo(selection ?? (node !== undefined ? [node] : []))),
      ),
    ];
  }

  private command(name: string, run: (target: CommitTarget) => Thenable<unknown> | Promise<unknown>): vscode.Disposable {
    return vscode.commands.registerCommand(`gitComparePlus.commit.${name}`, (node: unknown) =>
      this.guard(name, async () => {
        const target = await this.deps.resolve(node);
        if (target !== undefined) {
          await run(target);
        }
      }),
    );
  }

  private async reviewCommit(target: CommitTarget): Promise<void> {
    const parent = target.commit.parents[0];
    if (parent === undefined) {
      void vscode.window.showInformationMessage(`${commitTitle(target.commit)} is the first commit: there is nothing before it to compare with.`);
      return;
    }
    await this.deps.review({
      requests: [{ repo: target.repo, subject: commitSubject(target) }],
      base: { kind: 'ref', ref: parent, label: `${parent.slice(0, 7)} (parent)`, refKind: 'commit' },
      // A commit against its own parent: "since branch point" would be the same thing.
      mode: 'direct',
    });
  }

  private async reviewSince(target: CommitTarget): Promise<void> {
    const { includeUncommitted, mode } = this.deps.settings();
    await this.deps.review({
      requests: [{ repo: target.repo, subject: { kind: 'worktree', root: target.root, label: worktreeLabel(target), includeUncommitted } }],
      base: commitBase(target),
      mode,
    });
  }

  private async reviewAgainst(target: CommitTarget): Promise<void> {
    const subject = commitSubject(target);
    const base = await this.deps.pickAgainst(target.repo, subject, `Review ${commitTitle(target.commit)} against…`);
    if (base !== undefined) {
      await this.deps.review({ requests: [{ repo: target.repo, subject }], base, mode: this.deps.settings().mode });
    }
  }

  private async select(target: CommitTarget): Promise<void> {
    this.selected = target;
    await vscode.commands.executeCommand('setContext', 'gitComparePlus.commitSelected', true);
    vscode.window.setStatusBarMessage(`Selected ${target.commit.sha.slice(0, 7)} for compare: right-click another commit → Compare with Selected`, 5000);
  }

  private async compareWithSelected(target: CommitTarget): Promise<void> {
    const selected = this.selected;
    if (selected === undefined) {
      return;
    }
    if (selected.repo.commonDir !== target.repo.commonDir) {
      void vscode.window.showInformationMessage('The selected commit is in a different repository.');
      return;
    }
    await this.deps.review({ requests: [{ repo: target.repo, subject: commitSubject(target) }], base: commitBase(selected), mode: 'direct' });
  }

  private async compareTwo(nodes: readonly unknown[]): Promise<void> {
    const targets = (await Promise.all(nodes.map((node) => this.deps.resolve(node)))).filter((t): t is CommitTarget => t !== undefined);
    const [first, second] = targets;
    if (targets.length !== 2 || first === undefined || second === undefined) {
      void vscode.window.showInformationMessage('Select exactly two commits (Cmd/Ctrl-click) to compare them.');
      return;
    }
    if (first.repo.commonDir !== second.repo.commonDir) {
      void vscode.window.showInformationMessage('The two commits are in different repositories.');
      return;
    }
    const [older, newer] = olderFirst(first, second);
    await this.deps.review({ requests: [{ repo: newer.repo, subject: commitSubject(newer) }], base: commitBase(older), mode: 'direct' });
  }

  private async guard(name: string, run: () => Promise<void>): Promise<void> {
    try {
      await run();
    } catch (error) {
      this.deps.logger.error('commit action failed', error, { function: name });
      void vscode.window.showErrorMessage(`Git Compare+: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  dispose(): void {
    for (const subscription of this.subscriptions) {
      subscription.dispose();
    }
  }
}

function commitSubject(target: CommitTarget): Subject {
  return { kind: 'ref', ref: target.commit.sha, label: commitTitle(target.commit), refKind: 'commit' };
}

function commitBase(target: CommitTarget): BaseSpec {
  return { kind: 'ref', ref: target.commit.sha, label: commitTitle(target.commit), refKind: 'commit' };
}

// Worktree folder name, e.g. the repo name for its main worktree.
function worktreeLabel(target: CommitTarget): string {
  return target.root.split(/[\\/]/).filter((part) => part.length > 0).pop() ?? target.repo.name;
}
