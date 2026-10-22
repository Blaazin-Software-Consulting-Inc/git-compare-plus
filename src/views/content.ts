/**
 * content — turns `SideSource` descriptors (comparison.ts) into URIs the diff editor can open,
 * and serves the content of historical file versions.
 *
 * Scheme `branch-compare:` — read-only documents with the content of `<revision>:<path>` in a repo:
 *   path  = `/<repo-relative path>`; keeps the real file name so the tab title and language
 *           detection (syntax highlighting) work.
 *   query = `cwd=<worktree or repo root>&rev=<revision>`; `rev` empty means an empty document,
 *           used for the missing side of an addition or deletion. Optional `file=<path today>`
 *           lets the History view's ◀ ▶ buttons find the file's history from a renamed version.
 *
 * Why not the git extension's `git:` URIs: they only resolve for repositories the git extension has
 * open, and linked worktrees usually are not (see git/gitCli.ts).
 */
import * as vscode from 'vscode';
import type { SideSource } from '../comparison';
import type { GitCli } from '../git/gitCli';
import type { Logger } from '../logger';

export const CONTENT_SCHEME = 'branch-compare';

/** Map a side descriptor to an openable URI. `empty` becomes an empty read-only document. */
export function sideToUri(side: SideSource, fallbackPath: string): vscode.Uri {
  switch (side.kind) {
    case 'file':
      return vscode.Uri.file(side.absolutePath);
    case 'revision':
      return revisionUri(side.cwd, side.revision, side.path);
    case 'empty':
      return revisionUri('', '', fallbackPath);
  }
}

/**
 * URI of `<revision>:<path>` in the repo at `cwd`.
 * @param pathToday - the file's path today, when it differs (renames); used by history stepping.
 */
export function revisionUri(cwd: string, revision: string, repoRelativePath: string, pathToday?: string): vscode.Uri {
  return vscode.Uri.from({
    scheme: CONTENT_SCHEME,
    path: `/${repoRelativePath}`,
    query: new URLSearchParams({ cwd, rev: revision, ...(pathToday !== undefined ? { file: pathToday } : {}) }).toString(),
  });
}

/** The parts of a `branch-compare:` URI; undefined for other schemes or an empty side. */
export function parseRevisionUri(uri: vscode.Uri): { cwd: string; revision: string; path: string; pathToday: string } | undefined {
  if (uri.scheme !== CONTENT_SCHEME) {
    return undefined;
  }
  const params = new URLSearchParams(uri.query);
  const cwd = params.get('cwd') ?? '';
  const revision = params.get('rev') ?? '';
  if (cwd === '' || revision === '') {
    return undefined;
  }
  const filePath = uri.path.slice(1);
  return { cwd, revision, path: filePath, pathToday: params.get('file') ?? filePath };
}

/** Serves `branch-compare:` documents by running `git show <rev>:<path>`. */
export class RevisionContentProvider implements vscode.TextDocumentContentProvider {
  constructor(
    private readonly getGit: () => Promise<GitCli>,
    private readonly logger: Logger,
  ) {}

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const params = new URLSearchParams(uri.query);
    const cwd = params.get('cwd') ?? '';
    const revision = params.get('rev') ?? '';
    const filePath = uri.path.slice(1);
    // Empty side of an added/deleted file.
    if (revision === '') {
      return '';
    }
    try {
      return await (await this.getGit()).show(cwd, revision, filePath);
    } catch (error) {
      // Shown in place of the content so the diff still opens; e.g. the merge base was
      // garbage-collected after a force-push, or the file is a submodule entry.
      this.logger.error('revision content unavailable', error, { function: 'provideTextDocumentContent', cwd, revision, filePath });
      return `// Could not read ${filePath} at ${revision}: ${error instanceof Error ? error.message : String(error)}\n`;
    }
  }
}
