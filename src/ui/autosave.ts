// 自动保存：笔记变化后防抖约 1 秒写回文件。
//
// 所有写入排成一个队列依次执行，打开文件前可以等队列清空，避免读到写了一半的旧内容。
// 切换笔记、页面隐藏时立即写入还没写的改动；关闭页面时如果还有没写完的改动，浏览器会提示。
//
// 标题变化时（重命名或撤销重命名）不直接写，而是在队列里排一次“改名”：按新标题换一个文件。
// 改名前排队的写入写到旧文件，之后的写入写到新文件，所以写入时才去取当前的文件。

import { useCallback, useEffect, useRef, useState } from "react";
import { serializeNote } from "../core/format";
import type { Note } from "../core/note";
import { writeNote } from "./vault";

const DEBOUNCE_MS = 1000;

export type SaveStatus = { kind: "saved" } | { kind: "pending" } | { kind: "error"; message: string };

/** 打开的笔记写到哪个文件。改名后换成新文件，所以这个对象会被修改。 */
export interface SaveTarget {
  handle: FileSystemFileHandle;
  /** 文件里现在的标题（包括已经排队、还没写完的改名）。 */
  title: string;
}

/** 把 `text` 写到按 `title` 命名的文件里，并把 `target.handle` 换成那个文件。 */
export type Relocate = (target: SaveTarget, title: string, text: string) => Promise<void>;

let queue: Promise<void> = Promise.resolve();
let unfinishedWrites = 0;

/** 等到目前排队的所有写入都完成。 */
export function whenSaved(): Promise<void> {
  return queue;
}

/** `onSaved` 在所有写入完成后调用，界面可以借此刷新笔记列表的修改时间。 */
export function useAutosave(target: SaveTarget | null, relocate: Relocate, onSaved: () => void) {
  const [status, setStatus] = useState<SaveStatus>({ kind: "saved" });
  const scheduleRef = useRef<(note: Note) => void>(() => {});
  const discardRef = useRef<() => void>(() => {});
  const relocateRef = useRef(relocate);
  const onSavedRef = useRef(onSaved);
  relocateRef.current = relocate;
  onSavedRef.current = onSaved;

  useEffect(() => {
    if (!target) return;
    const file = target;
    let pending: string | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const isClean = () => pending === null && unfinishedWrites === 0;

    function enqueue(write: () => Promise<void>) {
      unfinishedWrites++;
      queue = queue.then(write).then(
        () => {
          unfinishedWrites--;
          if (isClean()) {
            setStatus({ kind: "saved" });
            onSavedRef.current();
          }
        },
        (e: unknown) => {
          unfinishedWrites--;
          setStatus({ kind: "error", message: String(e) });
        },
      );
    }

    function flush() {
      clearTimeout(timer);
      if (pending === null) return;
      const text = pending;
      pending = null;
      enqueue(() => writeNote(file.handle, text));
    }

    scheduleRef.current = (note) => {
      const text = serializeNote(note);
      setStatus({ kind: "pending" });
      clearTimeout(timer);
      if (note.title !== file.title) {
        // 改名时把最新的内容一起写进新文件，还没写的改动就不用单独写了。
        pending = null;
        file.title = note.title;
        enqueue(() => relocateRef.current(file, note.title, text));
        return;
      }
      pending = text;
      timer = setTimeout(flush, DEBOUNCE_MS);
    };

    // 文件要被删除：丢掉还没写的改动，之后的改动也不再写。
    discardRef.current = () => {
      clearTimeout(timer);
      pending = null;
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
    return () => {
      flush();
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
