/**
 * blameController — blame for the line under the cursor: a note at the end of the line
 * (`Ada Lovelace, 3 days ago · Fix login retry`), a hover on that note with the full message and
 * actions (Open Commit, Compare with Previous, Compare with Working Tree), and the same author/age
 * in the status bar.
 *
 * Cost model (the "lightweight" budget):
 *   - One `git blame --incremental` per file VERSION: the editor's text is passed on stdin
 *     (`--contents -`), so unsaved edits are blamed correctly, and the result is cached against the
 *     document's version number. Moving the cursor re-reads the cache; it runs no git.
 *   - Blame waits for the cursor to settle (CURSOR_SETTLE_MS) and for typing to stop
 *     (EDIT_SETTLE_MS); while typing, the note is hidden because line numbers are shifting.
 *   - The full commit message for the hover is fetched once per commit, only when the cursor
 *     rests on one of its lines.
 *   - A git change (commit, checkout, …) in any repo clears the cache; the next render re-blames.
 *   - Files outside git, untracked files, very large files and non-file documents are skipped.
 *
 * Settings: `branchCompare.blame.currentLine` (end-of-line note + hover) and
 * `branchCompare.blame.statusBar`, both on by default. With both off, nothing runs.
 *
 * Failures are logged at WARN and the note is simply not shown; blame never shows a popup.
 */
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { GitCli } from '../git/gitCli';
import type { BlameLine } from '../git/parsers';
import type { Logger } from '../logger';
import { openCommitChanges } from '../views/commitDiff';
import { sideToUri } from '../views/content';
import { BLAME_COMMANDS, blameAnnotation, blameHoverMarkdown, blameStatusText, blameTarget, type BlameTarget } from './blameText';

// Waits before blaming: long enough that holding an arrow key does not blame every line passed,
// short enough to feel immediate when the cursor stops.
const CURSOR_SETTLE_MS = 150;
const EDIT_SETTLE_MS = 600;
// Larger files are skipped: blame cost grows with history × lines, and the note is least useful
// in generated files, which are the usual large ones.
const MAX_BLAME_LINES = 20_000;

/** Which blame surfaces are on (settings). */
export interface BlameSettings {
  readonly currentLine: boolean;
  readonly statusBar: boolean;
}

/** One document's blame, valid for one version of its text. */
interface CachedBlame {
  readonly version: number;
  /** Worktree root and repo-relative path; undefined when the file is not in a git worktree. */
  readonly root?: string;
  readonly relativePath?: string;
  /** Undefined when git cannot blame the file (untracked, ignored). */
  readonly lines?: readonly BlameLine[];
}

/** Drives the end-of-line note, its hover, and the status bar item. */
export class BlameController implements vscode.Disposable {
  private readonly decoration = vscode.window.createTextEditorDecorationType({
    after: { color: new vscode.ThemeColor('editorCodeLens.foreground'), fontStyle: 'italic', margin: '0 0 0 3em' },
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedOpen,
  });
  private readonly statusItem = vscode.window.createStatusBarItem('branchCompare.blame', vscode.StatusBarAlignment.Left, 98);
  private readonly cache = new Map<string, Promise<CachedBlame>>();
  // Worktree root per folder, so `rev-parse --show-toplevel` runs once per folder.
  private readonly roots = new Map<string, Promise<string | undefined>>();
  private readonly messages = new Map<string, string>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly subscriptions: vscode.Disposable[];

  constructor(
    private readonly getGit: () => Promise<GitCli>,
    private readonly settings: () => BlameSettings,
    private readonly logger: Logger,
  ) {
    this.statusItem.name = 'Blame';
    this.subscriptions = [
      this.decoration,
      this.statusItem,
      vscode.window.onDidChangeTextEditorSelection((event) => {
        if (event.textEditor === vscode.window.activeTextEditor) {
          this.schedule(CURSOR_SETTLE_MS);
        }
      }),
      vscode.window.onDidChangeActiveTextEditor(() => this.schedule(CURSOR_SETTLE_MS)),
      vscode.workspace.onDidChangeTextDocument((event) => {
        if (event.document === vscode.window.activeTextEditor?.document && event.contentChanges.length > 0) {
          // Lines are moving under the note; hide it until typing stops.
          this.clear();
          this.schedule(EDIT_SETTLE_MS);
        }
      }),
      vscode.workspace.onDidCloseTextDocument((document) => this.cache.delete(document.uri.toString())),
      ...this.registerCommands(),
    ];
    this.schedule(CURSOR_SETTLE_MS);
  }

