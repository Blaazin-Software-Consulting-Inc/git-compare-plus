import { describe, expect, it } from 'vitest';
import type { ChangedFile } from '../src/git/parsers';
import { buildFileTree, filesUnder, type FolderNode } from '../src/views/fileTree';

const file = (path: string): ChangedFile => ({ status: 'modified', path, oldPath: path });

// Compact text rendering: folders end with '/', indentation by depth.
function render(folder: FolderNode, depth = 0): string[] {
  const pad = '  '.repeat(depth);
  return [
    ...folder.folders.flatMap((child) => [`${pad}${child.name}/ (${child.path})`, ...render(child, depth + 1)]),
    ...folder.files.map((f) => `${pad}${f.path.slice(f.path.lastIndexOf('/') + 1)}`),
  ];
}

describe('buildFileTree', () => {
  it('groups by folder, folders before files, names case-insensitively sorted', () => {
    const tree = buildFileTree([file('src/b.ts'), file('README.md'), file('src/A.ts'), file('src/views/x.ts'), file('a.txt'), file('docs/z.md')]);
    expect(render(tree)).toEqual([
      'docs/ (docs)',
      '  z.md',
      'src/ (src)',
      '  views/ (src/views)',
      '    x.ts',
      '  A.ts',
      '  b.ts',
      'a.txt',
      'README.md',
    ]);
  });

  it('compacts chains of single-child folders into one node with the full path', () => {
    const tree = buildFileTree([file('packages/core/src/index.ts'), file('packages/core/src/util/fmt.ts')]);
    expect(render(tree)).toEqual(['packages/core/src/ (packages/core/src)', '  util/ (packages/core/src/util)', '    fmt.ts', '  index.ts']);
  });

  it('does not compact a folder that holds files of its own', () => {
    const tree = buildFileTree([file('a/top.ts'), file('a/b/deep.ts')]);
    expect(render(tree)).toEqual(['a/ (a)', '  b/ (a/b)', '    deep.ts', '  top.ts']);
  });

  it('keeps root files at the root and handles an empty list', () => {
    expect(render(buildFileTree([file('only.ts')]))).toEqual(['only.ts']);
    expect(buildFileTree([])).toEqual({ path: '', name: '', folders: [], files: [] });
  });

  it('filesUnder collects every file below a folder', () => {
    const tree = buildFileTree([file('a/1.ts'), file('a/b/2.ts'), file('c.ts')]);
    expect(filesUnder(tree).map((f) => f.path).sort()).toEqual(['a/1.ts', 'a/b/2.ts', 'c.ts']);
    expect(filesUnder(tree.folders[0] as FolderNode).map((f) => f.path).sort()).toEqual(['a/1.ts', 'a/b/2.ts']);
  });
});
