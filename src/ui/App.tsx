import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { initialEditorState, newNoteState, type EditorState } from "../core/commands";
import { parseNote, serializeNote, type ParseError } from "../core/format";
import { formatNodeTime, type Note } from "../core/note";
import type { NodeLocator, SearchHit } from "../core/search";
import type { OpenedFile, SaveSession } from "./saveSession";
import * as api from "./api";
import { forgetStash, startSaving, stopSaving, usePageEvents, whenSaved, type SaveStatus } from "./autosave";
import { ChangePasswordDialog } from "./ChangePasswordDialog";
import { ConfirmDialog } from "./ConfirmDialog";
import { NoteSearch } from "./search";
import { TreeCanvas, type FocusRequest } from "./TreeCanvas";

type Opened =
  | { status: "none" }
  /**
   * 重命名后 `name` 换成新文件名，`save` 和 `session` 不变，画布不会重新打开。
   * `focus` 是最近一次从搜索结果要求选中的结点。
   */
  | { status: "ok"; name: string; state: EditorState; save: SaveSession; session: number; focus?: FocusRequest }
  | { status: "error"; name: string; error: ParseError | string };

/** 每次打开笔记的编号，用作画布的 key：打开另一篇笔记时画布重新开始，重命名时不会。 */
let lastSession = 0;
function nextSession(): number {
  return ++lastSession;
}

