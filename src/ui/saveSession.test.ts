// 自动保存的状态逻辑：用一个内存里的假服务器和假 localStorage，验证防抖写回、断网暂存与重试、
// 409 停止、打开时恢复暂存。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConflictError, HttpError } from "./api";
import { SaveSession, type SaveDeps, type SaveStatus } from "./saveSession";

/** 假服务器：版本号由内容决定，和真服务器一样；可以断网、返回 5xx、在别处改文件。 */
function fakeServer(initial: Record<string, string>) {
  const files = new Map(Object.entries(initial));
  let failure: (() => Error) | null = null;
  const versionOf = (text: string) => `v(${text})`;
  return {
    files,
    versionOf,
    goOffline: () => (failure = () => new TypeError("Failed to fetch")),
    failWith500: () => (failure = () => new HttpError("boom", 500)),
    goOnline: () => (failure = null),
    write: vi.fn(async (name: string, text: string, version: string, title?: string) => {
      if (failure) throw failure();
      const current = files.get(name);
      if (current === undefined) throw new HttpError("note not found", 404);
      if (versionOf(current) !== version) throw new ConflictError("version conflict");
      let target = name;
      if (title !== undefined) {
        target = `${title}.md`;
        files.delete(name);
      }
      files.set(target, text);
      return { name: target, version: versionOf(text) };
    }),
    read: vi.fn(async (name: string) => {
      if (failure) throw failure();
      const text = files.get(name);
      if (text === undefined) throw new HttpError("note not found", 404);
      return { name, text, version: versionOf(text) };
    }),
  };
}

function memoryStorage() {
  const items = new Map<string, string>();
  return {
    items,
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
    removeItem: (key: string) => void items.delete(key),
  };
}

let server: ReturnType<typeof fakeServer>;
let storage: ReturnType<typeof memoryStorage>;
let statuses: SaveStatus[];

function deps(user = "alice"): SaveDeps {
  return { write: server.write, read: server.read, storage, user };
}

/** 打开服务器上的一篇笔记，就像界面读到它之后那样。 */
function open(name: string, title: string, user = "alice") {
  const events = {
    onStatus: (s: SaveStatus) => statuses.push(s),
    onRenamed: vi.fn(),
    onSaved: vi.fn(),
  };
  const session = new SaveSession({ name, title, version: server.versionOf(server.files.get(name)!) }, deps(user), events);
  return { session, events };
}

const status = (session: SaveSession) => session.status.kind;

beforeEach(() => {
  vi.useFakeTimers();
  server = fakeServer({ "日记.md": "# 日记\n" });
  storage = memoryStorage();
  statuses = [];
});

afterEach(() => vi.useRealTimers());

describe("自动保存", () => {
  it("改动后约 1 秒写回服务器，期间显示未保存", async () => {
    const { session, events } = open("日记.md", "日记");
    session.change("# 日记\n- 一\n", "日记");
    expect(status(session)).toBe("pending");
    await vi.advanceTimersByTimeAsync(999);
    expect(server.write).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(server.files.get("日记.md")).toBe("# 日记\n- 一\n");
    expect(status(session)).toBe("saved");
    expect(events.onSaved).toHaveBeenCalled();
  });

  it("断网时暂存全文、显示未保存，按退避间隔重试，成功后清除暂存", async () => {
    const { session } = open("日记.md", "日记");
    server.goOffline();
    session.change("# 日记\n- 离线\n", "日记");
    await vi.advanceTimersByTimeAsync(1000);
    expect(status(session)).toBe("unsaved");
    expect(storage.items.size).toBe(1);

    // 第一次重试在 1 秒后，仍然失败；第二次在再 2 秒后。
    await vi.advanceTimersByTimeAsync(1000);
    expect(server.write).toHaveBeenCalledTimes(2);
    server.goOnline();
    await vi.advanceTimersByTimeAsync(1999);
    expect(server.write).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(server.write).toHaveBeenCalledTimes(3);
    expect(server.files.get("日记.md")).toBe("# 日记\n- 离线\n");
    expect(status(session)).toBe("saved");
    expect(storage.items.size).toBe(0);
  });

  it("5xx 和断网一样处理；等待重试期间的新改动更新暂存，不打乱退避，重试时写最新内容", async () => {
    const { session } = open("日记.md", "日记");
    server.failWith500();
    session.change("# 日记\n- 一\n", "日记");
    await vi.advanceTimersByTimeAsync(1000);
    expect(status(session)).toBe("unsaved");

    session.change("# 日记\n- 一\n- 二\n", "日记");
    expect(status(session)).toBe("unsaved");
    expect([...storage.items.values()][0]).toContain("- 二");
    await vi.advanceTimersByTimeAsync(999);
    expect(server.write).toHaveBeenCalledTimes(1);

    server.goOnline();
    await vi.advanceTimersByTimeAsync(1);
    expect(server.files.get("日记.md")).toBe("# 日记\n- 一\n- 二\n");
    expect(storage.items.size).toBe(0);
  });
});

