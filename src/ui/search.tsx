// 侧栏的全文搜索：输入关键词后在笔记库所有笔记里搜索，结果代替笔记列表显示。
//
// 打开着的笔记用内存里的内容搜索（自动保存可能还没写到文件），其他笔记从文件读。
// 读之前先等排队的写入和改名完成。

import { useEffect, useState } from "react";
import { parseNote } from "../core/format";
import type { Note } from "../core/note";
import { searchNotes, type SearchableNote, type SearchHit } from "../core/search";
import { whenSaved } from "./autosave";
import { listNotes, readNote, type NoteFile } from "./vault";

/** 输入停顿这么久之后才搜索。 */
const DEBOUNCE_MS = 150;
/** 最多显示的结果数。 */
const MAX_SHOWN = 200;

export type SearchResult =
  | { status: "searching" }
  | { status: "done"; hits: SearchHit[]; files: NoteFile[] }
  | { status: "error"; message: string };

/** 查询为空时返回 null。`openNote` 返回打开着的笔记的文件名和内存里的内容。 */
export function useVaultSearch(
  vault: FileSystemDirectoryHandle | null,
  query: string,
  openNote: () => { file: string; note: Note } | null,
): SearchResult | null {
  const [result, setResult] = useState<SearchResult | null>(null);
  const blank = query.trim() === "";

  useEffect(() => {
    if (!vault || blank) {
      setResult(null);
      return;
    }
    setResult((r) => r ?? { status: "searching" });
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        await whenSaved();
        const files = await listNotes(vault);
        const open = openNote();
        const notes = await Promise.all(
          files.map(async (file): Promise<SearchableNote | null> => {
            if (open && file.name === open.file) return open;
            // 读不了或格式有误的笔记跳过，打开它时会看到原因。
            try {
              const parsed = parseNote(await readNote(file));
              return parsed.ok ? { file: file.name, note: parsed.note } : null;
            } catch {
              return null;
            }
          }),
        );
        const hits = searchNotes(notes.filter((n) => n !== null), query);
        if (!cancelled) setResult({ status: "done", hits, files });
      } catch (e) {
        if (!cancelled) setResult({ status: "error", message: `搜索失败：${String(e)}` });
      }
    }, DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // openNote 每次渲染都是新函数，只在搜索时调用，不应该触发重新搜索。
  }, [vault, query, blank]);

  return result;
}

export function SearchResults({
  result,
  onOpen,
}: {
  result: SearchResult;
  onOpen: (file: NoteFile, hit: SearchHit) => void;
}) {
  if (result.status === "searching") return <div className="empty">搜索中…</div>;
  if (result.status === "error") return <div className="error">{result.message}</div>;
  const { hits, files } = result;
  if (hits.length === 0) return <div className="empty">没有找到</div>;
  return (
    <>
      <div className="search-count">
        {hits.length} 条结果{hits.length > MAX_SHOWN && `，只显示前 ${MAX_SHOWN} 条`}
      </div>
      <ul className="note-list search-hits">
        {hits.slice(0, MAX_SHOWN).map((hit) => {
          const file = files.find((f) => f.name === hit.file);
          return (
            <li key={`${hit.file}:${hit.inTitle ? "title" : hit.path.join(".")}`}>
              <button disabled={!file} onClick={() => file && onOpen(file, hit)}>
                <span className="hit-head">
                  <span className="note-name">{hit.inTitle ? <Highlighted hit={hit} /> : hit.title}</span>
                  <time className="note-date" dateTime={hit.time.replace(" ", "T")}>
                    {hit.time}
                  </time>
                </span>
                {!hit.inTitle && (
                  <span className="hit-snippet">
                    <Highlighted hit={hit} />
                  </span>
                )}
              </button>
            </li>
          );
        })}
      </ul>
    </>
  );
}

function Highlighted({ hit }: { hit: SearchHit }) {
  return (
    <>
      {hit.snippet.map((part, i) => (part.match ? <mark key={i}>{part.text}</mark> : part.text))}
    </>
  );
}
