/**
 * againstMode — which mode a comparison starts in, given the Against side the user chose.
 *
 * Why: "changes since branch point" (merge-base mode) is right for reviewing work against the
 * branch it will merge into: it is what a pull request shows. Between two worktrees or two feature
 * branches it is a trap. Both usually split off the default branch, so their branch point is a
 * commit on main, and the diff looks like "my worktree against main" although the header says
 * "Against: other-worktree". Comparing with another worktree or branch therefore starts with all
 * differences (direct mode):
 *
 *   Against                                          starts as
 *   the default branch, or the repo's default Against  the `compareMode` setting (PR-style by default)
 *   a worktree, local branch or remote branch          all differences
 *   a tag, commit or typed ref                         the `compareMode` setting
 *
 * The mode row in Changes still toggles either way; this only picks the starting point.
 *
 * Pure; unit-tested in test/againstMode.test.ts.
 */
import type { BaseSpec, CompareMode } from './comparison';

/**
 * The mode to start a comparison in (see module doc).
 * @param against - the Against side the user picked.
 * @param defaultAgainst - the repo's saved default Against, if set: a comparison with it is the
 *   one the repo is set up for, so it keeps the setting even when it is a branch or worktree.
 * @param settingMode - the `compareMode` setting.
 */
export function modeForAgainst(against: BaseSpec, defaultAgainst: BaseSpec | undefined, settingMode: CompareMode): CompareMode {
  if (against.kind === 'default' || (defaultAgainst !== undefined && sameBase(against, defaultAgainst))) {
    return settingMode;
  }
  if (against.kind === 'worktree') {
    return 'direct';
  }
  // A tag or commit is a fixed point, usually an ancestor: both modes show the same thing then.
  return against.refKind === 'branch' || against.refKind === 'remote' ? 'direct' : settingMode;
}

function sameBase(a: BaseSpec, b: BaseSpec): boolean {
  switch (a.kind) {
    case 'default':
      return b.kind === 'default';
    case 'ref':
      return b.kind === 'ref' && a.ref === b.ref;
    case 'worktree':
      return b.kind === 'worktree' && a.root === b.root;
  }
}