describe("重命名", () => {
  it("标题变化时立即写入，带上新标题，服务器改名后通知界面", async () => {
    const { session, events } = open("日记.md", "日记");
    session.change("# 周记\n", "周记");
    await vi.advanceTimersByTimeAsync(0);
    expect(server.write).toHaveBeenCalledWith("日记.md", "# 周记\n", server.versionOf("# 日记\n"), "周记");
    expect([...server.files.keys()]).toEqual(["周记.md"]);
    expect(events.onRenamed).toHaveBeenCalledWith("日记.md", "周记.md");

    // 之后的写入用新名字，不再带标题。
    session.change("# 周记\n- 一\n", "周记");
    await vi.advanceTimersByTimeAsync(1000);
    expect(server.write).toHaveBeenLastCalledWith("周记.md", "# 周记\n- 一\n", server.versionOf("# 周记\n"), undefined);
  });

  it("改名写入失败后，重试时仍然带上新标题", async () => {
    const { session, events } = open("日记.md", "日记");
    server.goOffline();
    session.change("# 周记\n", "周记");
    await vi.advanceTimersByTimeAsync(0);
    expect(status(session)).toBe("unsaved");
    server.goOnline();
    await vi.advanceTimersByTimeAsync(1000);
    expect([...server.files.keys()]).toEqual(["周记.md"]);
    expect(events.onRenamed).toHaveBeenCalledWith("日记.md", "周记.md");
    expect(storage.items.size).toBe(0);
  });

  it("改名没写成就关了页面：重新打开旧文件时恢复并完成改名", async () => {
    const first = open("日记.md", "日记");
    server.goOffline();
    first.session.change("# 周记\n", "周记");
    await vi.advanceTimersByTimeAsync(0);
    server.goOnline();

    const { session, events } = open("日记.md", "日记");
    expect(session.restored).toEqual({ text: "# 周记\n", title: "周记" });
    session.flush();
    await vi.advanceTimersByTimeAsync(0);
    expect([...server.files.keys()]).toEqual(["周记.md"]);
    expect(events.onRenamed).toHaveBeenCalledWith("日记.md", "周记.md");
    expect(storage.items.size).toBe(0);
  });
});

describe("版本冲突（409）", () => {
  it("停止自动保存、显示冲突，内容和之后的改动都暂存，不再发起写入", async () => {
    const { session } = open("日记.md", "日记");
    server.files.set("日记.md", "# 日记\n- 别处改的\n");
    session.change("# 日记\n- 这里改的\n", "日记");
    await vi.advanceTimersByTimeAsync(1000);
    expect(status(session)).toBe("conflict");
    expect(server.write).toHaveBeenCalledTimes(1);

    session.change("# 日记\n- 这里又改的\n", "日记");
    session.flush();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(status(session)).toBe("conflict");
    expect(server.write).toHaveBeenCalledTimes(1);
    expect(server.files.get("日记.md")).toBe("# 日记\n- 别处改的\n");
    expect([...storage.items.values()][0]).toContain("这里又改的");
  });

  it("服务器上已经是要写的内容（上次写成功了但响应丢了）时不算冲突", async () => {
    const { session } = open("日记.md", "日记");
    server.files.set("日记.md", "# 日记\n- 同样的\n");
    session.change("# 日记\n- 同样的\n", "日记");
    await vi.advanceTimersByTimeAsync(1000);
    expect(status(session)).toBe("saved");
    session.change("# 日记\n- 接着改\n", "日记");
    await vi.advanceTimersByTimeAsync(1000);
    expect(server.files.get("日记.md")).toBe("# 日记\n- 接着改\n");
  });
});

describe("断网时连续编辑", () => {
  it("重试那次写入进行中又有改动：失败后仍按退避等待，不被防抖提前", async () => {
    const { session } = open("日记.md", "日记");
    server.goOffline();
    session.change("# 日记\n- 一\n", "日记");
    await vi.advanceTimersByTimeAsync(1000); // 第 1 次失败，1 秒后重试
    let release!: () => void;
    server.write.mockImplementationOnce(
      () => new Promise((_, reject) => (release = () => reject(new TypeError("Failed to fetch")))),
    );
    await vi.advanceTimersByTimeAsync(1000); // 第 2 次开始，还没返回
    session.change("# 日记\n- 一\n- 二\n", "日记");
    release();
    await vi.advanceTimersByTimeAsync(1999); // 第 2 次失败后应等 2 秒
    expect(server.write).toHaveBeenCalledTimes(2);
    expect(status(session)).toBe("unsaved");
  });
});

