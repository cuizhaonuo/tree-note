// 客户端接口模块：mock fetch，验证请求的 URL、方法、请求体和错误处理。

import { afterEach, describe, expect, it, vi } from "vitest";
import { ConflictError, HttpError, adminCreateUser, adminListUsers, adminResetPassword, adminSetRole, adminSetStatus, changePassword, createNote, deleteNote, listNotes, login, logout, me, onUnauthorized, readNote, searchNotes, writeNote } from "./api";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function mockFetch(response: Response) {
  const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(response.clone()));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
  onUnauthorized(null);
});

describe("listNotes", () => {
  it("返回服务器给的笔记列表", async () => {
    const notes = [{ name: "a.md", lastModified: 123 }];
    mockFetch(jsonResponse({ notes }));
    await expect(listNotes()).resolves.toEqual(notes);
  });
});

describe("readNote", () => {
  it("文件名经过 URL 编码", async () => {
    const fetchMock = mockFetch(jsonResponse({ name: "x.md", text: "t", version: "v" }));
    await readNote("我的 笔记.md");
    expect(fetchMock).toHaveBeenCalledWith(`/api/notes/${encodeURIComponent("我的 笔记.md")}`, undefined);
  });
});

describe("createNote", () => {
  it("POST 标题和全文，返回文件名和版本号", async () => {
    const fetchMock = mockFetch(jsonResponse({ name: "t.md", version: "v1" }, 201));
    await expect(createNote("标题", "正文")).resolves.toEqual({ name: "t.md", version: "v1" });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/notes");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ title: "标题", text: "正文" });
  });
});

describe("writeNote", () => {
  it("PUT 全文和版本号；给了标题时一起带上", async () => {
    const fetchMock = mockFetch(jsonResponse({ name: "b.md", version: "v2" }));
    await writeNote("a.md", "正文", "v1");
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ text: "正文", version: "v1" });
    await writeNote("a.md", "正文", "v1", "新标题");
    const [url, init] = fetchMock.mock.calls[1];
    expect(url).toBe("/api/notes/a.md");
    expect(init.method).toBe("PUT");
    expect(JSON.parse(init.body)).toEqual({ text: "正文", version: "v1", title: "新标题" });
  });
});

describe("deleteNote", () => {
  it("发送 DELETE 请求", async () => {
    const fetchMock = mockFetch(jsonResponse({ ok: true }));
    await deleteNote("a.md");
    expect(fetchMock.mock.calls[0][1].method).toBe("DELETE");
  });
});

describe("searchNotes", () => {
  it("GET /api/search 带编码后的查询，返回结果列表", async () => {
    const hits = [{ file: "a.md", title: "t", inTitle: true, path: [], time: "2026-01-01 00:00", text: "x", snippet: [] }];
    const fetchMock = mockFetch(jsonResponse({ hits }));
    await expect(searchNotes("你好 world")).resolves.toEqual(hits);
    expect(fetchMock.mock.calls[0][0]).toBe(`/api/search?q=${encodeURIComponent("你好 world")}`);
  });
});

describe("login", () => {
  it("POST /api/login 带 JSON 用户名密码，返回用户", async () => {
    const user = { username: "u1", role: "user" };
    const fetchMock = mockFetch(jsonResponse(user));
    await expect(login("u1", "pw")).resolves.toEqual(user);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/login");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ username: "u1", password: "pw" });
  });
});

describe("me", () => {
  it("GET /api/me 返回当前用户", async () => {
    const user = { username: "u1", role: "admin" };
    const fetchMock = mockFetch(jsonResponse(user));
    await expect(me()).resolves.toEqual(user);
    expect(fetchMock.mock.calls[0][0]).toBe("/api/me");
  });
});

describe("logout", () => {
  it("POST /api/logout", async () => {
    const fetchMock = mockFetch(jsonResponse({ ok: true }));
    await expect(logout()).resolves.toBeUndefined();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/logout");
    expect(init.method).toBe("POST");
  });
});

describe("changePassword", () => {
  it("POST /api/password 带旧新密码", async () => {
    const fetchMock = mockFetch(jsonResponse({ ok: true }));
    await expect(changePassword("old", "newpassword")).resolves.toBeUndefined();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/password");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ oldPassword: "old", newPassword: "newpassword" });
  });
});

