// 侧栏的全文搜索：输入关键词后在笔记库所有笔记里搜索，结果代替笔记列表显示。
// Enter 打开第一条结果，Esc 清空。
//
// 打开着的笔记用内存里的内容搜索（自动保存可能还没写到文件），其他笔记从文件读。
// 读之前先等排队的写入和改名完成。

import { useEffect, useState, type ReactNode } from "react";
import { parseNote } from "../core/format";
import { searchNotes, type SearchableNote, type SearchHit } from "../core/search";
import { whenSaved } from "./autosave";
import { listNotes, readNote, type NoteFile } from "./vault";

/** 输入停顿这么久之后才搜索。 */
const DEBOUNCE_MS = 150;
/** 最多显示的结果数。 */
const MAX_SHOWN = 200;

type SearchResult =
  | { status: "searching" }
  /** `query` 是得出这些结果的查询；新的查询还在搜索时，旧结果照样显示。 */
  | { status: "done"; query: string; hits: SearchHit[]; files: NoteFile[] }
  | { status: "error"; message: string };

interface VaultSearchProps {
  vault: FileSystemDirectoryHandle;
  /** 打开着的笔记：文件名和内存里的内容。只在搜索时调用。 */
  openNote: () => SearchableNote | null;
  onOpen: (file: NoteFile, hit: SearchHit) => void;
  /** 没有在搜索时显示的内容（笔记列表）。 */
  children: ReactNode;
}

export function VaultSearch({ vault, openNote, onOpen, children }: VaultSearchProps) {
  const [query, setQuery] = useState("");
  const result = useVaultSearch(vault, query, openNote);

  function open(hit: SearchHit) {
    if (result?.status !== "done") return;
    const file = result.files.find((f) => f.name === hit.file);
    if (file) onOpen(file, hit);
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
function useVaultSearch(
  vault: FileSystemDirectoryHandle,
  query: string,
  openNote: () => SearchableNote | null,
): SearchResult | null {
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
        if (!cancelled) setResult({ status: "done", query, hits, files });
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
