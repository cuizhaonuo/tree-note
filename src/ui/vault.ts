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
  return writeNewFile(dir, noteFileName(title, await entryNames(dir)), text);
}

/**
 * 标题改了以后，把内容写到按新标题命名的文件里，再删掉旧文件；新名字和旧名字一样时直接写回。
 * 只差大小写时也直接写回旧文件：在不区分大小写的文件系统上新旧是同一个文件，先建后删会把它删掉。
 */
export async function renameNoteFile(
  dir: FileSystemDirectoryHandle,
  handle: FileSystemFileHandle,
  title: string,
  text: string,
): Promise<NoteFile> {
  const others = (await entryNames(dir)).filter((name) => name !== handle.name);
  const name = noteFileName(title, others);
  if (name.toLowerCase() === handle.name.toLowerCase()) {
    await writeNote(handle, text);
    return { name: handle.name, handle, lastModified: (await handle.getFile()).lastModified };
  }
  const file = await writeNewFile(dir, name, text);
  await dir.removeEntry(handle.name);
  return file;
}

export async function deleteNoteFile(dir: FileSystemDirectoryHandle, name: string): Promise<void> {
  await dir.removeEntry(name);
}

async function entryNames(dir: FileSystemDirectoryHandle): Promise<string[]> {
  const names: string[] = [];
  for await (const name of dir.keys()) names.push(name);
  return names;
}

async function writeNewFile(dir: FileSystemDirectoryHandle, name: string, text: string): Promise<NoteFile> {
  const handle = await dir.getFileHandle(name, { create: true });
  await writeNote(handle, text);
  return { name, handle, lastModified: (await handle.getFile()).lastModified };
}
