// 笔记接口：列出、读取、新建、写回（含重命名）、删除、全文搜索，全部返回 JSON。

import { Hono } from "hono";
import type { Context } from "hono";
import { isValidNoteFileName } from "../core/fileName";
import { parseNote } from "../core/format";
import { searchNotes, type SearchableNote } from "../core/search";
import { createNote, deleteNote, listNotes, readNote, versionOf, writeNote } from "./store";

/** 取出路径里的文件名并校验；不合法时返回 undefined，由路由返回 400。 */
function noteName(c: Context): string | undefined {
  const name = c.req.param("name");
  return name !== undefined && isValidNoteFileName(name) ? name : undefined;
}

/** 解析 JSON 请求体；格式错误时返回 undefined，由路由返回 400。 */
async function parseBody(c: Context): Promise<Record<string, unknown> | undefined> {
  try {
    return await c.req.json();
  } catch {
    return undefined;
  }
}

export function createApp(dataDir: string): Hono {
  const app = new Hono();

  app.get("/api/notes", async (c) => {
    return c.json({ notes: await listNotes(dataDir) });
  });

  app.get("/api/notes/:name", async (c) => {
    const name = noteName(c);
    if (!name) return c.json({ error: "invalid file name" }, 400);
    const text = await readNote(dataDir, name);
    if (text === undefined) return c.json({ error: "note not found" }, 404);
    return c.json({ name, text, version: versionOf(text) });
  });

  app.post("/api/notes", async (c) => {
    const body = await parseBody(c);
    if (!body || typeof body.title !== "string" || typeof body.text !== "string") {
      return c.json({ error: "expected { title, text }" }, 400);
    }
    return c.json(await createNote(dataDir, body.title, body.text), 201);
  });

  app.put("/api/notes/:name", async (c) => {
    const name = noteName(c);
    if (!name) return c.json({ error: "invalid file name" }, 400);
    const body = await parseBody(c);
    if (
      !body ||
      typeof body.text !== "string" ||
      typeof body.version !== "string" ||
      (body.title !== undefined && typeof body.title !== "string")
    ) {
      return c.json({ error: "expected { text, version, title? }" }, 400);
    }
    const current = await readNote(dataDir, name);
    if (current === undefined) return c.json({ error: "note not found" }, 404);
    if (versionOf(current) !== body.version) return c.json({ error: "version conflict" }, 409);
    return c.json(await writeNote(dataDir, name, body.text, body.title as string | undefined));
  });

  app.delete("/api/notes/:name", async (c) => {
    const name = noteName(c);
    if (!name) return c.json({ error: "invalid file name" }, 400);
    if (!(await deleteNote(dataDir, name))) return c.json({ error: "note not found" }, 404);
    return c.json({ ok: true });
  });

  app.get("/api/search", async (c) => {
    const query = c.req.query("q");
    if (!query) return c.json({ error: "missing query" }, 400);
    const notes: SearchableNote[] = [];
    for (const { name } of await listNotes(dataDir)) {
      const text = await readNote(dataDir, name);
      if (text === undefined) continue;
      const parsed = parseNote(text);
      if (parsed.ok) notes.push({ file: name, note: parsed.note });
    }
    return c.json({ hits: searchNotes(notes, query) });
  });

  return app;
}
