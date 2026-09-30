// 笔记库：通过 File System Access API 读写用户授权的本地文件夹。

export interface NoteFile {
  name: string;
  handle: FileSystemFileHandle;
  lastModified: number;
}

export function isFileSystemAccessSupported(): boolean {
  return "showDirectoryPicker" in window;
}

export async function pickVault(): Promise<FileSystemDirectoryHandle> {
  return window.showDirectoryPicker({ id: "tree-note-vault", mode: "readwrite" });
}

/** 列出文件夹顶层的所有 `.md` 文件，最近修改的排在前面。 */
export async function listNotes(dir: FileSystemDirectoryHandle): Promise<NoteFile[]> {
  const notes: NoteFile[] = [];
  for await (const entry of dir.values()) {
    if (entry.kind !== "file" || !entry.name.toLowerCase().endsWith(".md")) continue;
    const file = await entry.getFile();
    notes.push({ name: entry.name, handle: entry, lastModified: file.lastModified });
  }
  return notes.sort((a, b) => b.lastModified - a.lastModified);
}

export async function readNote(file: NoteFile): Promise<string> {
  return (await file.handle.getFile()).text();
}
