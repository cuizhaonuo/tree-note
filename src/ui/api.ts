// 笔记库客户端：通过服务器接口列出、读取、新建、写回（含重命名）、删除、搜索笔记。
// 笔记用文件名标识；写回时带上基于的版本号，版本不一致服务器返回 409，这里抛出 ConflictError。
// 其他非 2xx 抛出带状态码的 HttpError；网络错误原样抛出 fetch 的异常。

import type { SearchHit } from "../core/search";
import type { Role, UserStatus } from "../server/accounts";

/** 登录后的当前用户。 */
export interface AuthUser {
  username: string;
  role: Role;
}

/** 全局 401 处理器：除登录接口外，任何接口返回 401（未登录/账号被禁用）时调用。 */
let unauthorizedHandler: ((message: string) => void) | null = null;

/** 注册（或传 null 清除）全局 401 处理器；同时只保留一个。 */
export function onUnauthorized(cb: ((message: string) => void) | null): void {
  unauthorizedHandler = cb;
}

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
    if (response.status === 401 && url !== "/api/login" && unauthorizedHandler) {
      unauthorizedHandler(message);
    }
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

// ---------- 登录/账号 ----------

/** 当前登录用户；未登录时抛出 401 HttpError（并触发全局 401 处理器）。 */
export function me(): Promise<AuthUser> {
  return request<AuthUser>("/api/me");
}

/** 登录；失败时抛出带服务器消息的 401 HttpError（不触发全局 401 处理器）。 */
export function login(username: string, password: string): Promise<AuthUser> {
  return request<AuthUser>("/api/login", putJson({ method: "POST" }, { username, password }));
}

export async function logout(): Promise<void> {
  await request<{ ok: boolean }>("/api/logout", { method: "POST" });
}

/** 修改当前用户密码。 */
export async function changePassword(oldPassword: string, newPassword: string): Promise<void> {
  await request<{ ok: boolean }>("/api/password", putJson({ method: "POST" }, { oldPassword, newPassword }));
}

// ---------- 管理（仅管理员） ----------

/** 管理员看到的用户行：笔记只有数量和占用字节数，没有内容。 */
export interface AdminUser {
  username: string;
  role: Role;
  status: UserStatus;
  createdAt: number;
  lastLoginAt: number | null;
  noteCount: number;
  diskBytes: number;
}

function adminUserUrl(username: string, suffix = ""): string {
  return `/api/admin/users/${encodeURIComponent(username)}${suffix}`;
}

export function adminListUsers(): Promise<AdminUser[]> {
  return request<AdminUser[]>("/api/admin/users");
}

/** 新建用户；用户名重复（不区分大小写）时服务器返回 409，抛出带中文消息的 HttpError。 */
export function adminCreateUser(username: string, password: string, role: Role): Promise<AdminUser> {
  return request<AdminUser>("/api/admin/users", putJson({ method: "POST" }, { username, password, role }));
}

/** 重置某用户密码；服务器同时注销该用户的全部会话。 */
export async function adminResetPassword(username: string, password: string): Promise<void> {
  await request<{ ok: boolean }>(adminUserUrl(username, "/password"), putJson({ method: "POST" }, { password }));
}

/** 启用/禁用某用户；禁用时服务器注销该用户的全部会话。 */
export async function adminSetStatus(username: string, status: UserStatus): Promise<void> {
  await request<{ ok: boolean }>(adminUserUrl(username, "/status"), putJson({ method: "POST" }, { status }));
}

/** 修改某用户角色；不能改自己的角色（服务器返回 400）。 */
export async function adminSetRole(username: string, role: Role): Promise<void> {
  await request<{ ok: boolean }>(adminUserUrl(username, "/role"), putJson({ method: "POST" }, { role }));
}
