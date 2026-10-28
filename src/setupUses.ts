/**
 * setupUses — whether the comparison on display involves a branch or worktree that is being
 * deleted, on either side.
 *
 * Why: deleting the branch or worktree Changes is showing left the view re-running a comparison
 * that can only fail ("claude/x no longer exists") on every git change, until another comparison
 * replaced it. gitActions.ts clears Changes instead when this says the deleted item is in use.
 *
 * Pure; unit-tested in test/setupUses.test.ts.
 */
import type { BaseSpec, Subject } from './comparison';
import { samePath } from './paths';
import type { ComparisonSetup } from './views/changesHeader';

/** What is being deleted: a local branch by name, or a worktree by folder. */
export type DeletedItem = { readonly kind: 'branch'; readonly name: string } | { readonly kind: 'worktree'; readonly root: string };

/** True when `item` is the Reviewing side of any request, or the Against side. */
export function setupUses(setup: ComparisonSetup, item: DeletedItem): boolean {
  return setup.requests.some((request) => sideIs(request.subject, item)) || sideIs(setup.base, item);
}

function sideIs(side: Subject | BaseSpec, item: DeletedItem): boolean {
  if (item.kind === 'branch') {
    // Remote branches are not deleted here; a ref named like the branch is that local branch.
    return side.kind === 'ref' && side.refKind !== 'remote' && side.refKind !== 'tag' && side.ref === item.name;
  }
  return side.kind === 'worktree' && samePath(side.root, item.root);
}