describe("打开时恢复暂存", () => {
  /** 断网时改了一次就关掉页面，留下暂存。 */
  async function leaveStash(text: string) {
    const { session } = open("日记.md", "日记");
    server.goOffline();
    session.change(text, "日记");
    await vi.advanceTimersByTimeAsync(1000);
    expect(storage.items.size).toBe(1);
    server.write.mockClear();
  }

  it("重新打开这篇笔记时恢复暂存内容并立即保存，成功后清除暂存", async () => {
    await leaveStash("# 日记\n- 关页面前\n");
    server.goOnline();
    const { session } = open("日记.md", "日记");
    expect(session.restored).toEqual({ text: "# 日记\n- 关页面前\n", title: "日记" });
    // 界面确认暂存的内容能显示之后才开始写。
    await vi.advanceTimersByTimeAsync(0);
    expect(server.write).not.toHaveBeenCalled();
    session.flush();
    await vi.advanceTimersByTimeAsync(0);
    expect(server.files.get("日记.md")).toBe("# 日记\n- 关页面前\n");
    expect(status(session)).toBe("saved");
    expect(storage.items.size).toBe(0);
  });

  it("暂存按用户区分：别的用户打开同名笔记看不到", async () => {
    await leaveStash("# 日记\n- alice 的\n");
    server.goOnline();
    const { session } = open("日记.md", "日记", "bob");
    expect(session.restored).toBeUndefined();
    await vi.advanceTimersByTimeAsync(0);
    expect(server.write).not.toHaveBeenCalled();
    expect(storage.items.size).toBe(1);
  });

  it("暂存之后笔记在别处被改过：恢复暂存内容但显示冲突，不覆盖，暂存保留", async () => {
    await leaveStash("# 日记\n- 关页面前\n");
    server.goOnline();
    server.files.set("日记.md", "# 日记\n- 别的设备\n");
    const { session } = open("日记.md", "日记");
    expect(session.restored?.text).toBe("# 日记\n- 关页面前\n");
    session.flush();
    await vi.advanceTimersByTimeAsync(0);
    expect(status(session)).toBe("conflict");
    expect(server.files.get("日记.md")).toBe("# 日记\n- 别的设备\n");
    expect(storage.items.size).toBe(1);
  });

  it("没有暂存时什么也不做", () => {
    const { session } = open("日记.md", "日记");
    expect(session.restored).toBeUndefined();
    expect(status(session)).toBe("saved");
  });
});

describe("结束一次编辑", () => {
  it("discard（笔记要被删除）：清除暂存，之后不再写入", async () => {
    const { session } = open("日记.md", "日记");
    server.goOffline();
    session.change("# 日记\n- 一\n", "日记");
    await vi.advanceTimersByTimeAsync(1000);
    session.discard();
    expect(storage.items.size).toBe(0);
    server.goOnline();
    session.change("# 日记\n- 二\n", "日记");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(server.write).toHaveBeenCalledTimes(1);
    expect(storage.items.size).toBe(0);
  });

  it("close（切换到别的笔记）：立即写还没写的改动，失败就留在暂存里，不再重试也不再报告状态", async () => {
    const { session } = open("日记.md", "日记");
    session.change("# 日记\n- 一\n", "日记");
    server.goOffline();
    session.close();
    await session.settled();
    expect(server.write).toHaveBeenCalledTimes(1);
    expect(storage.items.size).toBe(1);
    expect(statuses.at(-1)?.kind).toBe("pending");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(server.write).toHaveBeenCalledTimes(1);
  });

  it("close 时正在写：写完后接着写排在后面的改动", async () => {
    const { session } = open("日记.md", "日记");
    session.change("# 日记\n- 一\n", "日记");
    session.flush();
    session.change("# 日记\n- 一\n- 二\n", "日记");
    session.close();
    await session.settled();
    expect(server.files.get("日记.md")).toBe("# 日记\n- 一\n- 二\n");
    expect(storage.items.size).toBe(0);
  });

  it("stashUnsaved（页面要关闭）：把还没写完的改动暂存下来，下次打开能恢复", async () => {
    const { session } = open("日记.md", "日记");
    session.change("# 日记\n- 关之前\n", "日记");
    session.stashUnsaved();
    expect(open("日记.md", "日记").session.restored?.text).toBe("# 日记\n- 关之前\n");
  });

  it("无法重试的错误（比如笔记已在别处删除）：停止并显示错误，暂存保留", async () => {
    const { session } = open("日记.md", "日记");
    server.files.delete("日记.md");
    session.change("# 日记\n- 一\n", "日记");
    await vi.advanceTimersByTimeAsync(1000);
    expect(session.status).toEqual({ kind: "error", message: expect.stringContaining("note not found") });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(server.write).toHaveBeenCalledTimes(1);
    expect(storage.items.size).toBe(1);
  });
});
