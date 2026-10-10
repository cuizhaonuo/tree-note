import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openAccounts, type Accounts } from "./accounts";
import { createApp } from "./app";

/** 登录并返回会话 cookie（`name=value`），用作后续请求的 Cookie 头。 */
async function loginCookie(app: ReturnType<typeof createApp>, username: string, password: string): Promise<string> {
  const res = await app.request("/api/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  return res.headers.get("Set-Cookie")!.split(";")[0];
}

describe("admin api", () => {
  let root: string;
  let accounts: Accounts;
  let app: ReturnType<typeof createApp>;
  const withCookie =
    (cookie: string) =>
    (url: string, init: RequestInit = {}) =>
      app.request(url, { ...init, headers: { ...(init.headers as Record<string, string>), Cookie: cookie } });
  let asAdmin: ReturnType<typeof withCookie>;
  let asAlice: ReturnType<typeof withCookie>;
  let aliceId: number;

  const post = (req: ReturnType<typeof withCookie>, url: string, body: unknown) =>
    req(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "tree-note-admin-"));
    accounts = openAccounts(root);
    app = createApp(root, accounts);
    await accounts.createUser("admin", "admin-password", "admin");
    const alice = await accounts.createUser("alice", "alice-password", "user");
    aliceId = alice.id;
    asAdmin = withCookie(await loginCookie(app, "admin", "admin-password"));
    asAlice = withCookie(await loginCookie(app, "alice", "alice-password"));
  });

  afterEach(async () => {
    accounts.close();
    await fs.rm(root, { recursive: true, force: true });
  });

  const ADMIN_ROUTES: Array<[string, string, unknown?]> = [
    ["GET", "/api/admin/users"],
    ["POST", "/api/admin/users", { username: "x", password: "x-password", role: "user" }],
    ["POST", "/api/admin/users/alice/password", { password: "new-password" }],
    ["POST", "/api/admin/users/alice/status", { status: "disabled" }],
    ["POST", "/api/admin/users/alice/role", { role: "admin" }],
  ];

  it("returns 403 for a logged-in non-admin on every admin route", async () => {
    for (const [method, url, body] of ADMIN_ROUTES) {
      const res = await asAlice(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      expect(res.status, `${method} ${url}`).toBe(403);
    }
  });

  it("returns 401 for unauthenticated requests on every admin route", async () => {
    for (const [method, url, body] of ADMIN_ROUTES) {
      const res = await app.request(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      expect(res.status, `${method} ${url}`).toBe(401);
    }
  });

  it("lists users with noteCount/diskBytes computed from real files on disk", async () => {
    const aliceDir = path.join(root, "users", String(aliceId));
    await fs.mkdir(aliceDir, { recursive: true });
    const a = "# 日记\n\n- [事件 2026-01-01 10:00] 第一条\n";
    const b = "# 周报\n\n- [想法 2026-01-02 11:00] 内容内容\n";
    await fs.writeFile(path.join(aliceDir, "日记.md"), a);
    await fs.writeFile(path.join(aliceDir, "周报.md"), b);
    await fs.writeFile(path.join(aliceDir, "不是笔记.txt"), "ignored");
    const expectedBytes = Buffer.byteLength(a) + Buffer.byteLength(b);

    const res = await asAdmin("/api/admin/users");
    expect(res.status).toBe(200);
    const users = await res.json();
    expect(users).toHaveLength(2);
    const admin = users.find((u: { username: string }) => u.username === "admin");
    const alice = users.find((u: { username: string }) => u.username === "alice");
    expect(alice).toMatchObject({ username: "alice", role: "user", status: "active", noteCount: 2, diskBytes: expectedBytes });
    expect(typeof alice.createdAt).toBe("number");
    expect(alice.lastLoginAt === null || typeof alice.lastLoginAt === "number").toBe(true);
    // admin 还没有笔记目录：计数为 0。
    expect(admin).toMatchObject({ noteCount: 0, diskBytes: 0 });
  });

  it("creates a user and rejects a duplicate username (case-insensitive) with 409", async () => {
    const created = await post(asAdmin, "/api/admin/users", { username: "bob", password: "bob-password", role: "user" });
    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({ username: "bob", role: "user", status: "active" });

    const login = await app.request("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "bob", password: "bob-password" }),
    });
    expect(login.status).toBe(200);

    const dup = await post(asAdmin, "/api/admin/users", { username: "BOB", password: "other-password", role: "user" });
    expect(dup.status).toBe(409);
    expect((await dup.json()).error).toContain("用户名");
  });

  it("reset password invalidates existing sessions and the new password works", async () => {
    const res = await post(asAdmin, "/api/admin/users/alice/password", { password: "alice-new-password" });
    expect(res.status).toBe(200);

    // 旧会话立即失效。
    expect((await asAlice("/api/me")).status).toBe(401);
    // 旧密码不能登录，新密码可以。
    const oldLogin = await app.request("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "alice", password: "alice-password" }),
    });
    expect(oldLogin.status).toBe(401);
    const newLogin = await app.request("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "alice", password: "alice-new-password" }),
    });
    expect(newLogin.status).toBe(200);
  });

  it("disable rejects the user's session and fresh logins; re-enable restores login; notes stay on disk", async () => {
    const aliceDir = path.join(root, "users", String(aliceId));
    await fs.mkdir(aliceDir, { recursive: true });
    await fs.writeFile(path.join(aliceDir, "日记.md"), "# 日记\n\n- [事件 2026-01-01 10:00] 保留我\n");

    const res = await post(asAdmin, "/api/admin/users/alice/status", { status: "disabled" });
    expect(res.status).toBe(200);

    // 已有会话立即失效，重新登录也被拒绝。
    expect((await asAlice("/api/me")).status).toBe(401);
    const login = await app.request("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "alice", password: "alice-password" }),
    });
    expect(login.status).toBe(401);

    // 笔记文件还在。
    expect(await fs.readFile(path.join(aliceDir, "日记.md"), "utf8")).toContain("保留我");

    const enable = await post(asAdmin, "/api/admin/users/alice/status", { status: "active" });
    expect(enable.status).toBe(200);
    const relogin = await app.request("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "alice", password: "alice-password" }),
    });
    expect(relogin.status).toBe(200);
  });

  it("changing role works for another user; admins cannot disable themselves or change their own role", async () => {
    const promote = await post(asAdmin, "/api/admin/users/alice/role", { role: "admin" });
    expect(promote.status).toBe(200);
    expect(accounts.findUser("alice")!.role).toBe("admin");

    const disableSelf = await post(asAdmin, "/api/admin/users/admin/status", { status: "disabled" });
    expect(disableSelf.status).toBe(400);
    const roleSelf = await post(asAdmin, "/api/admin/users/admin/role", { role: "user" });
    expect(roleSelf.status).toBe(400);
    // 自己仍然能正常操作。
    expect((await asAdmin("/api/admin/users")).status).toBe(200);
  });

  it("no admin route response contains note file contents", async () => {
    const SECRET = "# 秘密\n\n- [事件 2026-01-01 10:00] alice 的绝密内容\n";
    const aliceDir = path.join(root, "users", String(aliceId));
    await fs.mkdir(aliceDir, { recursive: true });
    await fs.writeFile(path.join(aliceDir, "秘密.md"), SECRET);

    const list = await asAdmin("/api/admin/users");
    expect(await list.text()).not.toContain("绝密内容");
    for (const [url, body] of [
      ["/api/admin/users/alice/status", { status: "disabled" }],
      ["/api/admin/users/alice/role", { role: "admin" }],
      ["/api/admin/users/alice/password", { password: "whatever-new-password" }],
    ] as const) {
      const res = await post(asAdmin, url, body);
      expect(await res.text()).not.toContain("绝密内容");
    }
  });
});
