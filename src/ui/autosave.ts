// 自动保存：笔记变化后防抖约 1 秒写回文件。
//
// 所有写入排成一个队列依次执行，打开文件前可以等队列清空，避免读到写了一半的旧内容。
// 切换笔记、页面隐藏时立即写入还没写的改动；关闭页面时如果还有没写完的改动，浏览器会提示。

import { useCallback, useEffect, useRef, useState } from "react";
import { serializeNote } from "../core/format";
import type { Note } from "../core/note";
import { writeNote } from "./vault";

const DEBOUNCE_MS = 1000;

export type SaveStatus = { kind: "saved" } | { kind: "pending" } | { kind: "error"; message: string };

let queue: Promise<void> = Promise.resolve();
let unfinishedWrites = 0;

/** 等到目前排队的所有写入都完成。 */
export function whenSaved(): Promise<void> {
  return queue;
}

export function useAutosave(handle: FileSystemFileHandle | null) {
  const [status, setStatus] = useState<SaveStatus>({ kind: "saved" });
  const scheduleRef = useRef<(text: string) => void>(() => {});

  useEffect(() => {
    if (!handle) return;
    const target = handle;
    let pending: string | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const isClean = () => pending === null && unfinishedWrites === 0;

    function flush() {
      clearTimeout(timer);
      if (pending === null) return;
      const text = pending;
      pending = null;
      unfinishedWrites++;
      queue = queue
        .then(() => writeNote(target, text))
        .then(
          () => {
            unfinishedWrites--;
            if (isClean()) setStatus({ kind: "saved" });
          },
          (e: unknown) => {
            unfinishedWrites--;
            setStatus({ kind: "error", message: String(e) });
          },
        );
    }

    scheduleRef.current = (text) => {
      pending = text;
      setStatus({ kind: "pending" });
      clearTimeout(timer);
      timer = setTimeout(flush, DEBOUNCE_MS);
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
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("beforeunload", onBeforeUnload);
    };
  }, [handle]);

  const schedule = useCallback((note: Note) => scheduleRef.current(serializeNote(note)), []);
  return { status, schedule };
}
