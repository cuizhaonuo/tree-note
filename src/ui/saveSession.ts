// 一篇打开着的笔记的自动保存：不依赖 React 的纯逻辑，网络请求和 localStorage 由参数注入。
//
// 改动后防抖约 1 秒写回，每次写入带上基于的版本号，成功后换成服务器返回的新版本号。
// 标题变化时立即写入并带上新标题，服务器在同一次写入里完成重命名，返回新文件名。
// 写入失败（网络错误或 5xx）时把未保存的全文按“用户 + 文件名”暂存到 localStorage，按退避间隔重试，
// 写成功后清除暂存。
// 版本冲突（409）说明笔记在别处被改过：自动保存停止，不覆盖，内容留在暂存里，由用户决定放弃。
// 其他错误（比如笔记已被删除）同样停止并保留暂存。

import { ConflictError, HttpError, type NoteVersion } from "./api";

const DEBOUNCE_MS = 1000;
const FIRST_RETRY_MS = 1000;
const MAX_RETRY_MS = 30_000;

export type SaveStatus =
  | { kind: "saved" }
  | { kind: "saving" }
  /** 有改动还在防抖，还没开始写。 */
  | { kind: "pending" }
  /** 写入失败，内容已暂存在浏览器里，等待自动重试。 */
  | { kind: "unsaved" }
  /** 笔记在别处被修改过，自动保存已停止。 */
  | { kind: "conflict" }
  /** 无法重试的错误，自动保存已停止。 */
  | { kind: "error"; message: string };

export interface SaveDeps {
  write(name: string, text: string, version: string, title?: string): Promise<NoteVersion>;
  read(name: string): Promise<NoteVersion & { text: string }>;
  storage: Pick<Storage, "getItem" | "setItem" | "removeItem">;
  /** 暂存按“用户 + 文件名”区分。 */
  user: string;
}

export interface SaveEvents {
  onStatus?(status: SaveStatus): void;
  /** 一次写入完成了重命名，界面把打开着的笔记和列表里的名字换过来。 */
  onRenamed?(previousName: string, name: string): void;
  /** 所有改动都写完了，界面可以借此刷新笔记列表的修改时间。 */
  onSaved?(): void;
}

/** 刚打开的笔记在服务器上的样子。 */
export interface OpenedFile {
  name: string;
  title: string;
  version: string;
}

interface Change {
  text: string;
  title: string;
}

/** 暂存的内容：全文、标题，以及它基于的版本号。 */
interface Stash extends Change {
  version: string;
}

function stashKey(user: string, name: string): string {
  return `tree-note:stash:${JSON.stringify([user, name])}`;
}

/** 删掉一篇笔记的暂存（笔记被删除，或者新建的笔记碰上了旧笔记留下的同名暂存）。 */
export function discardStash(storage: SaveDeps["storage"], user: string, name: string): void {
  storage.removeItem(stashKey(user, name));
}

/**
 * 把 fromUser 名下的全部暂存改到 toUser 名下：登录前的暂存属于占位用户，不能在登录后丢掉。
 * 暂存键的格式只在这个文件里维护（stashKey），调用方不要自己拼键。
 */
export function migrateStashes(
  storage: Pick<Storage, "length" | "key" | "getItem" | "setItem" | "removeItem">,
  fromUser: string,
  toUser: string,
): void {
  if (fromUser === toUser) return;
  // 暂存键形如 tree-note:stash:["用户","文件名"]。
  const prefix = `tree-note:stash:[${JSON.stringify(fromUser)},`;
  for (let i = storage.length - 1; i >= 0; i--) {
    const key = storage.key(i);
    if (!key || !key.startsWith(prefix)) continue;
    const value = storage.getItem(key);
    if (value === null) continue;
    // key 剩余部分是 `"文件名"]`，拼成 ["新用户","文件名"]，和 stashKey 的格式一致。
    storage.setItem(`tree-note:stash:[${JSON.stringify(toUser)},${key.slice(prefix.length)}`, value);
    storage.removeItem(key);
  }
}

