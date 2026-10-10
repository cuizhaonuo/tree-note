// 自动保存接到浏览器上：每打开一篇笔记建一个 SaveSession（逻辑见 saveSession.ts），
// 网络请求用服务器接口，暂存用 localStorage。
//
// 切换笔记、页面隐藏时立即写入还没写的改动；页面要关闭时把还没写完的改动暂存下来，下次打开这篇笔记时恢复。
// 网络恢复（online 事件）时立即重试，不等退避。

import { useEffect } from "react";
import { readNote, writeNote } from "./api";
import { SaveSession, discardStash, migrateStashes, type OpenedFile, type SaveDeps, type SaveEvents } from "./saveSession";

export type { SaveStatus } from "./saveSession";

/** 当前登录用户；setCurrentUser 设置之前为 null（此时不能开始自动保存）。 */
let currentUser: string | null = null;

/**
 * 设置当前登录用户。登录前的暂存属于占位用户 "local"：把它们改到当前用户名下，
 * 登录前没保存上的内容不会在登录后丢掉。
 */
export function setCurrentUser(username: string): void {
  try {
    migrateStashes(localStorage, "local", username);
  } catch {
    // localStorage 不可用时不迁移，和存储 shim 一样当作没有暂存。
  }
  currentUser = username;
}

function requireUser(): string {
  if (currentUser === null) throw new Error("startSaving 之前必须先 setCurrentUser（登录成功后调用）");
  return currentUser;
}

/** localStorage 不可用（比如被浏览器禁用）时当作没有暂存，不影响正常保存。 */
const storage: SaveDeps["storage"] = {
  getItem(key) {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  setItem(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch {
      // 存不下就算了，自动重试仍在进行。
    }
  },
  removeItem(key) {
    try {
      localStorage.removeItem(key);
    } catch {
      // 同上。
    }
  },
};

const deps: SaveDeps = {
  write: writeNote,
  read: readNote,
  storage,
  get user() {
    return requireUser();
  },
};

/** 还没结束的会话，以及结束了但还在写最后一次的会话。 */
const sessions = new Set<SaveSession>();

/**
 * 开始自动保存一篇刚打开的笔记。`fresh` 表示笔记是刚新建的：同名的旧暂存（之前删掉的同名笔记留下的）不能恢复进来。
 * 有暂存时 `session.restored` 是要显示的内容。
 */
export function startSaving(file: OpenedFile, events: SaveEvents, fresh = false): SaveSession {
  if (fresh) discardStash(storage, requireUser(), file.name);
  const session = new SaveSession(file, deps, events);
  sessions.add(session);
  return session;
}

/** 切换到别的笔记：写完手上的改动后不再管它。`discard` 用于笔记要被删除时。 */
export function stopSaving(session: SaveSession, how: "close" | "discard" = "close"): void {
  if (how === "discard") session.discard();
  else session.close();
  session.settled().then(() => sessions.delete(session));
}

/** 不是打开着的笔记被删除时，清掉它可能留下的暂存。 */
export function forgetStash(name: string): void {
  discardStash(storage, requireUser(), name);
}

/** 等到正在进行的写入都完成（不等待断网重试）。 */
export async function whenSaved(): Promise<void> {
  await Promise.all([...sessions].map((s) => s.settled()));
}

/** 立即写入所有还在防抖的改动，并等这些写入完成。 */
export async function flushSaves(): Promise<void> {
  for (const session of sessions) session.flush();
  await whenSaved();
}

/** 把打开着的笔记的自动保存接到页面事件上。 */
export function usePageEvents(session: SaveSession | null): void {
  useEffect(() => {
    if (!session) return;
    const saving = session;
    // 页面要关闭，或者隐藏的标签页可能被浏览器直接回收：先暂存再写，写成功后暂存会自动清除。
    function onPageHide() {
      saving.stashUnsaved();
      saving.flush();
    }
    function onVisibilityChange() {
      if (document.visibilityState === "hidden") onPageHide();
    }
    function onOnline() {
      saving.flush();
    }
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("pagehide", onPageHide);
    window.addEventListener("online", onOnline);
    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("pagehide", onPageHide);
      window.removeEventListener("online", onOnline);
    };
  }, [session]);
}
