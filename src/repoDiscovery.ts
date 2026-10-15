/**
 * repoDiscovery — finds the git repositories shown in the Repositories view.
 *
 * Sources, in order:
 *   1. The built-in git extension (`vscode.git`, API v1), which already scans the workspace and
 *      respects the user's `git.*` scanning settings. It also supplies the git binary path, so
 *      this extension and the editor run the same git.
 *   2. Fallback: workspace folders themselves, for when the git extension found nothing (e.g.
 *      `git.autoRepositoryDetection: false`). Folders that are not repos are dropped quietly.
 *
 * Each root is then probed with git (common dir + main worktree) and folded by repos.ts so linked
 * worktrees collapse under their repository.
 *
 * Only the few git-extension members used here are declared: the extension ships no npm typings,
 * and vendoring its full `git.d.ts` would be noise. Verified against Cursor 3.24 / VS Code 1.128.
 */
import * as vscode from 'vscode';
import type { RepoInfo } from './comparison';
import type { GitCli } from './git/gitCli';
import type { Logger } from './logger';
import { groupRepos, type RepoProbe } from './repos';

/** The members of the git extension's `Repository` this extension reads. */
interface GitRepository {
  readonly rootUri: vscode.Uri;
}

/** The members of the git extension's `API` (v1) this extension uses. */
export interface GitApi {
  readonly state: 'uninitialized' | 'initialized';
  readonly onDidChangeState: vscode.Event<'uninitialized' | 'initialized'>;
  readonly repositories: readonly GitRepository[];
  readonly git: { readonly path: string };
}

interface GitExtensionExports {
  readonly enabled: boolean;
  getAPI(version: 1): GitApi;
}

/**
 * Get the git extension API once it has finished its initial workspace scan.
 *
 * @throws Error when the git extension is missing or disabled (`git.enabled: false`); callers
 *   surface the message to the user.
 */
export async function getGitApi(): Promise<GitApi> {
  const extension = vscode.extensions.getExtension<GitExtensionExports>('vscode.git');
  if (extension === undefined) {
    throw new Error('The built-in Git extension (vscode.git) is not installed.');
  }
  const exports = extension.isActive ? extension.exports : await extension.activate();
  if (!exports.enabled) {
    throw new Error('The built-in Git extension is disabled (setting "git.enabled").');
  }
  const api = exports.getAPI(1);
  // Right after window load the API exists but has not scanned the workspace yet; reading
  // `repositories` then would report an empty workspace.
  if (api.state !== 'initialized') {
    await new Promise<void>((resolve) => {
      const subscription = api.onDidChangeState((state) => {
        if (state === 'initialized') {
          subscription.dispose();
          resolve();
        }
      });
    });
  }
  return api;
}

/**
 * Discover repositories, one per real repo, in workspace-folder order.
 * @returns possibly empty; never rejects for an individual root that cannot be probed.
 */
export async function discoverRepos(api: GitApi, git: GitCli, logger: Logger): Promise<RepoInfo[]> {
  const fromGitExtension = sortByWorkspaceOrder(api.repositories.map((r) => r.rootUri)).map((u) => u.fsPath);
  const candidateRoots =
    fromGitExtension.length > 0 ? fromGitExtension : (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);

  const probes = await Promise.all(candidateRoots.map((root) => probeRoot(git, root, logger)));
  const repos = groupRepos(probes.filter((p): p is RepoProbe => p !== undefined));

  logger.info('repositories discovered', {
    function: 'discoverRepos',
    source: fromGitExtension.length > 0 ? 'git-extension' : 'workspace-folders',
    candidateRoots,
    repos: repos.map((r) => ({ name: r.name, root: r.root })),
  });
  return repos;
}

async function probeRoot(git: GitCli, root: string, logger: Logger): Promise<RepoProbe | undefined> {
  try {
    const [commonDir, worktrees] = await Promise.all([git.commonDir(root), git.worktrees(root)]);
    // A bare main entry has no files to diff; fall back to the discovered root in that case.
    const main = worktrees[0];
    return { root, commonDir, mainWorktree: main !== undefined && !main.bare ? main.path : undefined };
  } catch (error) {
    // Expected for a workspace folder that is not a git repo (fallback path). Skipping it keeps
    // the rest of the view working.
    logger.debug('root skipped: not a git repository', {
      function: 'probeRoot',
      root,
      reason: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}

function sortByWorkspaceOrder(uris: readonly vscode.Uri[]): vscode.Uri[] {
  const folderIndex = (uri: vscode.Uri): number => vscode.workspace.getWorkspaceFolder(uri)?.index ?? Number.MAX_SAFE_INTEGER;
  return [...uris].sort((a, b) => folderIndex(a) - folderIndex(b) || a.fsPath.localeCompare(b.fsPath));
}