function readStash(storage: SaveDeps["storage"], key: string): Stash | undefined {
  try {
    const value: unknown = JSON.parse(storage.getItem(key) ?? "null");
    if (
      typeof value === "object" &&
      value !== null &&
      "text" in value &&
      "title" in value &&
      "version" in value &&
      typeof value.text === "string" &&
      typeof value.title === "string" &&
      typeof value.version === "string"
    ) {
      return { text: value.text, title: value.title, version: value.version };
    }
  } catch {
    // 不是我们写的内容，当作没有暂存。
  }
  return undefined;
}

/** 网络错误（请求没到服务器）或 5xx：过一会儿再试可能就好了。 */
function isRetryable(error: unknown): boolean {
  return !(error instanceof HttpError) || error.status >= 500;
}

export class SaveSession {
  status: SaveStatus = { kind: "saved" };
  /**
   * 打开时 localStorage 里有这篇笔记的暂存：界面应该显示这份内容而不是服务器上的。
   * 界面确认能显示之后调用 `flush()`，用暂存基于的版本号写回。
   */
  readonly restored: Change | undefined;
  private name: string;
  private version: string;
  /** 服务器上文件里的标题。要写的内容标题和它不同时，写入带上新标题让服务器改名。 */
  private savedTitle: string;
  /** 最近一次改动的标题，用来发现改名。 */
  private lastTitle: string;
  /** 还没开始写的最新改动。 */
  private desired: Change | null = null;
  /** 正在写的改动。 */
  private current: Change | null = null;
  private inFlight: Promise<void> | null = null;
  private debounce: ReturnType<typeof setTimeout> | undefined;
  private retry: ReturnType<typeof setTimeout> | undefined;
  /** 连续失败的次数，决定下一次重试等多久。 */
  private failures = 0;
  private stashed = false;
  /** 冲突或出错后停止：之后的改动只暂存，不再写入。 */
  private stopped: Extract<SaveStatus, { kind: "conflict" | "error" }> | null = null;
  /** closed：切换到了别的笔记，只把手上的改动写一次；discarded：笔记要被删除，什么都不再写。 */
  private ended: "closed" | "discarded" | null = null;

  constructor(
    file: OpenedFile,
    private readonly deps: SaveDeps,
    private readonly events: SaveEvents = {},
  ) {
    this.name = file.name;
    this.version = file.version;
    this.savedTitle = this.lastTitle = file.title;
    const stash = readStash(deps.storage, stashKey(deps.user, file.name));
    if (stash) {
      const { version, ...change } = stash;
      this.restored = change;
      this.version = version;
      this.lastTitle = change.title;
      this.desired = change;
      this.stashed = true;
    }
  }

  /** 文件现在的名字（重命名完成后换成新名字）。 */
  get fileName(): string {
    return this.name;
  }

  change(text: string, title: string): void {
    if (this.ended) return;
    this.desired = { text, title };
    // 已经有暂存：新改动也立即暂存，这时关掉页面也不丢。
    if (this.stashed) this.writeStash();
    const renamed = title !== this.lastTitle;
    this.lastTitle = title;
    if (this.stopped) return;
    // 写入正在失败（等待重试或者重试进行中）时不另起防抖，按退避重试时写最新的内容。
    if (this.failures > 0) return;
    this.setStatus({ kind: "pending" });
    if (renamed) {
      // 改名立即写：之后点开列表里的新名字时文件已经在了。
      this.flush();
      return;
    }
    clearTimeout(this.debounce);
    this.debounce = setTimeout(() => this.flush(), DEBOUNCE_MS);
  }

  /** 立即写入还在防抖或等待重试的改动。 */
  flush(): void {
    clearTimeout(this.debounce);
    this.debounce = undefined;
    clearTimeout(this.retry);
    this.retry = undefined;
    this.pump();
  }

  /** 等到正在进行的写入完成（不等待重试）。 */
  async settled(): Promise<void> {
    while (this.inFlight) await this.inFlight;
  }

  /** 页面要关闭了：还没写完的改动立即暂存，下次打开这篇笔记时恢复。 */
  stashUnsaved(): void {
    if (this.ended !== "discarded") this.writeStash();
  }

  /** 切换到别的笔记：立即写一次还没写的改动，失败就留在暂存里，不再重试，也不再报告状态。 */
  close(): void {
    if (this.ended) return;
    // 先标记结束再写：这次写入的状态不能报告到界面上，界面已经在显示别的笔记了。
    this.ended = "closed";
    this.flush();
  }

