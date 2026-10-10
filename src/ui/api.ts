// 笔记库客户端：通过服务器接口列出、读取、新建、写回（含重命名）、删除、搜索笔记。
// 笔记用文件名标识；写回时带上基于的版本号，版本不一致服务器返回 409，这里抛出 ConflictError。
// 其他非 2xx 抛出带状态码的 HttpError；网络错误原样抛出 fetch 的异常。

import type { SearchHit } from "../core/search";

export interface NoteEntry {
  name: string;
  lastModified: number;
}

/** 一篇笔记的一次修订：文件名加上基于内容的版本号，写回时用它做乐观并发控制。 */
export interface NoteVersion {
  name: string;
  version: string;
}

/** 服务器返回了非 2xx 的状态码。网络错误（请求根本没到服务器）不是 HttpError。 */
export class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** 版本冲突（服务器返回 409）：这篇笔记在别处被修改过，不能覆盖。 */
export class ConflictError extends HttpError {
  constructor(message: string) {
    super(message, 409);
  }
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) {
    let message = `请求失败（${response.status}）`;
    try {
      const body: unknown = await response.json();
      if (typeof body === "object" && body !== null && "error" in body && typeof body.error === "string") {
        message = body.error;
      }
    } catch {
      // 响应不是 JSON，用默认消息。
    }
    if (response.status === 409) throw new ConflictError(message);
    throw new HttpError(message, response.status);
  }
  return (await response.json()) as T;
}

function noteUrl(name: string): string {
  return `/api/notes/${encodeURIComponent(name)}`;
}

function putJson(init: RequestInit, body: unknown): RequestInit {
  return { ...init, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}

/** 列出全部笔记，最近修改的排在前面。 */
export async function listNotes(): Promise<NoteEntry[]> {
  return (await request<{ notes: NoteEntry[] }>("/api/notes")).notes;
}

export function readNote(name: string): Promise<NoteVersion & { text: string }> {
  return request(noteUrl(name));
}

/** 新建一篇笔记；文件名由标题生成，重名时服务器自动加后缀。 */
export function createNote(title: string, text: string): Promise<NoteVersion> {
  return request("/api/notes", putJson({ method: "POST" }, { title, text }));
}

/** 写回一篇笔记；`title` 变化时服务器在同一次操作里完成重命名，返回新名字和新版本号。 */
export function writeNote(name: string, text: string, version: string, title?: string): Promise<NoteVersion> {
  return request(noteUrl(name), putJson({ method: "PUT" }, title === undefined ? { text, version } : { text, version, title }));
}

export async function deleteNote(name: string): Promise<void> {
  await request<{ ok: boolean }>(noteUrl(name), { method: "DELETE" });
}

export async function searchNotes(query: string): Promise<SearchHit[]> {
  return (await request<{ hits: SearchHit[] }>(`/api/search?q=${encodeURIComponent(query)}`)).hits;
}
