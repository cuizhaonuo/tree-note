import { useState } from "react";
import { parseNote, type ParseError } from "../core/format";
import type { Note } from "../core/note";
import { TreeCanvas } from "./TreeCanvas";
import {
  isFileSystemAccessSupported,
  listNotes,
  pickVault,
  readNote,
  type NoteFile,
} from "./vault";

type Opened =
  | { status: "none" }
  | { status: "ok"; file: NoteFile; note: Note }
  | { status: "error"; file: NoteFile; error: ParseError | string };

export function App() {
  const [vault, setVault] = useState<FileSystemDirectoryHandle | null>(null);
  const [files, setFiles] = useState<NoteFile[]>([]);
  const [opened, setOpened] = useState<Opened>({ status: "none" });
  const [vaultError, setVaultError] = useState<string | null>(null);

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

  async function openFile(file: NoteFile) {
    try {
      const result = parseNote(await readNote(file));
      setOpened(result.ok ? { status: "ok", file, note: result.note } : { status: "error", file, error: result.error });
    } catch (e) {
      setOpened({ status: "error", file, error: `无法读取文件：${String(e)}` });
    }
  }

  const openedName = opened.status === "none" ? null : opened.file.name;

  return (
    <div className="app">
      <aside className="sidebar">
        <button onClick={chooseVault}>{vault ? "更换笔记库" : "打开笔记库文件夹"}</button>
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
        {opened.status === "ok" && <TreeCanvas key={opened.file.name} note={opened.note} />}
      </main>
    </div>
  );
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
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
