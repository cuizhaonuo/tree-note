// 笔记库：通过 File System Access API 读写用户授权的本地文件夹。

import { noteFileName } from "../core/fileName";

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

export async function writeNote(handle: FileSystemFileHandle, text: string): Promise<void> {
  const writable = await handle.createWritable();
  await writable.write(text);
  await writable.close();
}

/** 在文件夹里新建一篇笔记，文件名由标题生成，重名时加后缀。 */
export async function createNoteFile(dir: FileSystemDirectoryHandle, title: string, text: string): Promise<NoteFile> {
  const existing: string[] = [];
  for await (const name of dir.keys()) existing.push(name);
  const name = noteFileName(title, existing);
  const handle = await dir.getFileHandle(name, { create: true });
  await writeNote(handle, text);
  return { name, handle, lastModified: (await handle.getFile()).lastModified };
}
