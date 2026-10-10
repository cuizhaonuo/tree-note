import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openAccounts, type Accounts } from "./accounts";
import { createApp } from "./app";

const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;

describe("auth api", () => {
  let dir: string;
  let now: number;
  let accounts: Accounts;
  let app: ReturnType<typeof createApp>;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "tree-note-auth-"));
    now = Date.parse("2026-01-01T00:00:00Z");
    accounts = openAccounts(dir, () => now);
    app = createApp(dir, accounts);
    await accounts.createUser("alice", "alice-password", "admin");
  });

  afterEach(async () => {
    accounts.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  const login = (username: string, password: string, ip = "10.0.0.1") =>
    app.request("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Forwarded-For": ip },
      body: JSON.stringify({ username, password }),
    });

  /** 从 Set-Cookie 里取出 `name=value`，用作后续请求的 Cookie 头。 */
  const sessionCookie = (res: Response) => res.headers.get("Set-Cookie")?.split(";")[0] ?? "";

  const me = (cookie: string) => app.request("/api/me", { headers: { Cookie: cookie } });

  it("logs in with the right password and returns the current user", async () => {
    const res = await login("alice", "alice-password");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ username: "alice", role: "admin" });

    const setCookie = res.headers.get("Set-Cookie") ?? "";
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=Lax/i);
    expect(setCookie).not.toMatch(/Secure/i);
    expect(setCookie).toMatch(/Max-Age=2592000/);

    const current = await me(sessionCookie(res));
    expect(current.status).toBe(200);
    expect(await current.json()).toEqual({ username: "alice", role: "admin" });
  });

  it("gives the same error for a wrong password and an unknown username", async () => {
    const wrongPassword = await login("alice", "nope");
    const unknownUser = await login("bob", "alice-password");
    expect(wrongPassword.status).toBe(401);
    expect(unknownUser.status).toBe(401);
    expect(await wrongPassword.json()).toEqual({ error: "用户名或密码错误" });
    expect(await unknownUser.json()).toEqual({ error: "用户名或密码错误" });
    expect(wrongPassword.headers.get("Set-Cookie")).toBeNull();
  });

  it("locks a username for 15 minutes after 5 failures, even with the right password", async () => {
    for (let i = 0; i < 5; i++) {
      expect((await login("alice", "nope", `10.0.1.${i}`)).status).toBe(401);
    }
    const locked = await login("alice", "alice-password", "10.0.2.1");
    expect(locked.status).toBe(429);
    expect(await locked.json()).toEqual({ error: "登录失败次数过多，请稍后再试" });
    expect(locked.headers.get("Set-Cookie")).toBeNull();

    now += 14 * MINUTE;
    expect((await login("alice", "alice-password", "10.0.2.1")).status).toBe(429);

    now += 1 * MINUTE;
    expect((await login("alice", "alice-password", "10.0.2.1")).status).toBe(200);
  });

  it("does not lock when the 5 failures are spread over more than 15 minutes", async () => {
    for (let i = 0; i < 4; i++) {
      expect((await login("alice", "nope", `10.0.1.${i}`)).status).toBe(401);
    }
    now += 16 * MINUTE;
    expect((await login("alice", "nope", "10.0.1.9")).status).toBe(401);
    expect((await login("alice", "alice-password", "10.0.2.1")).status).toBe(200);
  });

  it("locks an IP for 15 minutes after 5 failures across usernames", async () => {
    await accounts.createUser("bob", "bob-password", "user");
    for (let i = 0; i < 5; i++) {
      expect((await login(`guess${i}`, "nope", "10.9.9.9")).status).toBe(401);
    }
    expect((await login("bob", "bob-password", "10.9.9.9")).status).toBe(429);
    expect((await login("bob", "bob-password", "10.0.0.2")).status).toBe(200);

    now += 15 * MINUTE;
    expect((await login("alice", "alice-password", "10.9.9.9")).status).toBe(200);
  });

  it("clears the username's failure count on a successful login", async () => {
    for (let i = 0; i < 4; i++) await login("alice", "nope", `10.0.1.${i}`);
    expect((await login("alice", "alice-password", "10.0.2.1")).status).toBe(200);
    for (let i = 0; i < 4; i++) await login("alice", "nope", `10.0.3.${i}`);
    expect((await login("alice", "alice-password", "10.0.2.1")).status).toBe(200);
  });

  it("does not renew a session with more than half its 30 days left, so it expires on time", async () => {
    const cookie = sessionCookie(await login("alice", "alice-password"));

    now += 10 * DAY;
    const early = await me(cookie);
    expect(early.status).toBe(200);
    expect(early.headers.get("Set-Cookie")).toBeNull();

    now += 20 * DAY;
    expect((await me(cookie)).status).toBe(401);
  });

  it("renews a session for another 30 days once less than half is left", async () => {
    const cookie = sessionCookie(await login("alice", "alice-password"));

    now += 16 * DAY;
    const renewed = await me(cookie);
    expect(renewed.status).toBe(200);
    expect(renewed.headers.get("Set-Cookie")).toMatch(/Max-Age=2592000/);

    now += 29 * DAY;
    expect((await me(cookie)).status).toBe(200);
  });

  it("logs out by deleting only the current session", async () => {
    const first = sessionCookie(await login("alice", "alice-password"));
    const second = sessionCookie(await login("alice", "alice-password"));

    const res = await app.request("/api/logout", { method: "POST", headers: { Cookie: first } });
    expect(res.status).toBe(200);
    expect(res.headers.get("Set-Cookie")).toMatch(/Max-Age=0/);

    expect((await me(first)).status).toBe(401);
    expect((await me(second)).status).toBe(200);
  });

  /** 绕过接口直接改库里的用户状态，模拟会话还在时用户已被禁用（比如在服务器上手动改库）。 */
  const disableInDatabase = (username: string) => {
    const db = new DatabaseSync(path.join(dir, "accounts.db"));
    db.prepare("UPDATE users SET status = 'disabled' WHERE username = ?").run(username);
    db.close();
  };

  it("rejects every request from a disabled user even though the session still exists", async () => {
    const cookie = sessionCookie(await login("alice", "alice-password"));
    disableInDatabase("alice");

    const res = await me(cookie);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "账号已被禁用" });
    expect((await app.request("/api/notes", { headers: { Cookie: cookie } })).status).toBe(401);
  });

  it("refuses to log in a disabled user with the same error as a wrong password", async () => {
    disableInDatabase("alice");
    const res = await login("alice", "alice-password");
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "用户名或密码错误" });
    expect(res.headers.get("Set-Cookie")).toBeNull();
  });

  it("can delete all of a user's sessions", async () => {
    const first = sessionCookie(await login("alice", "alice-password"));
    const second = sessionCookie(await login("alice", "alice-password"));
    const alice = accounts.findUser("alice")!;

    accounts.deleteUserSessions(alice.id);
    expect((await me(first)).status).toBe(401);
    expect((await me(second)).status).toBe(401);
  });

  const changePassword = (cookie: string, body: unknown) =>
    app.request("/api/password", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify(body),
    });

  it("changes the password with the old one and ends every other session", async () => {
    const here = sessionCookie(await login("alice", "alice-password"));
    const elsewhere = sessionCookie(await login("alice", "alice-password"));

    const res = await changePassword(here, { oldPassword: "alice-password", newPassword: "new-password" });
    expect(res.status).toBe(200);

    expect((await me(here)).status).toBe(200);
    expect((await me(elsewhere)).status).toBe(401);
    expect((await login("alice", "alice-password")).status).toBe(401);
    expect((await login("alice", "new-password")).status).toBe(200);
  });

  it("refuses to change the password without the right old one", async () => {
    const here = sessionCookie(await login("alice", "alice-password"));
    const elsewhere = sessionCookie(await login("alice", "alice-password"));

    const res = await changePassword(here, { oldPassword: "nope", newPassword: "new-password" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "旧密码错误" });
    expect((await me(elsewhere)).status).toBe(200);
    expect((await login("alice", "alice-password")).status).toBe(200);
  });

  it("refuses a new password shorter than 8 characters", async () => {
    const here = sessionCookie(await login("alice", "alice-password"));
    const res = await changePassword(here, { oldPassword: "alice-password", newPassword: "short" });
    expect(res.status).toBe(400);
    expect((await login("alice", "alice-password")).status).toBe(200);
  });
});