  /** 笔记要被删除：丢掉还没写的改动和暂存，之后什么都不再写。 */
  discard(): void {
    this.ended = "discarded";
    clearTimeout(this.debounce);
    clearTimeout(this.retry);
    this.desired = null;
    this.clearStash();
  }

  private pump(): void {
    if (this.inFlight || this.stopped || this.ended === "discarded" || !this.desired) return;
    const job = this.desired;
    this.desired = null;
    this.current = job;
    this.setStatus({ kind: "saving" });
    this.inFlight = this.attempt(job).then((written) => {
      this.current = null;
      this.inFlight = null;
      this.afterAttempt(written);
    });
  }

  /** 写一次，返回是否写成了（包括服务器上本来就是这份内容）。 */
  private async attempt(job: Change): Promise<boolean> {
    try {
      const from = this.name;
      const title = job.title === this.savedTitle ? undefined : job.title;
      const result = await this.deps.write(from, job.text, this.version, title);
      this.version = result.version;
      this.savedTitle = job.title;
      this.failures = 0;
      if (result.name !== from) {
        // 暂存跟着换到新名字下（还有没写的改动时）。
        const stashed = this.stashed;
        this.clearStash();
        this.name = result.name;
        if (stashed) this.writeStash();
        this.events.onRenamed?.(from, result.name);
      }
      return true;
    } catch (error) {
      if (this.ended === "discarded") return false;
      // 失败的这次之后如果又有改动，以最新的为准。
      this.desired ??= job;
      if (error instanceof ConflictError && (await this.alreadyWritten(job))) {
        if (this.desired === job) this.desired = null;
        this.failures = 0;
        return true;
      }
      // 读服务器的时候笔记可能被放弃了，不能把暂存又写回去。
      if (this.isDiscarded()) return false;
      this.writeStash();
      // 401 是登录过期：不重试（没有会话重试也没用）也不停止，重新登录后 flush() 就能写回去。
      if (error instanceof HttpError && error.status === 401) return false;
      if (!isRetryable(error)) {
        this.stopped = error instanceof ConflictError ? { kind: "conflict" } : { kind: "error", message: String(error) };
      } else if (!this.ended) {
        const delay = Math.min(FIRST_RETRY_MS * 2 ** this.failures, MAX_RETRY_MS);
        this.failures++;
        this.retry = setTimeout(() => this.flush(), delay);
      }
      return false;
    }
  }

  /** 用方法读，免得 TypeScript 在 await 前后把它收窄成固定的值：await 期间可能调用了 discard()。 */
  private isDiscarded(): boolean {
    return this.ended === "discarded";
  }

  /**
   * 写入被拒绝时，服务器上可能已经是这份内容：上次写成功了但响应没收到，暂存基于的还是旧版本号。
   * 这时换成服务器上的版本号就行，不算冲突。
   */
  private async alreadyWritten(job: Change): Promise<boolean> {
    try {
      const current = await this.deps.read(this.name);
      if (current.text !== job.text) return false;
      this.version = current.version;
      return true;
    } catch {
      return false;
    }
  }

  private afterAttempt(written: boolean): void {
    if (this.ended === "discarded") return;
    if (!written) {
      // 停止、等待重试，或者已经关闭（内容留在暂存里）。
      if (this.stopped) this.setStatus(this.stopped);
      else this.setStatus({ kind: "unsaved" });
      return;
    }
    if (this.desired) {
      if (this.debounce === undefined) this.pump();
      return;
    }
    this.clearStash();
    this.setStatus({ kind: "saved" });
    this.events.onSaved?.();
  }

  private writeStash(): void {
    const change = this.desired ?? this.current;
    if (!change) return;
    const stash: Stash = { ...change, version: this.version };
    this.deps.storage.setItem(stashKey(this.deps.user, this.name), JSON.stringify(stash));
    this.stashed = true;
  }

  private clearStash(): void {
    if (!this.stashed) return;
    this.deps.storage.removeItem(stashKey(this.deps.user, this.name));
    this.stashed = false;
  }

  private setStatus(status: SaveStatus): void {
    if (this.ended) return;
    this.status = status;
    this.events.onStatus?.(status);
  }
}
