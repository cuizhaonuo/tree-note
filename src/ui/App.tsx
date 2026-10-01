import { useCallback, useEffect, useState, type FormEvent } from "react";
import { initialEditorState, newNoteState, type EditorState } from "../core/commands";
import { parseNote, serializeNote, type ParseError } from "../core/format";
import { formatNodeTime } from "../core/note";
import { useAutosave, whenSaved, type Relocate, type SaveStatus, type SaveTarget } from "./autosave";
import { ConfirmDialog } from "./ConfirmDialog";
import { TreeCanvas } from "./TreeCanvas";
import {
  createNoteFile,
  deleteNoteFile,
  isFileSystemAccessSupported,
  listNotes,
  pickVault,
  readNote,
  renameNoteFile,
  type NoteFile,
} from "./vault";

type Opened =
  | { status: "none" }
  /** 重命名后 `file` 换成新文件，`target` 和 `session` 不变，画布不会重新打开。 */
  | { status: "ok"; file: NoteFile; state: EditorState; target: SaveTarget; session: number }
  | { status: "error"; file: NoteFile; error: ParseError | string };

/** 每次打开笔记的编号，用作画布的 key：打开另一篇笔记时画布重新开始，重命名时不会。 */
let lastSession = 0;
function nextSession(): number {
  return ++lastSession;
}

export function App() {
  const [vault, setVault] = useState<FileSystemDirectoryHandle | null>(null);
  const [files, setFiles] = useState<NoteFile[]>([]);
  const [opened, setOpened] = useState<Opened>({ status: "none" });
  const [vaultError, setVaultError] = useState<string | null>(null);
  const [askingTitle, setAskingTitle] = useState(false);
  const [deleting, setDeleting] = useState<NoteFile | null>(null);

  // 标题变了：换成按新标题命名的文件。打开的笔记和列表立即换成新文件，不等刷新列表，
  // 否则点到旧名字会去读、去删已经不存在的旧文件。
  const relocate: Relocate = useCallback(
    async (handle, title, text) => {
      if (!vault) throw new Error("没有打开笔记库");
      const file = await renameNoteFile(vault, handle, title, text);
      setOpened((o) => (o.status === "ok" && o.file.handle === handle ? { ...o, file } : o));
      setFiles((fs) => fs.map((f) => (f.name === handle.name ? file : f)));
      return file;
    },
    [vault],
  );
  // 写完后刷新列表，刚编辑过的笔记移到顶部。
  const refreshFiles = useCallback(() => {
    if (vault) listNotes(vault).then(setFiles, (e: unknown) => setVaultError(`无法读取笔记列表：${String(e)}`));
  }, [vault]);
  const autosave = useAutosave(opened.status === "ok" ? opened.target : null, relocate, refreshFiles);

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
      setOpened({ status: "ok", file, state, target: { handle: file.handle, title: state.note.title }, session: nextSession() });
      setVaultError(null);
    } catch (e) {
      setVaultError(`无法新建笔记：${String(e)}`);
    }
  }

  async function openFile(file: NoteFile) {
    // 已经打开的笔记不重新读：内存里的内容才是最新的，改名还没写完时旧文件也可能已经不在了。
    if (opened.status === "ok" && file.name === opened.file.name) return;
    try {
      // 先等之前的改动写完，否则可能读到旧内容。
      await whenSaved();
      const result = parseNote(await readNote(file));
      setOpened(
        result.ok
          ? {
              status: "ok",
              file,
              state: initialEditorState(result.note),
              target: { handle: file.handle, title: result.note.title },
              session: nextSession(),
            }
          : { status: "error", file, error: result.error },
      );
    } catch (e) {
      setOpened({ status: "error", file, error: `无法读取文件：${String(e)}` });
    }
  }

  async function deleteNote(file: NoteFile) {
    if (!vault) return;
    setDeleting(null);
    try {
      const isOpened = file.name === openedName;
      const target = isOpened && opened.status === "ok" ? opened.target : null;
      if (isOpened) {
        autosave.discard();
        setOpened({ status: "none" });
      }
      // 等排队的写入完成，否则删掉以后又会被写出来。
      await whenSaved();
      // 打开的笔记可能刚改过名，要删的是它现在的文件。
      await deleteNoteFile(vault, target ? target.handle.name : file.name);
      setFiles(await listNotes(vault));
      setVaultError(null);
    } catch (e) {
      setVaultError(`无法删除笔记：${String(e)}`);
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
                <span className="note-name">{noteName(file)}</span>
                <span className="note-date">{formatModified(file.lastModified)}</span>
              </button>
              <button className="note-delete" title="删除笔记" aria-label={`删除 ${noteName(file)}`} onClick={() => setDeleting(file)}>
                ×
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
            <TreeCanvas key={opened.session} initialState={opened.state} onNoteChange={autosave.schedule} />
          </>
        )}
        {askingTitle && <TitlePrompt onConfirm={createNote} onCancel={() => setAskingTitle(false)} />}
        {deleting && (
          <ConfirmDialog
            message={`删除笔记“${noteName(deleting)}”？文件 ${deleting.name} 会被删除，不能撤销。`}
            confirmLabel="删除"
            onConfirm={() => deleteNote(deleting)}
            onCancel={() => setDeleting(null)}
          />
        )}
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

function noteName(file: NoteFile): string {
  return file.name.replace(/\.md$/i, "");
}

function formatModified(ms: number): string {
  return formatNodeTime(new Date(ms));
}