  /** Git state changed somewhere (commit, checkout, …): forget every blame and re-render. */
  gitChanged(): void {
    this.cache.clear();
    this.schedule(CURSOR_SETTLE_MS);
  }

  /** Settings changed: re-render with the new surfaces (or clear them). */
  settingsChanged(): void {
    this.clear();
    this.schedule(0);
  }

  private schedule(delayMs: number): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => void this.render(), delayMs);
  }

  private async render(): Promise<void> {
    this.timer = undefined;
    const settings = this.settings();
    const editor = vscode.window.activeTextEditor;
    if ((!settings.currentLine && !settings.statusBar) || editor === undefined || !isBlameable(editor.document)) {
      this.clear();
      return;
    }
    const { document } = editor;
    const version = document.version;
    const lineIndex = editor.selection.active.line;
    let blame: CachedBlame;
    try {
      blame = await this.blameFor(document);
    } catch (error) {
      this.logger.warn('blame unavailable', { function: 'render', file: document.uri.fsPath, reason: error instanceof Error ? error.message : String(error) });
      this.clear();
      return;
    }
    // The user moved on while git ran: a newer render is scheduled or will be.
    if (vscode.window.activeTextEditor !== editor || document.version !== version || editor.selection.active.line !== lineIndex) {
      return;
    }
    const line = blame.lines?.[lineIndex];
    if (line === undefined || blame.root === undefined || blame.relativePath === undefined) {
      this.clear();
      return;
    }
    const target = blameTarget(blame.root, blame.relativePath, line);
    this.show(editor, lineIndex, line, target, settings);
    if (!line.commit.uncommitted && settings.currentLine && !this.messages.has(line.commit.sha)) {
      void this.loadMessage(blame.root, line.commit.sha, editor, lineIndex, line, target);
    }
  }

  private show(editor: vscode.TextEditor, lineIndex: number, line: BlameLine, target: BlameTarget, settings: BlameSettings): void {
    const now = Date.now();
    if (settings.currentLine) {
      const end = editor.document.lineAt(lineIndex).range.end;
      const hover = new vscode.MarkdownString(blameHoverMarkdown(line, target, this.messages.get(line.commit.sha), now), true);
      // Only our own commands may run from the hover's links.
      hover.isTrusted = { enabledCommands: Object.values(BLAME_COMMANDS) };
      editor.setDecorations(this.decoration, [{ range: new vscode.Range(end, end), hoverMessage: hover, renderOptions: { after: { contentText: blameAnnotation(line, now) } } }]);
    } else {
      editor.setDecorations(this.decoration, []);
    }
    if (settings.statusBar) {
      this.statusItem.text = `$(git-commit) ${blameStatusText(line, now)}`;
      this.statusItem.tooltip = line.commit.uncommitted ? 'This line is not committed yet.' : `${line.commit.summary}\n\nClick to open the commit.`;
      this.statusItem.command = line.commit.uncommitted ? undefined : { command: BLAME_COMMANDS.openCommit, title: 'Open Commit', arguments: [target] };
      this.statusItem.show();
    } else {
      this.statusItem.hide();
    }
  }

  // Upgrades the hover from the subject to the full message, once per commit.
  private async loadMessage(root: string, sha: string, editor: vscode.TextEditor, lineIndex: number, line: BlameLine, target: BlameTarget): Promise<void> {
    try {
      this.messages.set(sha, await (await this.getGit()).commitMessage(root, sha));
    } catch (error) {
      // The subject already shown is a fine fallback; remember the failure so it is not retried.
      this.logger.warn('commit message unavailable for blame hover', { function: 'loadMessage', root, sha, reason: error instanceof Error ? error.message : String(error) });
      this.messages.set(sha, line.commit.summary);
    }
    if (vscode.window.activeTextEditor === editor && editor.selection.active.line === lineIndex) {
      this.show(editor, lineIndex, line, target, this.settings());
    }
  }

  private clear(): void {
    for (const editor of vscode.window.visibleTextEditors) {
      editor.setDecorations(this.decoration, []);
    }
    this.statusItem.hide();
  }

  // One blame per document version; concurrent renders share the pending promise.
  private blameFor(document: vscode.TextDocument): Promise<CachedBlame> {
    const key = document.uri.toString();
    const cached = this.cache.get(key);
    if (cached !== undefined) {
      return cached.then((blame) => (blame.version === document.version ? blame : this.refresh(document)));
    }
    return this.refresh(document);
  }

  private refresh(document: vscode.TextDocument): Promise<CachedBlame> {
    const key = document.uri.toString();
    const pending = this.computeBlame(document);
    this.cache.set(key, pending);
    // A failure is not cached: the next render retries.
    pending.catch(() => this.cache.delete(key));
    return pending;
  }

  private async computeBlame(document: vscode.TextDocument): Promise<CachedBlame> {
    const version = document.version;
    const filePath = document.uri.fsPath;
    const root = await this.rootFor(path.dirname(filePath));
    if (root === undefined) {
      return { version };
    }
    const relativePath = path.relative(root, filePath).split(path.sep).join('/');
    const startedAt = Date.now();
    const lines = await (await this.getGit()).blame(root, relativePath, document.getText());
    this.logger.debug('file blamed', { function: 'computeBlame', root, relativePath, version, lineCount: lines?.length, durationMs: Date.now() - startedAt });
    return { version, root, relativePath, lines };
  }

  private rootFor(directory: string): Promise<string | undefined> {
    let pending = this.roots.get(directory);
    if (pending === undefined) {
      pending = this.getGit().then((git) => git.toplevel(directory));
      pending.catch(() => this.roots.delete(directory));
      this.roots.set(directory, pending);
    }
    return pending;
  }

  private registerCommands(): vscode.Disposable[] {
    const guarded = (id: string, run: (target: BlameTarget) => Promise<void>) =>
      vscode.commands.registerCommand(id, async (target: BlameTarget) => {
        try {
          await run(target);
        } catch (error) {
          this.logger.error('blame action failed', error, { function: 'registerCommands', command: id, target });
          void vscode.window.showErrorMessage(`Git Branch & Worktree Compare: ${error instanceof Error ? error.message : String(error)}`);
        }
      });
    return [
      guarded(BLAME_COMMANDS.openCommit, (target) => this.openCommit(target)),
      guarded(BLAME_COMMANDS.compareWithPrevious, (target) => this.compareWithPrevious(target)),
      guarded(BLAME_COMMANDS.compareWithWorkingTree, (target) => this.compareWithWorkingTree(target)),
    ];
  }

  private async openCommit(target: BlameTarget): Promise<void> {
    const git = await this.getGit();
    const commit = await git.commit(target.root, target.sha);
    if (commit === undefined) {
      void vscode.window.showInformationMessage(`Commit ${target.sha.slice(0, 7)} is no longer in this repository.`);
      return;
    }
    await openCommitChanges(git, { name: path.basename(target.root), root: target.root, commonDir: '' }, target.root, commit, this.logger);
  }

  // This file just before the commit vs at the commit: what the commit did to it.
  private async compareWithPrevious(target: BlameTarget): Promise<void> {
    if (target.previous === undefined) {
      void vscode.window.showInformationMessage('This commit added the file: there is no earlier version.');
      return;
    }
    const left = sideToUri({ kind: 'revision', cwd: target.root, revision: target.previous.sha, path: target.previous.path }, target.previous.path);
    const right = sideToUri({ kind: 'revision', cwd: target.root, revision: target.sha, path: target.pathAtCommit }, target.pathAtCommit);
    await vscode.commands.executeCommand('vscode.diff', left, right, `${path.posix.basename(target.path)} (${target.previous.sha.slice(0, 7)} ↔ ${target.sha.slice(0, 7)})`);
  }

  // The file at the commit vs the file as it is now (editable).
  private async compareWithWorkingTree(target: BlameTarget): Promise<void> {
    const left = sideToUri({ kind: 'revision', cwd: target.root, revision: target.sha, path: target.pathAtCommit }, target.pathAtCommit);
    const right = vscode.Uri.file(path.join(target.root, target.path));
    await vscode.commands.executeCommand('vscode.diff', left, right, `${path.posix.basename(target.path)} (${target.sha.slice(0, 7)} ↔ working tree)`);
  }

  dispose(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
    }
    for (const subscription of this.subscriptions) {
      subscription.dispose();
    }
  }
}

// Only real files on disk: our own `branch-compare:` documents (historical versions), diff
// editors' git views and untitled buffers have no working-tree file to blame.
function isBlameable(document: vscode.TextDocument): boolean {
  return document.uri.scheme === 'file' && !document.isUntitled && document.lineCount <= MAX_BLAME_LINES;
}
