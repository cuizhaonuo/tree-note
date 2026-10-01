import { useEffect, useState, type FormEvent } from "react";
import { initialEditorState, newNoteState, type EditorState } from "../core/commands";
import { parseNote, serializeNote, type ParseError } from "../core/format";
import { formatNodeTime } from "../core/note";
import { useAutosave, whenSaved, type SaveStatus } from "./autosave";
import { TreeCanvas } from "./TreeCanvas";
import {
  createNoteFile,
  isFileSystemAccessSupported,
  listNotes,
  pickVault,
  readNote,
  type NoteFile,
} from "./vault";

type Opened =
  | { status: "none" }
  | { status: "ok"; file: NoteFile; state: EditorState }
  | { status: "error"; file: NoteFile; error: ParseError | string };

export function App() {
  const [vault, setVault] = useState<FileSystemDirectoryHandle | null>(null);
  const [files, setFiles] = useState<NoteFile[]>([]);
  const [opened, setOpened] = useState<Opened>({ status: "none" });
  const [vaultError, setVaultError] = useState<string | null>(null);
  const [askingTitle, setAskingTitle] = useState(false);
  const autosave = useAutosave(opened.status === "ok" ? opened.file.handle : null);

  // Ctrl+N 新建笔记。注意：普通的 Chrome 标签页里浏览器会抢先处理 Ctrl+N（打开新窗口），
  // 只有把页面安装成应用窗口时才收得到，所以侧栏里另有一个“新建笔记”按钮。
  useEffect(() => {
    if (!vault) return;
    function onKeyDown(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "n") {
        e.preventDefault();
        setAskingTitle(true);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [vault]);

  if (!isFileSystemAccessSupported()) {
    return (
      <div className="notice">
        当前浏览器不支持 File System Access API。请使用最新版的 Chrome 或 Edge 打开。
      </div>
    );
  }

  async function chooseVault() {
    try {
      const dir = await pickVault();
      setVault(dir);
      setFiles(await listNotes(dir));
      setOpened({ status: "none" });
      setVaultError(null);
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") return;
      setVaultError(`无法打开文件夹：${String(e)}`);
    }
  }

  async function createNote(title: string) {
    if (!vault) return;
    setAskingTitle(false);
    try {
      const state = newNoteState(title, formatNodeTime(new Date()));
      const file = await createNoteFile(vault, title, serializeNote(state.note));
      setFiles(await listNotes(vault));
      setOpened({ status: "ok", file, state });
      setVaultError(null);
    } catch (e) {
      setVaultError(`无法新建笔记：${String(e)}`);
    }
  }

  async function openFile(file: NoteFile) {
    try {
      // 先等之前的改动写完，否则可能读到旧内容。
      await whenSaved();
      const result = parseNote(await readNote(file));
      setOpened(
        result.ok
          ? { status: "ok", file, state: initialEditorState(result.note) }
          : { status: "error", file, error: result.error },
      );
    } catch (e) {
      setOpened({ status: "error", file, error: `无法读取文件：${String(e)}` });
    }
  }

  const openedName = opened.status === "none" ? null : opened.file.name;

  return (
    <div className="app">
      <aside className="sidebar">
        <button onClick={chooseVault}>{vault ? "更换笔记库" : "打开笔记库文件夹"}</button>
        {vault && <button onClick={() => setAskingTitle(true)}>新建笔记（Ctrl+N）</button>}
        {vault && <div className="vault-name">📁 {vault.name}</div>}
        {vaultError && <div className="error">{vaultError}</div>}
        {vault && files.length === 0 && <div className="empty">这个文件夹里还没有笔记</div>}
        <ul className="note-list">
          {files.map((file) => (
            <li key={file.name}>
              <button
                className={file.name === openedName ? "active" : undefined}
                onClick={() => openFile(file)}
              >
                <span className="note-name">{file.name.replace(/\.md$/i, "")}</span>
                <span className="note-date">{formatModified(file.lastModified)}</span>
              </button>
            </li>
          ))}
        </ul>
      </aside>
      <main className="main">
        {opened.status === "none" && (
          <div className="empty">{vault ? "从左侧选择一篇笔记" : "先授权一个本地文件夹作为笔记库"}</div>
        )}
        {opened.status === "error" && <ParseErrorView file={opened.file} error={opened.error} />}
        {opened.status === "ok" && (
          <>
            <SaveIndicator status={autosave.status} />
            <TreeCanvas key={opened.file.name} initialState={opened.state} onNoteChange={autosave.schedule} />
          </>
        )}
        {askingTitle && <TitlePrompt onConfirm={createNote} onCancel={() => setAskingTitle(false)} />}
      </main>
    </div>
  );
}

function TitlePrompt({ onConfirm, onCancel }: { onConfirm: (title: string) => void; onCancel: () => void }) {
  const [title, setTitle] = useState("");

  function submit(e: FormEvent) {
    e.preventDefault();
    const trimmed = title.trim();
    if (trimmed) onConfirm(trimmed);
  }

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <form className="dialog" onSubmit={submit}>
        <label htmlFor="new-note-title">新笔记的标题</label>
        <input
          id="new-note-title"
          autoFocus
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => e.key === "Escape" && onCancel()}
          placeholder="Enter 确认，Esc 取消"
        />
      </form>
    </div>
  );
}

function SaveIndicator({ status }: { status: SaveStatus }) {
  if (status.kind === "error") return <div className="save-status error">保存失败：{status.message}</div>;
  return <div className="save-status">{status.kind === "pending" ? "未保存…" : "已保存"}</div>;
}

function ParseErrorView({ file, error }: { file: NoteFile; error: ParseError | string }) {
  return (
    <div className="parse-error">
      <h2>无法打开 {file.name}</h2>
      <p>{typeof error === "string" ? error : `第 ${error.line} 行：${error.message}`}</p>
    </div>
  );
}

function formatModified(ms: number): string {
  return formatNodeTime(new Date(ms));
}
