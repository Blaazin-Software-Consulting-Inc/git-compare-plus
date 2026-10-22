/**
 * worktreeStatus — a status bar item saying which worktree this window is on
 * (`$(list-tree) main worktree`, `$(list-tree) .claude/worktrees/x`), and the "Go to…" list it
 * opens.
 *
 * Why next to the editor's own branch indicator: that one names the branch but not the folder,
 * and with several worktrees of one repo open in different windows the folder is what tells them
 * apart. Clicking opens Go to… (goTo.ts), where every worktree and branch says what picking it
 * does before anything happens.
 *
 * Shown only once the extension is active (it loads when its views or commands are first used),
 * and hidden when this window has no worktree of a known repo.
 */
import * as vscode from 'vscode';
import type { WorktreeEntry } from '../git/parsers';
import type { GitActions } from '../gitActions';
import { goToEntries, statusText, windowWorktree, type GoToEntry, type WindowWorktree } from '../goTo';
import type { Logger } from '../logger';
import type { RepositoriesProvider } from './repositoriesView';

/** Status bar item + Go to… picker. */
export class WorktreeStatus implements vscode.Disposable {
  private readonly item = vscode.window.createStatusBarItem('gitComparePlus.worktree', vscode.StatusBarAlignment.Left, 99);
  private readonly subscriptions: vscode.Disposable[];
  private current: WindowWorktree | undefined;
  // Each repo's worktrees, reloaded only when git state or folders change. Switching editors
  // re-reads this cache, so it runs no git commands.
  private candidates: { repo: WindowWorktree['repo']; worktrees: readonly WorktreeEntry[] }[] = [];

  constructor(
    private readonly repositories: RepositoriesProvider,
    private readonly actions: GitActions,
    private readonly windowFolders: () => readonly string[],
    private readonly logger: Logger,
  ) {
    this.item.name = 'Worktree';
    this.item.command = 'gitComparePlus.goTo';
    this.subscriptions = [
      this.item,
      vscode.window.onDidChangeActiveTextEditor(() => this.redraw()),
      // Branch switches and worktree changes arrive as Repositories reloads.
      repositories.onDidChangeTreeData(() => void this.update()),
    ];
    void this.update();
  }

  /** Reload each repo's worktrees, then redraw. Never throws. */
  async update(): Promise<void> {
    try {
      const repos = await this.repositories.getRepos();
      this.candidates = await Promise.all(repos.map(async (repo) => ({ repo, worktrees: await this.repositories.getWorktreesLight(repo) })));
    } catch (error) {
      // Cosmetic: the Repositories view reports the same failure; hide rather than show stale.
      this.logger.warn('worktree status unavailable', { function: 'update', reason: error instanceof Error ? error.message : String(error) });
      this.candidates = [];
    }
    this.redraw();
  }

  // Which worktree this window is on, from the cached lists and the active editor.
  private redraw(): void {
    this.current = windowWorktree(this.candidates, this.windowFolders(), vscode.window.activeTextEditor?.document.uri.fsPath);
    if (this.current === undefined) {
      this.item.hide();
      return;
    }
    const { repo, worktree } = this.current;
    this.item.text = `$(list-tree) ${statusText(this.current)}`;
    this.item.tooltip = `${repo.name}: ${worktree.path}\nOn ${worktree.branch ?? `a detached commit (${(worktree.head ?? '').slice(0, 7)})`}\n\nClick to go to another worktree or branch.`;
    this.item.show();
  }

  /** "Go to…": every worktree and branch of this window's repo, each with what picking it does. */
  async pick(): Promise<void> {
    await this.update();
    const current = this.current ?? (await this.firstRepoFallback());
    if (current === undefined) {
      void vscode.window.showInformationMessage('No git repository is open in this window.');
      return;
    }
    const { repo } = current;
    const entries = goToEntries(repo, await this.repositories.getWorktrees(repo), await this.repositories.getRefs(repo), this.windowFolders());
    const items = withSections(entries);
    const picked = await vscode.window.showQuickPick(items, { title: `Go to… (${repo.name})`, matchOnDescription: true, matchOnDetail: true });
    if (picked?.entry === undefined) {
      return;
    }
    await this.go(repo, picked.entry);
  }

  private async go(repo: WindowWorktree['repo'], entry: GoToEntry): Promise<void> {
    this.logger.info('go to picked', { function: 'go', repo: repo.name, kind: entry.kind, label: entry.label });
    if (entry.kind === 'branch') {
      await this.actions.openBranch({ kind: 'branch', repo, ref: entry.ref });
      return;
    }
    if (entry.inWindow) {
      void vscode.window.showInformationMessage(`${entry.label} is the worktree open in this window.`);
      return;
    }
    await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(entry.worktree.path), { forceNewWindow: true });
  }

  // With no worktree of any repo open here (e.g. a parent folder), use the first repo found.
  private async firstRepoFallback(): Promise<WindowWorktree | undefined> {
    const repo = (await this.repositories.getRepos())[0];
    const worktree = repo === undefined ? undefined : (await this.repositories.getWorktrees(repo))[0];
    return repo === undefined || worktree === undefined ? undefined : { repo, worktree };
  }

  dispose(): void {
    for (const subscription of this.subscriptions) {
      subscription.dispose();
    }
  }
}

type GoToItem = vscode.QuickPickItem & { readonly entry?: GoToEntry };

function withSections(entries: readonly GoToEntry[]): GoToItem[] {
  const items: GoToItem[] = [];
  let section: string | undefined;
  for (const entry of entries) {
    const next = entry.kind === 'worktree' ? 'Worktrees' : entry.ref.kind === 'local' ? 'Branches' : 'Remote branches';
    if (next !== section) {
      section = next;
      items.push({ label: next, kind: vscode.QuickPickItemKind.Separator });
    }
    items.push(
      entry.kind === 'worktree'
        ? { label: `$(${entry.inWindow ? 'window' : 'folder'}) ${entry.label}`, description: entry.outcome, detail: entry.detail, entry }
        : { label: `$(${entry.ref.kind === 'local' ? 'git-branch' : 'cloud'}) ${entry.label}`, description: entry.outcome, entry },
    );
  }
  return items;
}
