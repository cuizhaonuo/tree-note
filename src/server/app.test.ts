import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openAccounts, type Accounts } from "./accounts";
import { createApp } from "./app";

const NOTE_TEXT = "# 日记\n\n- [事件 2026-01-01 10:00] 第一条\n";

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** 登录并返回会话 cookie（`name=value`），用作后续请求的 Cookie 头。 */
async function loginCookie(app: ReturnType<typeof createApp>, username: string, password: string): Promise<string> {
  const res = await app.request("/api/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  return res.headers.get("Set-Cookie")!.split(";")[0];
}

describe("notes api", () => {
  let root: string;
  /** 当前登录用户（alice）的笔记目录。 */
  let dir: string;
  let accounts: Accounts;
  let app: ReturnType<typeof createApp>;
  /** 带着某个用户的会话 cookie 发请求。 */
  const withCookie =
    (cookie: string) =>
    (url: string, init: RequestInit = {}) =>
      app.request(url, { ...init, headers: { ...(init.headers as Record<string, string>), Cookie: cookie } });
  /** 以 alice 的身份发请求。 */
  let request: ReturnType<typeof withCookie>;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "tree-note-api-"));
    accounts = openAccounts(root);
    app = createApp(root, accounts);
    const alice = await accounts.createUser("alice", "alice-password", "user");
    dir = path.join(root, "users", String(alice.id));
    await fs.mkdir(dir, { recursive: true });
    request = withCookie(await loginCookie(app, "alice", "alice-password"));
  });

  afterEach(async () => {
    accounts.close();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("creates a note, then lists and reads it back", async () => {
    const created = await request("/api/notes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "日记", text: NOTE_TEXT }),
    });
    expect(created.status).toBe(201);
    const createdBody = await created.json();
    expect(createdBody).toEqual({ name: "日记.md", version: sha256(NOTE_TEXT) });

    const list = await request("/api/notes");
    expect(list.status).toBe(200);
    const listBody = await list.json();
    expect(listBody.notes).toHaveLength(1);
    expect(listBody.notes[0].name).toBe("日记.md");
    expect(typeof listBody.notes[0].lastModified).toBe("number");

    const read = await request(`/api/notes/${encodeURIComponent("日记.md")}`);
    expect(read.status).toBe(200);
    expect(await read.json()).toEqual({ name: "日记.md", text: NOTE_TEXT, version: sha256(NOTE_TEXT) });
  });

  it("adds -2, -3, … when the generated name is taken", async () => {
    const post = () =>
      request("/api/notes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "日记", text: NOTE_TEXT }),
      });
    expect((await (await post()).json()).name).toBe("日记.md");
    expect((await (await post()).json()).name).toBe("日记-2.md");
    expect((await (await post()).json()).name).toBe("日记-3.md");
  });

  it("lists notes by last modified time, newest first", async () => {
    await fs.writeFile(path.join(dir, "旧.md"), NOTE_TEXT);
    await fs.utimes(path.join(dir, "旧.md"), new Date("2026-01-01"), new Date("2026-01-01"));
    await fs.writeFile(path.join(dir, "新.md"), NOTE_TEXT);
    await fs.utimes(path.join(dir, "新.md"), new Date("2026-02-01"), new Date("2026-02-01"));

    const list = await request("/api/notes");
    const body = await list.json();
    expect(body.notes.map((note: { name: string }) => note.name)).toEqual(["新.md", "旧.md"]);
  });

  const put = (name: string, body: unknown) =>
    request(`/api/notes/${encodeURIComponent(name)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

  it("writes back a note when the version matches", async () => {
    await fs.writeFile(path.join(dir, "日记.md"), NOTE_TEXT);
    const updated = "# 日记\n\n- [事件 2026-01-01 10:00] 改过的第一条\n";

    const res = await put("日记.md", { text: updated, version: sha256(NOTE_TEXT) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ name: "日记.md", version: sha256(updated) });
    expect(await fs.readFile(path.join(dir, "日记.md"), "utf8")).toBe(updated);
  });

  it("returns 404 when writing back a note that does not exist", async () => {
    const res = await put("没有.md", { text: NOTE_TEXT, version: sha256(NOTE_TEXT) });
    expect(res.status).toBe(404);
  });

  it("returns 409 and does not write when the version does not match", async () => {
    await fs.writeFile(path.join(dir, "日记.md"), NOTE_TEXT);
    const res = await put("日记.md", { text: "别处改过的内容", version: "不是当前版本" });
    expect(res.status).toBe(409);
    expect(await fs.readFile(path.join(dir, "日记.md"), "utf8")).toBe(NOTE_TEXT);
  });

  it("sees external changes as a version change and rejects the old version", async () => {
    await fs.writeFile(path.join(dir, "日记.md"), NOTE_TEXT);
    const staleVersion = (await (await request(`/api/notes/${encodeURIComponent("日记.md")}`)).json()).version;

    // 外部改动：手动拷入或 git 恢复，版本号随之变化。
    const external = "# 日记\n\n- [事件 2026-01-01 10:00] 外部改动\n";
    await fs.writeFile(path.join(dir, "日记.md"), external);

    const res = await put("日记.md", { text: NOTE_TEXT, version: staleVersion });
    expect(res.status).toBe(409);
    expect(await fs.readFile(path.join(dir, "日记.md"), "utf8")).toBe(external);
  });

  it("renames the file in the same operation when the title changes", async () => {
    await fs.writeFile(path.join(dir, "日记.md"), NOTE_TEXT);

    const res = await put("日记.md", { text: NOTE_TEXT, version: sha256(NOTE_TEXT), title: "周报" });
    expect(res.status).toBe(200);
    expect((await res.json()).name).toBe("周报.md");
    expect(await fs.readdir(dir)).toEqual(["周报.md"]);
    expect(await fs.readFile(path.join(dir, "周报.md"), "utf8")).toBe(NOTE_TEXT);
  });

  it("adds a suffix when the renamed target is taken", async () => {
    await fs.writeFile(path.join(dir, "日记.md"), NOTE_TEXT);
    await fs.writeFile(path.join(dir, "周报.md"), NOTE_TEXT);

    const res = await put("日记.md", { text: NOTE_TEXT, version: sha256(NOTE_TEXT), title: "周报" });
    expect((await res.json()).name).toBe("周报-2.md");
    expect((await fs.readdir(dir)).sort()).toEqual(["周报-2.md", "周报.md"]);
  });

  it("writes back to the same file when only the title case differs", async () => {
    await fs.writeFile(path.join(dir, "Log.md"), NOTE_TEXT);

    const res = await put("Log.md", { text: NOTE_TEXT, version: sha256(NOTE_TEXT), title: "LOG" });
    expect(res.status).toBe(200);
    expect((await res.json()).name).toBe("Log.md");
    expect(await fs.readdir(dir)).toEqual(["Log.md"]);
  });

  it("rejects file names with .., path separators, or a non-.md suffix", async () => {
    await fs.writeFile(path.join(dir, "日记.md"), NOTE_TEXT);
    // `..` 必须出现在一个路径段内部：单独的 "../" 会被 URL 解析器在路由前规范化掉。
    const badNames = ["a..b.md", "..md", "sub/日记.md", "sub\\日记.md", "日记.txt", "日记"];
    for (const name of badNames) {
      const encoded = encodeURIComponent(name);
      expect((await request(`/api/notes/${encoded}`)).status).toBe(400);
      expect((await put(name, { text: NOTE_TEXT, version: "x" })).status).toBe(400);
      expect((await request(`/api/notes/${encoded}`, { method: "DELETE" })).status).toBe(400);
    }
    // 日记.md 没有被任何校验失败的请求改动或删除。
    expect(await fs.readFile(path.join(dir, "日记.md"), "utf8")).toBe(NOTE_TEXT);
  });

  it("deletes a note and returns 404 when it does not exist", async () => {
    await fs.writeFile(path.join(dir, "日记.md"), NOTE_TEXT);

    const res = await request(`/api/notes/${encodeURIComponent("日记.md")}`, { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(await fs.readdir(dir)).toEqual([]);

    const again = await request(`/api/notes/${encodeURIComponent("日记.md")}`, { method: "DELETE" });
    expect(again.status).toBe(404);
  });

  it("searches all notes and returns only matching hits", async () => {
    await fs.writeFile(path.join(dir, "日记.md"), "# 日记\n\n- [事件 2026-01-01 10:00] 买了牛奶\n");
    await fs.writeFile(path.join(dir, "周报.md"), "# 周报\n\n- [想法 2026-01-02 11:00] 周报里也有牛奶\n");
    await fs.writeFile(path.join(dir, "无关.md"), "# 无关\n\n- [事件 2026-01-03 12:00] 别的内容\n");

    const res = await request(`/api/search?q=${encodeURIComponent("牛奶")}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.hits).toHaveLength(2);
    expect(body.hits.map((hit: { file: string }) => hit.file).sort()).toEqual(["周报.md", "日记.md"]);
  });

  it("returns 400 when the search query is missing", async () => {
    expect((await request("/api/search")).status).toBe(400);
  });

  it("returns 400 on malformed JSON or missing fields", async () => {
    const post = (body: string) =>
      request("/api/notes", { method: "POST", headers: { "Content-Type": "application/json" }, body });
    expect((await post("not json")).status).toBe(400);
    expect((await post(JSON.stringify({ title: "日记" }))).status).toBe(400);
    expect((await put("日记.md", { version: "x" })).status).toBe(400);
    expect(await fs.readdir(dir)).toEqual([]);
  });

  it("returns 401 for every notes request when not logged in", async () => {
    await fs.writeFile(path.join(dir, "日记.md"), NOTE_TEXT);
    const name = encodeURIComponent("日记.md");
    const json = { "Content-Type": "application/json" };
    const responses = [
      await app.request("/api/notes"),
      await app.request(`/api/notes/${name}`),
      await app.request("/api/notes", { method: "POST", headers: json, body: JSON.stringify({ title: "新", text: NOTE_TEXT }) }),
      await app.request(`/api/notes/${name}`, { method: "PUT", headers: json, body: JSON.stringify({ text: "", version: sha256(NOTE_TEXT) }) }),
      await app.request(`/api/notes/${name}`, { method: "DELETE" }),
      await app.request(`/api/search?q=${encodeURIComponent("第一条")}`),
    ];
    expect(responses.map((res) => res.status)).toEqual([401, 401, 401, 401, 401, 401]);
    expect(await fs.readdir(dir)).toEqual(["日记.md"]);
    expect(await fs.readFile(path.join(dir, "日记.md"), "utf8")).toBe(NOTE_TEXT);
  });

  it("keeps each user's notes apart: bob cannot read, write, delete or search alice's notes by any name", async () => {
    const SECRET = "# 秘密\n\n- [事件 2026-01-01 10:00] alice 的秘密\n";
    await fs.writeFile(path.join(dir, "秘密.md"), SECRET);
    const bob = await accounts.createUser("bob", "bob-password", "user");
    const asBob = withCookie(await loginCookie(app, "bob", "bob-password"));

    expect((await (await asBob("/api/notes")).json()).notes).toEqual([]);
    expect((await (await asBob(`/api/search?q=${encodeURIComponent("秘密")}`)).json()).hits).toEqual([]);

    const aliceDirName = path.basename(dir);
    const names = ["秘密.md", `..%2F${aliceDirName}%2F秘密.md`, `..%5C${aliceDirName}%5C秘密.md`, `%2E%2E%2F${aliceDirName}%2F秘密.md`];
    for (const name of names) {
      const read = await asBob(`/api/notes/${name}`);
      expect([400, 404]).toContain(read.status);
      expect(await read.text()).not.toContain("alice 的秘密");
      const write = await asBob(`/api/notes/${name}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "bob 改的", version: sha256(SECRET) }),
      });
      expect([400, 404]).toContain(write.status);
      expect([400, 404]).toContain((await asBob(`/api/notes/${name}`, { method: "DELETE" })).status);
    }

    // bob 新建同名笔记只落在他自己的目录里。
    const created = await asBob("/api/notes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "秘密", text: NOTE_TEXT }),
    });
    expect((await created.json()).name).toBe("秘密.md");
    expect(await fs.readFile(path.join(root, "users", String(bob.id), "秘密.md"), "utf8")).toBe(NOTE_TEXT);
    expect(await fs.readFile(path.join(dir, "秘密.md"), "utf8")).toBe(SECRET);
    expect(await fs.readdir(dir)).toEqual(["秘密.md"]);
  });
});
