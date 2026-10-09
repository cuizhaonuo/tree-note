import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "./app";

const NOTE_TEXT = "# 日记\n\n- [事件 2026-01-01 10:00] 第一条\n";

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

describe("notes api", () => {
  let dir: string;
  let app: ReturnType<typeof createApp>;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "tree-note-api-"));
    app = createApp(dir);
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("creates a note, then lists and reads it back", async () => {
    const created = await app.request("/api/notes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "日记", text: NOTE_TEXT }),
    });
    expect(created.status).toBe(201);
    const createdBody = await created.json();
    expect(createdBody).toEqual({ name: "日记.md", version: sha256(NOTE_TEXT) });

    const list = await app.request("/api/notes");
    expect(list.status).toBe(200);
    const listBody = await list.json();
    expect(listBody.notes).toHaveLength(1);
    expect(listBody.notes[0].name).toBe("日记.md");
    expect(typeof listBody.notes[0].lastModified).toBe("number");

    const read = await app.request(`/api/notes/${encodeURIComponent("日记.md")}`);
    expect(read.status).toBe(200);
    expect(await read.json()).toEqual({ name: "日记.md", text: NOTE_TEXT, version: sha256(NOTE_TEXT) });
  });

  it("adds -2, -3, … when the generated name is taken", async () => {
    const post = () =>
      app.request("/api/notes", {
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

    const list = await app.request("/api/notes");
    const body = await list.json();
    expect(body.notes.map((note: { name: string }) => note.name)).toEqual(["新.md", "旧.md"]);
  });

  const put = (name: string, body: unknown) =>
    app.request(`/api/notes/${encodeURIComponent(name)}`, {
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
    const staleVersion = (await (await app.request(`/api/notes/${encodeURIComponent("日记.md")}`)).json()).version;

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
      expect((await app.request(`/api/notes/${encoded}`)).status).toBe(400);
      expect((await put(name, { text: NOTE_TEXT, version: "x" })).status).toBe(400);
      expect((await app.request(`/api/notes/${encoded}`, { method: "DELETE" })).status).toBe(400);
    }
    // 日记.md 没有被任何校验失败的请求改动或删除。
    expect(await fs.readFile(path.join(dir, "日记.md"), "utf8")).toBe(NOTE_TEXT);
  });

  it("deletes a note and returns 404 when it does not exist", async () => {
    await fs.writeFile(path.join(dir, "日记.md"), NOTE_TEXT);

    const res = await app.request(`/api/notes/${encodeURIComponent("日记.md")}`, { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(await fs.readdir(dir)).toEqual([]);

    const again = await app.request(`/api/notes/${encodeURIComponent("日记.md")}`, { method: "DELETE" });
    expect(again.status).toBe(404);
  });

  it("searches all notes and returns only matching hits", async () => {
    await fs.writeFile(path.join(dir, "日记.md"), "# 日记\n\n- [事件 2026-01-01 10:00] 买了牛奶\n");
    await fs.writeFile(path.join(dir, "周报.md"), "# 周报\n\n- [想法 2026-01-02 11:00] 周报里也有牛奶\n");
    await fs.writeFile(path.join(dir, "无关.md"), "# 无关\n\n- [事件 2026-01-03 12:00] 别的内容\n");

    const res = await app.request(`/api/search?q=${encodeURIComponent("牛奶")}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.hits).toHaveLength(2);
    expect(body.hits.map((hit: { file: string }) => hit.file).sort()).toEqual(["周报.md", "日记.md"]);
  });

  it("returns 400 when the search query is missing", async () => {
    expect((await app.request("/api/search")).status).toBe(400);
  });

  it("returns 400 on malformed JSON or missing fields", async () => {
    const post = (body: string) =>
      app.request("/api/notes", { method: "POST", headers: { "Content-Type": "application/json" }, body });
    expect((await post("not json")).status).toBe(400);
    expect((await post(JSON.stringify({ title: "日记" }))).status).toBe(400);
    expect((await put("日记.md", { version: "x" })).status).toBe(400);
    expect(await fs.readdir(dir)).toEqual([]);
  });
});
