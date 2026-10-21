/**
 * fileTree — groups a comparison's changed files into folders for the Changes view's tree layout.
 *
 * Folder chains with a single child folder and no files are compacted into one node
 * (`src/views/` rather than `src` → `views`), as the Source Control view does, so a deep path
 * does not cost one click per level. Within a folder, subfolders come first, then files, each by
 * name, matching the Explorer.
 *
 * Pure (no `vscode` import); unit-tested in test/fileTree.test.ts. O(n · depth) over the files.
 */
import type { ChangedFile } from '../git/parsers';

/** A folder in the tree. */
export interface FolderNode {
  /** Repo-relative folder path, POSIX, no trailing slash (`src/views`). Unique per tree. */
  readonly path: string;
  /** Label: the compacted segment(s) below the parent (`views`, or `src/views` when compacted). */
  readonly name: string;
  readonly folders: readonly FolderNode[];
  readonly files: readonly ChangedFile[];
}

// Mutable while building; frozen into FolderNode by `compact`.
interface Draft {
  readonly folders: Map<string, Draft>;
  readonly files: ChangedFile[];
}

/** Build the folder tree. Files at the repo root are the root's `files`; its `path` is ''. */
export function buildFileTree(files: readonly ChangedFile[]): FolderNode {
  const root: Draft = { folders: new Map(), files: [] };
  for (const file of files) {
    const segments = file.path.split('/');
    segments.pop();
    let folder = root;
    for (const segment of segments) {
      let child = folder.folders.get(segment);
      if (child === undefined) {
        child = { folders: new Map(), files: [] };
        folder.folders.set(segment, child);
      }
      folder = child;
    }
    folder.files.push(file);
  }
  return freeze(root, '', '');
}

function freeze(draft: Draft, path: string, name: string): FolderNode {
  const folders = [...draft.folders.entries()]
    .sort(([a], [b]) => compareNames(a, b))
    .map(([segment, child]) => compact(child, path === '' ? segment : `${path}/${segment}`, segment));
  const files = [...draft.files].sort((a, b) => compareNames(baseName(a.path), baseName(b.path)));
  return { path, name, folders, files };
}

// Merge a folder that holds exactly one folder and no files into that child, repeatedly.
function compact(draft: Draft, path: string, name: string): FolderNode {
  let current = draft;
  let currentPath = path;
  let currentName = name;
  while (current.files.length === 0 && current.folders.size === 1) {
    const [segment, only] = [...current.folders.entries()][0] ?? [];
    if (segment === undefined || only === undefined) {
      break;
    }
    current = only;
    currentPath = `${currentPath}/${segment}`;
    currentName = `${currentName}/${segment}`;
  }
  return freeze(current, currentPath, currentName);
}

/** Every file under a folder, depth first; used for folder totals. */
export function filesUnder(folder: FolderNode): ChangedFile[] {
  return [...folder.files, ...folder.folders.flatMap(filesUnder)];
}

function baseName(filePath: string): string {
  return filePath.slice(filePath.lastIndexOf('/') + 1);
}

// Case-insensitive first so `README` and `readme.md` sit together, then exact for stability.
function compareNames(a: string, b: string): number {
  const folded = a.toLowerCase().localeCompare(b.toLowerCase());
  return folded !== 0 ? folded : a < b ? -1 : a > b ? 1 : 0;
}
