// 服务器端的笔记库：数据目录下每篇笔记一个 `.md` 文件，规则和浏览器端的 vault.ts 一致。

import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { noteFileName } from "../core/fileName";

/** 版本号取文件内容的哈希，外部改动（手动拷入、git 恢复）也会被识别为版本变化。 */
export function versionOf(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export interface NoteEntry {
  name: string;
  lastModified: number;
}

/** 列出目录顶层的所有 `.md` 文件，最近修改的排在前面。 */
export async function listNotes(dir: string): Promise<NoteEntry[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const notes: NoteEntry[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".md")) continue;
    const stat = await fs.stat(path.join(dir, entry.name));
    notes.push({ name: entry.name, lastModified: stat.mtimeMs });
  }
  return notes.sort((a, b) => b.lastModified - a.lastModified);
}

/** 读取笔记全文；文件不存在时返回 undefined。 */
export async function readNote(dir: string, name: string): Promise<string | undefined> {
  try {
    return await fs.readFile(path.join(dir, name), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/** 新建一篇笔记，文件名由标题生成，重名时加 `-2` 等后缀。 */
export async function createNote(dir: string, title: string, text: string): Promise<{ name: string; version: string }> {
  const name = noteFileName(title, await fs.readdir(dir));
  await fs.writeFile(path.join(dir, name), text, "utf8");
  return { name, version: versionOf(text) };
}

/**
 * 写回一篇笔记。给了新标题且文件名变化时，在同一次操作里完成重命名（规则和原来一样）；
 * 只差大小写时直接写回原文件：在不区分大小写的文件系统上新旧是同一个文件，先建后删会把它删掉。
 * 文件不存在时返回 undefined。
 */
export async function writeNote(
  dir: string,
  name: string,
  text: string,
  title?: string,
): Promise<{ name: string; version: string } | undefined> {
  if ((await readNote(dir, name)) === undefined) return undefined;
  if (title !== undefined) {
    const others = (await fs.readdir(dir)).filter((entry) => entry !== name);
    const renamed = noteFileName(title, others);
    if (renamed.toLowerCase() !== name.toLowerCase()) {
      await fs.writeFile(path.join(dir, renamed), text, "utf8");
      await fs.rm(path.join(dir, name));
      return { name: renamed, version: versionOf(text) };
    }
  }
  await fs.writeFile(path.join(dir, name), text, "utf8");
  return { name, version: versionOf(text) };
}

/** 删除一篇笔记；文件不存在时返回 false。 */
export async function deleteNote(dir: string, name: string): Promise<boolean> {
  try {
    await fs.rm(path.join(dir, name));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
