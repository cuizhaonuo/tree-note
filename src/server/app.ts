// 服务器接口：登录与会话，以及当前用户的笔记（列出、读取、新建、写回含重命名、删除、全文搜索），全部返回 JSON。

import { mkdir } from "node:fs/promises";
import path from "node:path";
import { Hono } from "hono";
import type { Context } from "hono";
import { getConnInfo } from "@hono/node-server/conninfo";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { MIN_PASSWORD_LENGTH, SESSION_TTL_MS, type Accounts, type Role, type User, type UserStatus } from "./accounts";
import { isValidNoteFileName } from "../core/fileName";
import { parseNote } from "../core/format";
import { searchNotes, type SearchableNote } from "../core/search";
import { createNote, deleteNote, dirStats, listNotes, readNote, versionOf, writeNote } from "./store";

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

const SESSION_COOKIE = "session";

/**
 * 会话 cookie：只有会话 id。请求经 HTTPS 进来时加 Secure；协议看 Caddy 写的 X-Forwarded-Proto，
 * 它和 X-Forwarded-For 一样会覆盖客户端发来的值。本地开发是纯 HTTP，不加。
 */
function setSessionCookie(c: Context, sessionId: string): void {
  setCookie(c, SESSION_COOKIE, sessionId, {
    httpOnly: true,
    secure: c.req.header("X-Forwarded-Proto") === "https",
    sameSite: "Lax",
    path: "/",
    maxAge: SESSION_TTL_MS / 1000,
  });
}

/**
 * 客户端 IP：生产环境 Node 只监听本机、由 Caddy 转发。Caddy 不信任客户端发来的 X-Forwarded-For，会用真实来源覆盖它；
 * 取最后一项，以后前面再加一层代理时也是离 Node 最近的那一跳写入的；没有这个头时（直连）用 TCP 连接的对端地址。
 */
function clientIp(c: Context): string {
  const forwarded = c.req.header("X-Forwarded-For")?.split(",").pop()?.trim();
  if (forwarded) return forwarded;
  try {
    return getConnInfo(c).remote.address ?? "unknown";
  } catch {
    return "unknown";
  }
}

/** 返回给前端的当前用户：用户名和角色。 */
function publicUser(user: User): { username: string; role: User["role"] } {
  return { username: user.username, role: user.role };
}

/** 不需要登录就能访问的接口。 */
const PUBLIC_PATHS = new Set(["/api/login", "/api/logout"]);

type Env = { Variables: { user: User } };

