/**
 * baseStore — remembers the "comparison base" the user set per repository.
 *
 * Why: the one-click compare button should use the repo's default branch unless the user chose
 * something else via "Set as Comparison Base"; that choice should survive a window reload. It is
 * stored in the workspace's Memento (per workspace, not synced), keyed by the repo's `.git` common
 * dir so it applies to every worktree of that repo.
 *
 * Persisted data is validated on read (`isBaseSpec`): a value written by an older version of this
 * extension, or hand-edited state, is ignored rather than crashing the view.
 *
 * Pure apart from the injected Memento-like store; unit-tested in test/baseStore.test.ts.
 */
import type { BaseSpec } from './comparison';

const STORAGE_KEY = 'gitComparePlus.basesByRepo';

/** The subset of `vscode.Memento` used here. */
export interface KeyValueStore {
  get(key: string): unknown;
  update(key: string, value: unknown): Thenable<void>;
}

/** Per-repo comparison base, persisted in workspace state. */
export class BaseStore {
  constructor(private readonly store: KeyValueStore) {}

  /** The base set for a repo, or `undefined` when the repo uses its default branch. */
  get(commonDir: string): BaseSpec | undefined {
    const value = this.all()[commonDir];
    return isBaseSpec(value) ? value : undefined;
  }

  /** Set the base for a repo. Setting `{ kind: 'default' }` is equivalent to `clear`. */
  async set(commonDir: string, base: BaseSpec): Promise<void> {
    if (base.kind === 'default') {
      return this.clear(commonDir);
    }
    await this.store.update(STORAGE_KEY, { ...this.all(), [commonDir]: base });
  }

  /** Forget a repo's base so it goes back to the default branch. */
  async clear(commonDir: string): Promise<void> {
    const { [commonDir]: _removed, ...rest } = this.all();
    await this.store.update(STORAGE_KEY, rest);
  }

  private all(): Record<string, unknown> {
    const value = this.store.get(STORAGE_KEY);
    return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
  }
}

/** Runtime check for a persisted `BaseSpec`. */
export function isBaseSpec(value: unknown): value is BaseSpec {
  if (typeof value !== 'object' || value === null || !('kind' in value)) {
    return false;
  }
  switch (value.kind) {
    case 'default':
      return true;
    case 'ref':
      return (
        'ref' in value && typeof value.ref === 'string' &&
        (!('refKind' in value) || value.refKind === undefined || isRefKind(value.refKind)) &&
        (!('label' in value) || value.label === undefined || typeof value.label === 'string')
      );
    case 'worktree':
      return (
        'root' in value && typeof value.root === 'string' &&
        'label' in value && typeof value.label === 'string' &&
        'includeUncommitted' in value && typeof value.includeUncommitted === 'boolean'
      );
    default:
      return false;
  }
}

function isRefKind(value: unknown): boolean {
  return value === 'branch' || value === 'remote' || value === 'tag' || value === 'commit';
}

/** True when `base` points at this worktree (by path) or this branch (by name). */
export function baseMatches(base: BaseSpec | undefined, target: { worktreeRoot?: string; ref?: string }): boolean {
  if (base === undefined) {
    return false;
  }
  return (base.kind === 'worktree' && base.root === target.worktreeRoot) || (base.kind === 'ref' && base.ref === target.ref);
}

/** Short label for a base, used in tree descriptions and quick picks. */
export function baseLabel(base: BaseSpec): string {
  switch (base.kind) {
    case 'default':
      return 'default branch';
    case 'ref':
      return base.label ?? base.ref;
    case 'worktree':
      return `${base.label} (worktree${base.includeUncommitted ? ' + uncommitted' : ', committed'})`;
  }
}