export function App({ user, epoch, onLogout }: { user: api.AuthUser; epoch: number; onLogout: () => void }) {
  const [files, setFiles] = useState<api.NoteEntry[] | null>(null);
  const [opened, setOpened] = useState<Opened>({ status: "none" });
  const [loadError, setLoadError] = useState<string | null>(null);
  const [askingTitle, setAskingTitle] = useState(false);
  const [deleting, setDeleting] = useState<api.NoteEntry | null>(null);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>({ kind: "saved" });
  const [discarding, setDiscarding] = useState(false);
  const [changingPassword, setChangingPassword] = useState(false);

  const refreshFiles = useCallback(() => {
    return api.listNotes().then(setFiles, (e: unknown) => setLoadError(`无法读取笔记列表：${String(e)}`));
  }, []);
  useEffect(() => {
    refreshFiles();
  }, [refreshFiles]);

  // 会话中途失效后重新登录：刷新列表，清掉失效期间留下的读取错误。
  useEffect(() => {
    if (epoch > 0) {
      setLoadError(null);
      refreshFiles();
    }
  }, [epoch, refreshFiles]);

  // 标题变了：服务器已换成按新标题命名的文件。打开的笔记和列表立即换成新名字，不等刷新列表，
  // 否则点到旧名字会去读、去删已经不存在的旧文件。
  const onRenamed = useCallback((previousName: string, name: string) => {
    setOpened((o) => (o.status === "ok" && o.name === previousName ? { ...o, name } : o));
    setFiles((fs) => fs?.map((f) => (f.name === previousName ? { ...f, name } : f)) ?? fs);
  }, []);

  // 打开着的笔记的自动保存。换成别的笔记（或者关掉）时停掉旧的。
  const saveRef = useRef<SaveSession | null>(null);
  function show(next: Opened) {
    const save = next.status === "ok" ? next.save : null;
    if (saveRef.current && saveRef.current !== save) stopSaving(saveRef.current);
    saveRef.current = save;
    setOpened(next);
  }
  function startSession(file: OpenedFile, fresh = false): SaveSession {
    // 写完后刷新列表，刚编辑过的笔记移到顶部。
    return startSaving(file, { onStatus: setSaveStatus, onRenamed, onSaved: refreshFiles }, fresh);
  }
  usePageEvents(opened.status === "ok" ? opened.save : null);

  const onNoteChange = useCallback((note: Note) => saveRef.current?.change(serializeNote(note), note.title), []);

  // Ctrl+N 新建笔记。注意：普通的 Chrome 标签页里浏览器会抢先处理 Ctrl+N（打开新窗口），
  // 只有把页面安装成应用窗口时才收得到，所以侧栏里另有一个“新建笔记”按钮。
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "n") {
        e.preventDefault();
        setAskingTitle(true);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  async function createNote(title: string) {
    setAskingTitle(false);
    try {
      const state = newNoteState(title, formatNodeTime(new Date()));
      const { name, version } = await api.createNote(title, serializeNote(state.note));
      await refreshFiles();
      setSaveStatus({ kind: "saved" });
      const save = startSession({ name, title, version }, true);
      show({ status: "ok", name, state, save, session: nextSession() });
      setLoadError(null);
    } catch (e) {
      setLoadError(`无法新建笔记：${String(e)}`);
    }
  }

  /** 打开笔记；给了 `hit`（搜索结果）时选中并居中那个结点。 */
  async function openFile(name: string, hit?: NodeLocator) {
    // 已经打开的笔记不重新读：内存里的内容才是最新的，改名还没写完时旧文件也可能已经不在了。
    if (opened.status === "ok" && name === opened.name) {
      if (hit) setOpened({ ...opened, focus: { target: hit } });
      return;
    }
    await loadFile(name, hit);
  }

  async function loadFile(name: string, hit?: NodeLocator) {
    try {
      // 先等之前的改动写完，否则可能读到旧内容。
      await whenSaved();
      const { text, version } = await api.readNote(name);
      const result = parseNote(text);
      if (!result.ok) {
        show({ status: "error", name, error: result.error });
        return;
      }
      // 浏览器里有这篇笔记没保存上的暂存：显示暂存的内容，自动保存已经开始写它。
      setSaveStatus({ kind: "saved" });
      const save = startSession({ name, title: result.note.title, version });
      const restored = save.restored && parseNote(save.restored.text);
      if (restored && !restored.ok) {
        // 暂存只会是我们自己写出的内容，正常不会走到这里；解析不了就丢掉，别写到服务器上。
        stopSaving(save, "discard");
        show({ status: "error", name, error: `浏览器里暂存的内容无法解析，已丢弃，请重新打开：第 ${restored.error.line} 行：${restored.error.message}` });
        return;
      }
      show({
        status: "ok",
        name,
        state: initialEditorState(restored ? restored.note : result.note),
        save,
        session: nextSession(),
        focus: hit && { target: hit },
      });
      if (restored) save.flush();
    } catch (e) {
      show({ status: "error", name, error: `无法读取笔记：${String(e)}` });
    }
  }

  /** 冲突后用户选择放弃这里的修改：清掉暂存，重新读服务器上的版本。 */
  async function discardLocalChanges() {
    setDiscarding(false);
    if (opened.status !== "ok") return;
    const { save } = opened;
    stopSaving(save, "discard");
    await save.settled();
    await loadFile(save.fileName);
  }

  async function deleteNote(file: api.NoteEntry) {
    setDeleting(null);
    try {
      const isOpened = file.name === openedName;
      const save = isOpened && opened.status === "ok" ? opened.save : null;
      if (isOpened) {
        if (save) stopSaving(save, "discard");
        show({ status: "none" });
      }
      // 等排队的写入完成，否则删掉以后又会被写出来。
      await whenSaved();
      // 打开的笔记可能刚改过名，要删的是它现在的文件。
      const name = save ? save.fileName : file.name;
      forgetStash(name);
      await api.deleteNote(name);
      await refreshFiles();
      setLoadError(null);
    } catch (e) {
      setLoadError(`无法删除笔记：${String(e)}`);
    }
  }

  const openedName = opened.status === "none" ? null : opened.name;

  // 打开搜索结果后让出焦点，方向键等按键直接作用在树上。
  function openHit(name: string, hit: SearchHit) {
    (document.activeElement as HTMLElement | null)?.blur();
    openFile(name, hit);
  }

  return (
    <div className="app">
      <aside className="sidebar">
        <button onClick={() => setAskingTitle(true)}>新建笔记（Ctrl+N）</button>
        {loadError && <div className="error">{loadError}</div>}
        <NoteSearch onOpen={openHit}>
          {files === null && !loadError && <div className="empty">读取笔记列表…</div>}
          {files !== null && files.length === 0 && <div className="empty">还没有笔记</div>}
          <ul className="note-list">
            {(files ?? []).map((file) => (
              <li key={file.name}>
                <button
                  className={file.name === openedName ? "active" : undefined}
                  onClick={() => openFile(file.name)}
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
        </NoteSearch>
        <div className="sidebar-footer">
          <span className="sidebar-username">{user.username}</span>
          <button onClick={() => setChangingPassword(true)}>修改密码</button>
          <button onClick={onLogout}>退出登录</button>
        </div>
      </aside>
      <main className="main">
        {opened.status === "none" && <div className="empty">从左侧选择一篇笔记</div>}
        {opened.status === "error" && <ParseErrorView name={opened.name} error={opened.error} />}
        {opened.status === "ok" && (
          <>
            <SaveIndicator status={saveStatus} onDiscard={() => setDiscarding(true)} />
            <TreeCanvas
              key={opened.session}
              initialState={opened.state}
              focus={opened.focus}
              onNoteChange={onNoteChange}
            />
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
        {discarding && (
          <ConfirmDialog
            message="放弃这里还没保存上的修改，重新载入服务器上的版本？放弃的修改不能找回。"
            confirmLabel="放弃并刷新"
            onConfirm={discardLocalChanges}
            onCancel={() => setDiscarding(false)}
          />
        )}
        {changingPassword && <ChangePasswordDialog onClose={() => setChangingPassword(false)} />}
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

function SaveIndicator({ status, onDiscard }: { status: SaveStatus; onDiscard: () => void }) {
  if (status.kind === "conflict" || status.kind === "error") {
    return (
      <div className="save-status error">
        {status.kind === "conflict" ? "这篇笔记在别处被修改过，请刷新" : `保存失败：${status.message}（内容已暂存在浏览器里）`}
        <button className="save-status-action" onClick={onDiscard}>
          放弃这里的修改并刷新
        </button>
      </div>
    );
  }
  if (status.kind === "unsaved") return <div className="save-status error">未保存（网络异常，内容已暂存在浏览器里，正在自动重试）</div>;
  if (status.kind === "pending") return <div className="save-status">未保存…</div>;
  if (status.kind === "saving") return <div className="save-status">保存中…</div>;
  return <div className="save-status">已保存</div>;
}

function ParseErrorView({ name, error }: { name: string; error: ParseError | string }) {
  return (
    <div className="parse-error">
      <h2>无法打开 {name}</h2>
      <p>{typeof error === "string" ? error : `第 ${error.line} 行：${error.message}`}</p>
    </div>
  );
}

function noteName(file: api.NoteEntry): string {
  return file.name.replace(/\.md$/i, "");
}

function formatModified(ms: number): string {
  return formatNodeTime(new Date(ms));
}