describe("管理接口", () => {
  const adminUser = { username: "u1", role: "user", status: "active", createdAt: 1, lastLoginAt: null, noteCount: 2, diskBytes: 100 };

  it("adminListUsers GET /api/admin/users 返回用户列表", async () => {
    const fetchMock = mockFetch(jsonResponse([adminUser]));
    await expect(adminListUsers()).resolves.toEqual([adminUser]);
    expect(fetchMock.mock.calls[0][0]).toBe("/api/admin/users");
  });

  it("adminCreateUser POST 用户名/密码/角色，返回新建的用户", async () => {
    const fetchMock = mockFetch(jsonResponse(adminUser, 201));
    await expect(adminCreateUser("u1", "password1", "user")).resolves.toEqual(adminUser);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/admin/users");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ username: "u1", password: "password1", role: "user" });
  });

  it("adminCreateUser 用户名重复时抛出服务器 409 消息", async () => {
    mockFetch(jsonResponse({ error: "用户名已存在" }, 409));
    await expect(adminCreateUser("u1", "password1", "user")).rejects.toMatchObject({ status: 409, message: "用户名已存在" });
  });

  it("adminResetPassword POST /password 带新密码，用户名经过编码", async () => {
    const fetchMock = mockFetch(jsonResponse({ ok: true }));
    await expect(adminResetPassword("我的 用户", "newpassword1")).resolves.toBeUndefined();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`/api/admin/users/${encodeURIComponent("我的 用户")}/password`);
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ password: "newpassword1" });
  });

  it("adminSetStatus POST /status 带状态", async () => {
    const fetchMock = mockFetch(jsonResponse({ ok: true }));
    await expect(adminSetStatus("u1", "disabled")).resolves.toBeUndefined();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/admin/users/u1/status");
    expect(JSON.parse(init.body)).toEqual({ status: "disabled" });
  });

  it("adminSetRole POST /role 带角色；改自己时服务器返回 400 消息", async () => {
    const fetchMock = mockFetch(jsonResponse({ ok: true }));
    await expect(adminSetRole("u1", "admin")).resolves.toBeUndefined();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/admin/users/u1/role");
    expect(JSON.parse(init.body)).toEqual({ role: "admin" });
    mockFetch(jsonResponse({ error: "不能修改自己的角色" }, 400));
    await expect(adminSetRole("me", "user")).rejects.toMatchObject({ status: 400, message: "不能修改自己的角色" });
  });
});

describe("onUnauthorized", () => {
  it("非登录接口 401 时先调用处理器再抛 HttpError", async () => {
    const handler = vi.fn();
    onUnauthorized(handler);
    mockFetch(jsonResponse({ error: "未登录" }, 401));
    await expect(listNotes()).rejects.toMatchObject({ status: 401, message: "未登录" });
    expect(handler).toHaveBeenCalledWith("未登录");
  });

  it("/api/login 的 401 不触发处理器", async () => {
    const handler = vi.fn();
    onUnauthorized(handler);
    mockFetch(jsonResponse({ error: "用户名或密码错误" }, 401));
    await expect(login("u", "bad")).rejects.toMatchObject({ status: 401 });
    expect(handler).not.toHaveBeenCalled();
  });

  it("onUnauthorized(null) 清除处理器", async () => {
    const handler = vi.fn();
    onUnauthorized(handler);
    onUnauthorized(null);
    mockFetch(jsonResponse({ error: "未登录" }, 401));
    await expect(listNotes()).rejects.toMatchObject({ status: 401 });
    expect(handler).not.toHaveBeenCalled();
  });
});

describe("错误处理", () => {
  it("非 2xx 时用服务器返回的 error 消息抛出异常", async () => {
    mockFetch(jsonResponse({ error: "note not found" }, 404));
    await expect(readNote("gone.md")).rejects.toThrow("note not found");
  });

  it("409 抛出 ConflictError", async () => {
    mockFetch(jsonResponse({ error: "version conflict" }, 409));
    await expect(writeNote("a.md", "正文", "v0")).rejects.toBeInstanceOf(ConflictError);
  });

  it("其他状态码不是 ConflictError", async () => {
    mockFetch(jsonResponse({ error: "boom" }, 500));
    await expect(readNote("a.md")).rejects.not.toBeInstanceOf(ConflictError);
  });

  it("非 2xx 抛出带状态码的 HttpError，409 也是", async () => {
    mockFetch(jsonResponse({ error: "boom" }, 503));
    await expect(readNote("a.md")).rejects.toMatchObject({ status: 503 });
    await expect(readNote("a.md")).rejects.toBeInstanceOf(HttpError);
    mockFetch(jsonResponse({ error: "version conflict" }, 409));
    await expect(writeNote("a.md", "正文", "v0")).rejects.toBeInstanceOf(HttpError);
  });
});
