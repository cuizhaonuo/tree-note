// 自动保存：笔记变化后防抖约 1 秒通过服务器接口写回。
//
// 所有写入排成一个队列依次执行，打开文件前可以等队列清空，避免读到写了一半的旧内容。
// 切换笔记、页面隐藏时立即写入还没写的改动；关闭页面时如果还有没写完的改动，浏览器会提示。
//
// 每次写入都带上基于的版本号，成功后换成服务器返回的新版本号。标题变化时（重命名或撤销重命名）
// 在同一次写入里带上新标题，服务器一并完成重命名并返回新文件名。
// 版本冲突（409）说明笔记在别处被改过：自动保存停止，不悄悄覆盖，界面提示刷新。

import { useCallback, useEffect, useRef, useState } from "react";
import { serializeNote } from "../core/format";
import type { Note } from "../core/note";
import { ConflictError, writeNote } from "./api";

const DEBOUNCE_MS = 1000;

export type SaveStatus =
  | { kind: "saved" }
  | { kind: "saving" }
  | { kind: "pending" }
  | { kind: "conflict" }
  | { kind: "error"; message: string };

/** 打开的笔记写到哪个文件。重命名后这里换成新名字和新版本号：只有自动保存会修改这个对象。 */
export interface SaveTarget {
  name: string;
  /** 文件里现在的标题（包括已经排队、还没写完的改名）。 */
  title: string;
  version: string;
}

/** 重命名完成后调用，界面把打开着的笔记和列表里的名字换过来。 */
export type OnRenamed = (previousName: string, name: string) => void;

let queue: Promise<void> = Promise.resolve();
let unfinishedWrites = 0;
const pendingFlushes = new Set<() => void>();

/** 等到目前排队的所有写入都完成。 */
export function whenSaved(): Promise<void> {
  return queue;
}

/** 立即写入所有还在防抖的改动，并等全部写完。 */
export async function flushSaves(): Promise<void> {
  for (const flush of pendingFlushes) flush();
  await whenSaved();
}

/** `onSaved` 在所有写入完成后调用，界面可以借此刷新笔记列表的修改时间。 */
export function useAutosave(target: SaveTarget | null, onRenamed: OnRenamed, onSaved: () => void) {
  const [status, setStatus] = useState<SaveStatus>({ kind: "saved" });
  const scheduleRef = useRef<(note: Note) => void>(() => {});
  const discardRef = useRef<() => void>(() => {});
  const onRenamedRef = useRef(onRenamed);
  const onSavedRef = useRef(onSaved);
  onRenamedRef.current = onRenamed;
  onSavedRef.current = onSaved;

  useEffect(() => {
    if (!target) return;
    const saving = target;
    let pending: string | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // 冲突后停止：还没写的改动和之后的改动都不再写，等用户刷新。
    let stopped = false;
    const isClean = () => pending === null && unfinishedWrites === 0;

    function enqueue(write: () => Promise<void>) {
      unfinishedWrites++;
      queue = queue.then(async () => {
        if (stopped) {
          unfinishedWrites--;
          return;
        }
        setStatus({ kind: "saving" });
        try {
          await write();
        } catch (e) {
          if (e instanceof ConflictError) {
            stopped = true;
            pending = null;
            clearTimeout(timer);
            scheduleRef.current = () => {};
            setStatus({ kind: "conflict" });
            return;
          }
          throw e;
        } finally {
          unfinishedWrites--;
        }
        if (isClean()) {
          setStatus({ kind: "saved" });
          onSavedRef.current();
        }
      });
      // 非冲突的错误：记录状态，队列继续前进。
      queue = queue.catch((e: unknown) => setStatus({ kind: "error", message: String(e) }));
    }

    /** 写一次：带上当前的文件名和版本号（前排队的写入和改名可能已经换了它们），成功后记住新名字和新版本号。 */
    async function performWrite(text: string, title?: string) {
      const from = saving.name;
      const result = await writeNote(from, text, saving.version, title);
      saving.name = result.name;
      saving.version = result.version;
      if (result.name !== from) onRenamedRef.current(from, result.name);
    }

    function flush() {
      clearTimeout(timer);
      if (pending === null) return;
      const text = pending;
      pending = null;
      enqueue(() => performWrite(text));
    }

    scheduleRef.current = (note) => {
      const text = serializeNote(note);
      setStatus({ kind: "pending" });
      clearTimeout(timer);
      if (note.title !== saving.title) {
        // 改名时把最新的内容一起写进新文件，还没写的改动就不用单独写了。
        pending = null;
        const { title } = note;
        const previous = saving.title;
        saving.title = title;
        enqueue(async () => {
          try {
            await performWrite(text, title);
          } catch (e) {
            // 这之后又排了别的改名就不恢复，那次改名会再试。
            if (!(e instanceof ConflictError) && saving.title === title) saving.title = previous;
            throw e;
          }
        });
        return;
      }
      pending = text;
      timer = setTimeout(flush, DEBOUNCE_MS);
    };

    // 文件要被删除：丢掉还没写的改动，之后的改动也不再写。
    discardRef.current = () => {
      clearTimeout(timer);
      pending = null;
      stopped = true;
      scheduleRef.current = () => {};
    };

    function onVisibilityChange() {
      if (document.visibilityState === "hidden") flush();
    }
    function onBeforeUnload(e: BeforeUnloadEvent) {
      if (isClean()) return;
      flush();
      e.preventDefault();
    }
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("beforeunload", onBeforeUnload);
    pendingFlushes.add(flush);
    return () => {
      flush();
      pendingFlushes.delete(flush);
      scheduleRef.current = () => {};
      discardRef.current = () => {};
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("beforeunload", onBeforeUnload);
    };
  }, [target]);

  const schedule = useCallback((note: Note) => scheduleRef.current(note), []);
  const discard = useCallback(() => discardRef.current(), []);
  return { status, schedule, discard };
}