export function createApp(dataDir: string, accounts: Accounts): Hono<Env> {
  const app = new Hono<Env>();

  // 其余所有接口都要登录：找回会话里的用户，需要续期时重新下发 cookie。
  app.use("/api/*", async (c, next) => {
    if (PUBLIC_PATHS.has(c.req.path)) return next();
    const sessionId = getCookie(c, SESSION_COOKIE);
    const session = sessionId ? accounts.resumeSession(sessionId) : undefined;
    if (session && !session.ok && session.reason === "disabled") {
      deleteCookie(c, SESSION_COOKIE, { path: "/" });
      return c.json({ error: "账号已被禁用" }, 401);
    }
    if (!sessionId || !session?.ok) return c.json({ error: "未登录" }, 401);
    if (session.renewed) setSessionCookie(c, sessionId);
    c.set("user", session.user);
    return next();
  });

  app.post("/api/login", async (c) => {
    const body = await parseBody(c);
    if (!body || typeof body.username !== "string" || typeof body.password !== "string") {
      return c.json({ error: "expected { username, password }" }, 400);
    }
    const result = await accounts.login(body.username, body.password, clientIp(c));
    if (!result.ok && result.reason === "locked") return c.json({ error: "登录失败次数过多，请稍后再试" }, 429);
    if (!result.ok) return c.json({ error: "用户名或密码错误" }, 401);
    setSessionCookie(c, result.sessionId);
    return c.json(publicUser(result.user));
  });

  app.post("/api/logout", (c) => {
    const sessionId = getCookie(c, SESSION_COOKIE);
    if (sessionId) accounts.deleteSession(sessionId);
    deleteCookie(c, SESSION_COOKIE, { path: "/" });
    return c.json({ ok: true });
  });

  app.post("/api/password", async (c) => {
    const body = await parseBody(c);
    if (!body || typeof body.oldPassword !== "string" || typeof body.newPassword !== "string") {
      return c.json({ error: "expected { oldPassword, newPassword }" }, 400);
    }
    const result = await accounts.changePassword(getCookie(c, SESSION_COOKIE)!, body.oldPassword, body.newPassword);
    if (result === "wrong-old-password") return c.json({ error: "旧密码错误" }, 400);
    if (result === "too-short") return c.json({ error: `新密码至少 ${MIN_PASSWORD_LENGTH} 个字符` }, 400);
    return c.json({ ok: true });
  });

  app.get("/api/me", (c) => {
    return c.json(publicUser(c.get("user")));
  });

  /** 当前登录用户自己的笔记目录 `<数据目录>/users/<userId>/`：笔记接口只碰这个目录，不能跨用户读写。 */
  const userDir = async (c: Context<Env>): Promise<string> => {
    const dir = path.join(dataDir, "users", String(c.get("user").id));
    await mkdir(dir, { recursive: true });
    return dir;
  };

  app.get("/api/notes", async (c) => {
    return c.json({ notes: await listNotes(await userDir(c)) });
  });

  app.get("/api/notes/:name", async (c) => {
    const name = noteName(c);
    if (!name) return c.json({ error: "invalid file name" }, 400);
    const dir = await userDir(c);
    const text = await readNote(dir, name);
    if (text === undefined) return c.json({ error: "note not found" }, 404);
    return c.json({ name, text, version: versionOf(text) });
  });

  app.post("/api/notes", async (c) => {
    const body = await parseBody(c);
    if (!body || typeof body.title !== "string" || typeof body.text !== "string") {
      return c.json({ error: "expected { title, text }" }, 400);
    }
    return c.json(await createNote(await userDir(c), body.title, body.text), 201);
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
    const dir = await userDir(c);
    const current = await readNote(dir, name);
    if (current === undefined) return c.json({ error: "note not found" }, 404);
    if (versionOf(current) !== body.version) return c.json({ error: "version conflict" }, 409);
    return c.json(await writeNote(dir, name, body.text, body.title as string | undefined));
  });

  app.delete("/api/notes/:name", async (c) => {
    const name = noteName(c);
    if (!name) return c.json({ error: "invalid file name" }, 400);
    const dir = await userDir(c);
    if (!(await deleteNote(dir, name))) return c.json({ error: "note not found" }, 404);
    return c.json({ ok: true });
  });

  // 管理接口：已登录但不是管理员的请求一律 403（未登录的在上面被 401 拦住）。
  app.use("/api/admin/*", async (c, next) => {
    if (c.get("user").role !== "admin") return c.json({ error: "需要管理员权限" }, 403);
    return next();
  });

  /** 按用户名找用户，找不到时返回 404 JSON。 */
  const targetUser = (c: Context<Env>): User | undefined => {
    const username = c.req.param("username");
    return username === undefined ? undefined : accounts.findUser(username);
  };

  app.get("/api/admin/users", async (c) => {
    const users = await Promise.all(
      accounts.listUsers().map(async ({ id, ...user }) => {
        // 只统计数量和字节数，任何接口都不能把别的用户的笔记内容交给管理员。
        const { count, bytes } = await dirStats(path.join(dataDir, "users", String(id)));
        return { ...user, noteCount: count, diskBytes: bytes };
      }),
    );
    return c.json(users);
  });

  app.post("/api/admin/users", async (c) => {
    const body = await parseBody(c);
    if (
      !body ||
      typeof body.username !== "string" ||
      typeof body.password !== "string" ||
      (body.role !== "admin" && body.role !== "user")
    ) {
      return c.json({ error: "expected { username, password, role }" }, 400);
    }
    if (body.password.length < MIN_PASSWORD_LENGTH) {
      return c.json({ error: `密码至少 ${MIN_PASSWORD_LENGTH} 个字符` }, 400);
    }
    if (accounts.findUser(body.username)) return c.json({ error: "用户名已被占用" }, 409);
    const user = await accounts.createUser(body.username, body.password, body.role);
    return c.json(user, 201);
  });

  app.post("/api/admin/users/:username/password", async (c) => {
    const user = targetUser(c);
    if (!user) return c.json({ error: "用户不存在" }, 404);
    const body = await parseBody(c);
    if (!body || typeof body.password !== "string") return c.json({ error: "expected { password }" }, 400);
    if (body.password.length < MIN_PASSWORD_LENGTH) {
      return c.json({ error: `密码至少 ${MIN_PASSWORD_LENGTH} 个字符` }, 400);
    }
    await accounts.resetPassword(user.id, body.password);
    return c.json({ ok: true });
  });

  app.post("/api/admin/users/:username/status", async (c) => {
    const user = targetUser(c);
    if (!user) return c.json({ error: "用户不存在" }, 404);
    const body = await parseBody(c);
    if (!body || (body.status !== "active" && body.status !== "disabled")) {
      return c.json({ error: "expected { status }" }, 400);
    }
    if (body.status === "disabled" && user.id === c.get("user").id) {
      return c.json({ error: "不能禁用自己" }, 400);
    }
    accounts.setStatus(user.id, body.status as UserStatus);
    return c.json({ ok: true });
  });

  app.post("/api/admin/users/:username/role", async (c) => {
    const user = targetUser(c);
    if (!user) return c.json({ error: "用户不存在" }, 404);
    const body = await parseBody(c);
    if (!body || (body.role !== "admin" && body.role !== "user")) {
      return c.json({ error: "expected { role }" }, 400);
    }
    if (user.id === c.get("user").id) return c.json({ error: "不能修改自己的角色" }, 400);
    accounts.setRole(user.id, body.role as Role);
    return c.json({ ok: true });
  });

  app.get("/api/search", async (c) => {
    const query = c.req.query("q");
    if (!query) return c.json({ error: "missing query" }, 400);
    const dir = await userDir(c);
    const notes: SearchableNote[] = [];
    for (const { name } of await listNotes(dir)) {
      const text = await readNote(dir, name);
      if (text === undefined) continue;
      const parsed = parseNote(text);
      if (parsed.ok) notes.push({ file: name, note: parsed.note });
    }
    return c.json({ hits: searchNotes(notes, query) });
  });

  return app;
}
