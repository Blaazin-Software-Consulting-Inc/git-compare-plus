/**
 * revertCommand — "Revert to Against…" on files in Changes (`gitComparePlus.revertToAgainst`):
 * puts the selected files on disk back to the left side of their diff. The plan and its wording
 * are in revertToAgainst.ts; this module runs it.
 *
 * Order: plan → refuse if any target has unsaved edits in an editor → confirm (modal, naming every
 * file and every uncommitted edit lost) → restore with git → move added files to the Trash →
 * re-run the comparison. A failure in one repo is logged at ERROR there and reported; other repos
 * still run, since their files are independent.
 *
 * Why refuse unsaved editors: writing under an editor with unsaved edits makes VS Code ask, on the
 * next save, whether to overwrite the reverted file, and "Overwrite" silently undoes the revert.
 *
 * See also: src/git/gitCli.ts (restoreFromRevision), src/gitActions.ts (the same inspect → confirm
 * → act pattern for the Repositories view's actions).
 */
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { ComparisonResult } from './comparison';
import type { GitCli } from './git/gitCli';
import type { ChangedFile } from './git/parsers';
import type { Logger } from './logger';
import { planRevert, revertConfirmation, type RevertPlan } from './revertToAgainst';
import type { ChangesNode } from './views/changesView';

/** Collaborators for the command. */
export interface RevertDeps {
  getGit(): Promise<GitCli>;
  /** Recompute the comparison on display, so reverted files drop out of Changes. */
  rerun(): Promise<void>;
  readonly logger: Logger;
}

/**
 * Revert the clicked file, or every selected file when the click is part of a multi-selection.
 * Folder, header and commit rows in the selection are ignored. Resolves after the comparison is
 * re-run; rejects only if that re-run fails (revert failures are reported, not thrown).
 * @param node - the row the menu was opened on.
 * @param selection - every selected row, as VS Code passes it with a multi-selection.
 */
export async function revertToAgainst(deps: RevertDeps, node: ChangesNode | undefined, selection: readonly ChangesNode[] | undefined): Promise<void> {
  const byResult = selectedFiles(node, selection);
  if (byResult.size === 0) {
    return;
  }
  const plans: RevertPlan[] = [];
  for (const [result, files] of byResult) {
    const plan = planRevert(result, files);
    if ('reason' in plan) {
      void vscode.window.showInformationMessage(plan.reason);
      return;
    }
    plans.push(plan);
  }
  const unsaved = unsavedTargets(plans);
  if (unsaved.length > 0) {
    void vscode.window.showWarningMessage(`Save or discard the unsaved edits in ${unsaved.join(', ')} first: reverting would conflict with them.`);
    return;
  }
  const text = revertConfirmation(plans);
  if ((await vscode.window.showWarningMessage(text.title, { modal: true, detail: text.detail }, text.confirm)) !== text.confirm) {
    return;
  }
  const failures: string[] = [];
  for (const plan of plans) {
    const failure = await runPlan(deps, plan);
    if (failure !== undefined) {
      failures.push(failure);
    }
  }
  if (failures.length > 0) {
    void vscode.window.showWarningMessage('Some files could not be reverted', { modal: false, detail: failures.join('\n') });
  }
  await deps.rerun();
}

/**
 * Restore, then trash, for one repo. Restoring first: if git refuses, nothing has been removed.
 * @returns a line for the failure report, or undefined on success. Failures are logged here, at the
 *   site that has the paths and revision.
 */
async function runPlan(deps: RevertDeps, plan: RevertPlan): Promise<string | undefined> {
  const context = { function: 'runPlan', repo: plan.result.repo.name, root: plan.root, revision: plan.revision, restore: plan.restore, remove: plan.remove };
  if (plan.restore.length > 0) {
    try {
      await (await deps.getGit()).restoreFromRevision(plan.root, plan.revision, plan.restore);
    } catch (error) {
      deps.logger.error('revert restore failed', error, context);
      return `${plan.result.repo.name}: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
  const notTrashed: string[] = [];
  for (const file of plan.remove) {
    try {
      await vscode.workspace.fs.delete(vscode.Uri.file(path.join(plan.root, file)), { useTrash: true, recursive: false });
    } catch (error) {
      deps.logger.error('revert trash failed', error, { ...context, file });
      notTrashed.push(file);
    }
  }
  deps.logger.info('files reverted to against side', { ...context, losesUncommitted: plan.losesUncommitted, notTrashed });
  return notTrashed.length > 0 ? `${plan.result.repo.name}: could not move to the Trash: ${notTrashed.join(', ')}` : undefined;
}

// The selected file rows grouped by comparison. VS Code passes the multi-selection only when the
// clicked row is part of it; otherwise the clicked row alone is meant.
function selectedFiles(node: ChangesNode | undefined, selection: readonly ChangesNode[] | undefined): Map<ComparisonResult, ChangedFile[]> {
  const rows = selection !== undefined && node !== undefined && selection.includes(node) ? selection : node !== undefined ? [node] : [];
  const byResult = new Map<ComparisonResult, ChangedFile[]>();
  for (const row of rows) {
    if (row.kind === 'file') {
      byResult.set(row.result, [...(byResult.get(row.result) ?? []), row.file]);
    }
  }
  return byResult;
}

// Targets open in an editor with unsaved edits, by repo-relative path.
function unsavedTargets(plans: readonly RevertPlan[]): string[] {
  const dirty = new Set(vscode.workspace.textDocuments.filter((d) => d.isDirty && d.uri.scheme === 'file').map((d) => d.uri.fsPath));
  return plans.flatMap((plan) => [...plan.restore, ...plan.remove].filter((file) => dirty.has(vscode.Uri.file(path.join(plan.root, file)).fsPath)));
}
