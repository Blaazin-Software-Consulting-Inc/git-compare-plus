/**
 * sideChoices — the choices offered when picking a side of a comparison: "What do you want to
 * review?" and "Compare it with…".
 *
 * Both pickers list the same groups in the same order, so a user learns one layout:
 *
 *   Suggested       (Against only) the repo's default branch, and its default "Against" if set
 *   This window     worktrees open in this editor window
 *   Worktrees       the repo's other worktrees
 *   Branches        local branches
 *   Remote branches
 *   Tags
 *   Commits         one entry that opens a searchable list of recent commits
 *
 * Anything else (a SHA, `HEAD~3`, a branch typed by name) is accepted as typed text by the picker.
 *
 * When picking "Against", the side already chosen for "Reviewing" is left out, so a comparison
 * of something with itself cannot be picked.
 *
 * Pure (no `vscode` import); unit-tested in test/sideChoices.test.ts. extension.ts renders the
 * choices as a quick pick and turns the picked value into a Subject or BaseSpec.
 */
import { baseLabel } from './baseStore';
import type { BaseSpec, RefKind, Subject } from './comparison';
import type { RefEntry, TagEntry, WorktreeEntry } from './git/parsers';
import { formatAge } from './operations';
import { displayPath, isOneOf, samePath } from './paths';

/** Which question the picker answers. */
export type SideRole = 'review' | 'against';

/** Section of the picker; rendered as a separator with `SIDE_GROUP_TITLES`. */
export type SideGroup = 'suggested' | 'window' | 'worktrees' | 'branches' | 'remotes' | 'tags' | 'commits';

/** Separator titles, in display order. */
export const SIDE_GROUP_TITLES: Readonly<Record<SideGroup, string>> = {
  suggested: 'Suggested',
  window: 'This window',
  worktrees: 'Worktrees',
  branches: 'Branches',
  remotes: 'Remote branches',
  tags: 'Tags',
  commits: 'Commits',
};

/** What picking a choice means; extension.ts converts it to a Subject or BaseSpec. */
export type SideValue =
  | { readonly kind: 'default' }
  | { readonly kind: 'stored'; readonly base: BaseSpec }
  | { readonly kind: 'worktree'; readonly worktree: WorktreeEntry }
  // refKind is undefined for text the user typed (it could be a branch, tag or SHA).
  | { readonly kind: 'ref'; readonly ref: string; readonly label: string; readonly refKind?: RefKind }
  | { readonly kind: 'searchCommits' };

/** One picker entry. `icon` is a codicon name. */
export interface SideChoice {
  readonly group: SideGroup;
  readonly icon: string;
  readonly label: string;
  readonly description?: string;
  readonly value: SideValue;
}

/** Everything the choices are built from; all lists already in display order (treeOrder.ts). */
export interface SideChoiceInputs {
  readonly role: SideRole;
  readonly repoRoot: string;
  /** Usable worktrees (no bare or stale entries), main first. */
  readonly worktrees: readonly WorktreeEntry[];
  readonly refs: readonly RefEntry[];
  readonly tags: readonly TagEntry[];
  /** Folders open in this editor window (workspace folders), to find "This window" worktrees. */
  readonly windowFolders: readonly string[];
  /** Resolved default branch name, for the Suggested entry's description. */
  readonly defaultBranch?: string;
  /** The repo's saved default "Against", if one is set (Against only). */
  readonly storedBase?: BaseSpec;
  /** The side already picked for Reviewing; left out of the Against choices. */
  readonly reviewing?: Subject;
  readonly nowMs: number;
}

/** Build the choices for one picker, grouped and ordered (see module doc). */
export function sideChoices(inputs: SideChoiceInputs): SideChoice[] {
  const choices: SideChoice[] = [
    ...(inputs.role === 'against' ? suggestedChoices(inputs) : []),
    ...worktreeChoices(inputs),
    ...refChoices(inputs),
    ...inputs.tags.map((tag): SideChoice => ({
      group: 'tags',
      icon: 'tag',
      label: tag.name,
      description: tag.createdAt === undefined ? undefined : formatAge(tag.createdAt, inputs.nowMs),
      value: { kind: 'ref', ref: tag.name, label: tag.name, refKind: 'tag' },
    })),
    {
      group: 'commits',
      icon: 'search',
      label: 'Search commits…',
      description: 'by message, author or ID',
      value: { kind: 'searchCommits' },
    },
  ];
  return choices.filter((choice) => !isReviewing(choice.value, inputs.reviewing));
}

/**
 * The choice to highlight when the picker opens: the default branch for "Against", the first
 * worktree in this window for "Review". Index into `choices`, or 0 when nothing fits.
 */
export function preselectedIndex(choices: readonly SideChoice[], role: SideRole): number {
  const index = choices.findIndex((c) => (role === 'against' ? c.value.kind === 'default' : c.group === 'window'));
  return index < 0 ? 0 : index;
}

function suggestedChoices(inputs: SideChoiceInputs): SideChoice[] {
  const defaultChoice: SideChoice = {
    group: 'suggested',
    icon: 'star-full',
    label: 'Default branch',
    description: inputs.defaultBranch ?? 'not found',
    value: { kind: 'default' },
  };
  if (inputs.storedBase === undefined) {
    return [defaultChoice];
  }
  return [
    { group: 'suggested', icon: 'target', label: "This repo's default Against", description: baseLabel(inputs.storedBase), value: { kind: 'stored', base: inputs.storedBase } },
    defaultChoice,
  ];
}

// Worktrees open in this window come first: in a single-repo window, that is almost always the
// one being reviewed.
function worktreeChoices(inputs: SideChoiceInputs): SideChoice[] {
  return inputs.worktrees.map((worktree): SideChoice => {
    const inWindow = isOneOf(worktree.path, inputs.windowFolders);
    const where = samePath(worktree.path, inputs.repoRoot) ? 'repo folder' : displayPath(inputs.repoRoot, worktree.path);
    return {
      group: inWindow ? 'window' : 'worktrees',
      icon: inWindow ? 'window' : 'folder',
      label: worktree.branch ?? `detached @ ${(worktree.head ?? '').slice(0, 7)}`,
      description: `worktree · ${where}`,
      value: { kind: 'worktree', worktree },
    };
  }).sort((a, b) => groupRank(a.group) - groupRank(b.group));
}

function refChoices(inputs: SideChoiceInputs): SideChoice[] {
  return [...inputs.refs]
    .sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'local' ? -1 : 1))
    .map((ref): SideChoice => ({
      group: ref.kind === 'local' ? 'branches' : 'remotes',
      icon: ref.kind === 'local' ? 'git-branch' : 'cloud',
      label: ref.name,
      description: ref.committedAt === undefined ? undefined : formatAge(ref.committedAt, inputs.nowMs),
      value: { kind: 'ref', ref: ref.name, label: ref.name, refKind: ref.kind === 'local' ? 'branch' : 'remote' },
    }));
}

// Same worktree (by path) or same ref (by name) as the side already being reviewed.
function isReviewing(value: SideValue, reviewing: Subject | undefined): boolean {
  if (reviewing === undefined) {
    return false;
  }
  if (value.kind === 'worktree') {
    return reviewing.kind === 'worktree' && samePath(value.worktree.path, reviewing.root);
  }
  return value.kind === 'ref' && reviewing.kind === 'ref' && value.ref === reviewing.ref;
}

function groupRank(group: SideGroup): number {
  return Object.keys(SIDE_GROUP_TITLES).indexOf(group);
}
