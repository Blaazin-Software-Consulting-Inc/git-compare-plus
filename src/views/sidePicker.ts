/**
 * sidePicker — renders the side choices (sideChoices.ts) as a quick pick, with a separator per
 * group, the suggested choice highlighted, and typed text accepted as a ref.
 *
 * "Search commits…" opens a second list of recent commits that filters as you type by message,
 * author or ID; a full or partial SHA that matches nothing is still accepted as typed.
 */
import * as vscode from 'vscode';
import type { CommitEntry } from '../git/parsers';
import { formatAge } from '../operations';
import { SIDE_GROUP_TITLES, preselectedIndex, type SideChoice, type SideRole, type SideValue } from '../sideChoices';
import { commitTitle } from './commitText';

interface ValueItem extends vscode.QuickPickItem {
  readonly value?: SideValue;
}

/**
 * Ask for one side.
 * @param recentCommits - loads the commits for "Search commits…" (only called if picked).
 * @returns the picked value, or undefined if the picker was dismissed.
 */
export async function pickSide(
  choices: readonly SideChoice[],
  role: SideRole,
  title: string,
  recentCommits: () => Promise<readonly CommitEntry[]>,
): Promise<SideValue | undefined> {
  const items = withSeparators(choices);
  const preselected = choices[preselectedIndex(choices, role)];
  const picked = await pickWithTypedRef(items, {
    title,
    placeholder: 'Pick a worktree, branch, tag or commit, or type any branch, tag or commit ID',
    active: items.find((item) => item.value !== undefined && item.value === preselected?.value),
  });
  if (picked?.kind !== 'searchCommits') {
    return picked;
  }
  const commits = await recentCommits();
  const now = Date.now();
  const commitItems: ValueItem[] = commits.map((commit) => ({
    label: `$(git-commit) ${commit.subject}`,
    description: `${commit.sha.slice(0, 7)} · ${commit.author} · ${formatAge(commit.authoredAt, now)}`,
    value: { kind: 'ref', ref: commit.sha, label: commitTitle(commit), refKind: 'commit' },
  }));
  return pickWithTypedRef(commitItems, { title: `${title} (commit)`, placeholder: 'Type to filter by message, author or ID, or paste any commit ID' });
}

function withSeparators(choices: readonly SideChoice[]): ValueItem[] {
  const items: ValueItem[] = [];
  let group: string | undefined;
  for (const choice of choices) {
    if (choice.group !== group) {
      group = choice.group;
      items.push({ label: SIDE_GROUP_TITLES[choice.group], kind: vscode.QuickPickItemKind.Separator });
    }
    items.push({ label: `$(${choice.icon}) ${choice.label}`, description: choice.description, value: choice.value });
  }
  return items;
}

// Enter on text that matches no item uses the text itself as a ref (tag, SHA, HEAD~3, …).
function pickWithTypedRef(items: readonly ValueItem[], options: { title: string; placeholder: string; active?: ValueItem }): Promise<SideValue | undefined> {
  const quickPick = vscode.window.createQuickPick<ValueItem>();
  quickPick.title = options.title;
  quickPick.placeholder = options.placeholder;
  quickPick.matchOnDescription = true;
  quickPick.items = items;
  if (options.active !== undefined) {
    quickPick.activeItems = [options.active];
  }
  return new Promise<SideValue | undefined>((resolve) => {
    let settled = false;
    quickPick.onDidAccept(() => {
      settled = true;
      const typed = quickPick.value.trim();
      const selected = quickPick.selectedItems[0]?.value;
      resolve(selected ?? (typed.length > 0 ? { kind: 'ref', ref: typed, label: typed } : undefined));
      quickPick.hide();
    });
    quickPick.onDidHide(() => {
      if (!settled) {
        resolve(undefined);
      }
      quickPick.dispose();
    });
    quickPick.show();
  });
}
