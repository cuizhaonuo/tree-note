// 侧栏的全文搜索：输入关键词后调用服务器接口在所有笔记里搜索，结果代替笔记列表显示。
// Enter 打开第一条结果，Esc 清空。
//
// 搜索前先把还在防抖的改动立即写入并等队列清空，打开着的笔记的最新内容服务器也能看到。

import { useEffect, useState, type ReactNode } from "react";
import type { SearchHit } from "../core/search";
import { searchNotes } from "./api";
import { flushSaves } from "./autosave";

/** 输入停顿这么久之后才搜索。 */
const DEBOUNCE_MS = 150;
/** 最多显示的结果数。 */
const MAX_SHOWN = 200;

type SearchResult =
  | { status: "searching" }
  /** `query` 是得出这些结果的查询；新的查询还在搜索时，旧结果照样显示。 */
  | { status: "done"; query: string; hits: SearchHit[] }
  | { status: "error"; message: string };

interface NoteSearchProps {
  onOpen: (name: string, hit: SearchHit) => void;
  /** 没有在搜索时显示的内容（笔记列表）。 */
  children: ReactNode;
}

export function NoteSearch({ onOpen, children }: NoteSearchProps) {
  const [query, setQuery] = useState("");
  const result = useNoteSearch(query);

  function open(hit: SearchHit) {
    onOpen(hit.file, hit);
  }

  return (
    <>
      <input
        className="search-input"
        type="search"
        aria-label="搜索所有笔记"
        placeholder="搜索所有笔记"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing || e.keyCode === 229) return;
          if (e.key === "Escape") {
            e.preventDefault();
            setQuery("");
            e.currentTarget.blur();
          } else if (e.key === "Enter") {
            e.preventDefault();
            // 只打开当前查询的结果，不打开上一次查询留下的。
            if (result?.status === "done" && result.query === query && result.hits.length > 0) open(result.hits[0]);
          }
        }}
      />
      {result ? <SearchResults result={result} onOpen={open} /> : children}
    </>
  );
}

/** 查询为空时返回 null。 */
function useNoteSearch(query: string): SearchResult | null {
  const [result, setResult] = useState<SearchResult | null>(null);
  const blank = query.trim() === "";

  useEffect(() => {
    if (blank) {
      setResult(null);
      return;
    }
    setResult((r) => r ?? { status: "searching" });
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        await flushSaves();
        const hits = await searchNotes(query);
        if (!cancelled) setResult({ status: "done", query, hits });
      } catch (e) {
        if (!cancelled) setResult({ status: "error", message: `搜索失败：${String(e)}` });
      }
    }, DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query, blank]);

  return result;
}

function SearchResults({ result, onOpen }: { result: SearchResult; onOpen: (hit: SearchHit) => void }) {
  if (result.status === "searching") return <div className="empty">搜索中…</div>;
  if (result.status === "error") return <div className="error">{result.message}</div>;
  const { hits } = result;
  if (hits.length === 0) return <div className="empty">没有找到</div>;
  return (
    <>
      <div className="search-count">
        {hits.length} 条结果{hits.length > MAX_SHOWN && `，只显示前 ${MAX_SHOWN} 条`}
      </div>
      <ul className="note-list search-hits">
        {hits.slice(0, MAX_SHOWN).map((hit) => {
          return (
            <li key={`${hit.file}:${hit.inTitle ? "title" : hit.path.join(".")}`}>
              <button onClick={() => onOpen(hit)}>
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
