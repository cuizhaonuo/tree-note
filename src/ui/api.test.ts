// 客户端接口模块：mock fetch，验证请求的 URL、方法、请求体和错误处理。

import { afterEach, describe, expect, it, vi } from "vitest";
import { ConflictError, HttpError, createNote, deleteNote, listNotes, readNote, searchNotes, writeNote } from "./api";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function mockFetch(response: Response) {
  const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(response.clone()));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => vi.unstubAllGlobals());

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
