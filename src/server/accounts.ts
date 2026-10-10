// 账号与会话：数据目录下的一个 SQLite 文件，存用户、会话和登录失败计数。时间由调用方注入，测试不用真的等待。

import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";

const scryptAsync = promisify(scrypt) as (password: string, salt: Buffer, keylen: number) => Promise<Buffer>;

const DAY = 24 * 60 * 60 * 1000;
/** 会话有效期 30 天，滚动续期。 */
export const SESSION_TTL_MS = 30 * DAY;
/** 同一用户名或同一 IP 在这段时间内连续失败这么多次，就锁定同样长的时间。 */
const LOCKOUT_WINDOW_MS = 15 * 60 * 1000;
const LOCKOUT_FAILURES = 5;
export const MIN_PASSWORD_LENGTH = 8;

export type Role = "admin" | "user";
export type UserStatus = "active" | "disabled";

export type LoginResult =
  | { ok: true; user: User; sessionId: string }
  | { ok: false; reason: "invalid" | "locked" };

export type SessionResult =
  | { ok: true; user: User; renewed: boolean }
  | { ok: false; reason: "none" | "disabled" };

export interface User {
  id: number;
  username: string;
  role: Role;
  status: UserStatus;
}

/** 管理员看到的用户：不含密码哈希，多了创建和最后登录时间（毫秒时间戳，未登录过为 null）。 */
export interface AdminUser extends User {
  createdAt: number;
  lastLoginAt: number | null;
}

const KEY_LENGTH = 64;

/** 每个密码配独立的随机盐，存成 `scrypt$<盐>$<哈希>`。 */
async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scryptAsync(password, salt, KEY_LENGTH);
  return `scrypt$${salt.toString("base64")}$${hash.toString("base64")}`;
}

async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, salt, hash] = stored.split("$");
  if (scheme !== "scrypt" || !salt || !hash) return false;
  const expected = Buffer.from(hash, "base64");
  const actual = await scryptAsync(password, Buffer.from(salt, "base64"), expected.length);
  return timingSafeEqual(actual, expected);
}

/** 库里只存会话 id 的哈希：数据目录会进 git 和备份，泄露的库不能直接拿来登录。 */
function hashSessionId(sessionId: string): string {
  return createHash("sha256").update(sessionId).digest("hex");
}

interface UserRow {
  id: number;
  username: string;
  password_hash: string;
  role: Role;
  status: UserStatus;
  created_at: number;
  last_login_at: number | null;
}

function toUser(row: UserRow): User {
  return { id: row.id, username: row.username, role: row.role, status: row.status };
}

export function openAccounts(dataDir: string, now: () => number = Date.now) {
  const db = new DatabaseSync(path.join(dataDir, "accounts.db"));
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY,
      username TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('admin', 'user')),
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
      created_at INTEGER NOT NULL,
      last_login_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS login_failures (
      key TEXT PRIMARY KEY,
      count INTEGER NOT NULL,
      first_at INTEGER NOT NULL,
      locked_until INTEGER
    );
  `);

  /** 用户名不存在时拿来比对的哈希（Promise，首次登录时才等它算完）。 */
  const dummyPasswordHash = hashPassword(randomBytes(16).toString("hex"));

  /** 会话连同它的用户；会话不存在时返回 undefined。 */
  const sessionWithUser = (key: string) =>
    db
      .prepare("SELECT users.*, sessions.expires_at FROM sessions JOIN users ON users.id = sessions.user_id WHERE sessions.id = ?")
      .get(key) as (UserRow & { expires_at: number }) | undefined;

  const userByName = (username: string) =>
    db.prepare("SELECT * FROM users WHERE username = ?").get(username) as UserRow | undefined;

  const isLocked = (key: string) => {
    const row = db.prepare("SELECT locked_until FROM login_failures WHERE key = ?").get(key) as
      | { locked_until: number | null }
      | undefined;
    return row?.locked_until != null && row.locked_until > now();
  };

  /** 记一次失败：超出窗口的旧计数作废重新计；满 5 次就锁定，计数归零。 */
  const recordFailure = (key: string) => {
    const row = db.prepare("SELECT count, first_at FROM login_failures WHERE key = ?").get(key) as
      | { count: number; first_at: number }
      | undefined;
    const fresh = !row || row.first_at + LOCKOUT_WINDOW_MS <= now();
    const count = fresh ? 1 : row.count + 1;
    const firstAt = fresh ? now() : row.first_at;
    const lockedUntil = count >= LOCKOUT_FAILURES ? now() + LOCKOUT_WINDOW_MS : null;
    db.prepare(
      "INSERT OR REPLACE INTO login_failures (key, count, first_at, locked_until) VALUES (?, ?, ?, ?)",
    ).run(key, lockedUntil === null ? count : 0, firstAt, lockedUntil);
  };

  const deleteUserSessions = (userId: number) => {
    db.prepare("DELETE FROM sessions WHERE user_id = ?").run(userId);
  };

  const createSession = (userId: number) => {
    const sessionId = randomBytes(32).toString("base64url");
    db.prepare("INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)").run(
      hashSessionId(sessionId),
      userId,
      now() + SESSION_TTL_MS,
    );
    return sessionId;
  };

  return {
    /** 新建用户，状态为启用；用户名重复（不分大小写）时抛出 SQLite 的唯一约束错误。 */
    async createUser(username: string, password: string, role: Role): Promise<User> {
      const passwordHash = await hashPassword(password);
      db.prepare("INSERT INTO users (username, password_hash, role, created_at) VALUES (?, ?, ?, ?)").run(
        username,
        passwordHash,
        role,
        now(),
      );
      return toUser(userByName(username)!);
    },

    /**
     * 登录：用户名或 IP 被锁定时，即使密码正确也拒绝；失败同时计入用户名和 IP；
     * 被禁用的用户不能登录，和密码错误一样处理，不透露密码其实是对的；
     * 成功时清零这个用户名的失败计数，新建会话并记下登录时间。
     */
    async login(username: string, password: string, ip: string): Promise<LoginResult> {
      const lockoutKeys = [`user:${username.toLowerCase()}`, `ip:${ip}`];
      if (lockoutKeys.some(isLocked)) return { ok: false, reason: "locked" };
      const row = userByName(username);
      // 用户名不存在时也算一遍哈希，响应时间不暴露用户名是否存在。
      const passwordHash = row?.password_hash ?? (await dummyPasswordHash);
      if (!(await verifyPassword(password, passwordHash)) || !row || row.status === "disabled") {
        lockoutKeys.forEach(recordFailure);
        return { ok: false, reason: "invalid" };
      }
      db.prepare("DELETE FROM login_failures WHERE key = ?").run(lockoutKeys[0]);
      db.prepare("UPDATE users SET last_login_at = ? WHERE id = ?").run(now(), row.id);
      return { ok: true, user: toUser(row), sessionId: createSession(row.id) };
    },

    /**
     * 用会话 id 找回登录用户，每次请求都检查用户状态：被禁用的用户删掉全部会话并拒绝，即使会话还在；
     * 会话不存在或已过期时拒绝（过期的顺手删掉）。剩余有效期不足一半时续期为 30 天，
     * `renewed` 告诉调用方要重新下发 cookie，其余时候不写库。
     */
    resumeSession(sessionId: string): SessionResult {
      const key = hashSessionId(sessionId);
      const row = sessionWithUser(key);
      if (!row) return { ok: false, reason: "none" };
      if (row.status === "disabled") {
        deleteUserSessions(row.id);
        return { ok: false, reason: "disabled" };
      }
      if (row.expires_at <= now()) {
        db.prepare("DELETE FROM sessions WHERE id = ?").run(key);
        return { ok: false, reason: "none" };
      }
      const renewed = row.expires_at - now() < SESSION_TTL_MS / 2;
      if (renewed) db.prepare("UPDATE sessions SET expires_at = ? WHERE id = ?").run(now() + SESSION_TTL_MS, key);
      return { ok: true, user: toUser(row), renewed };
    },

    /** 退出登录：删除这一个会话。 */
    deleteSession(sessionId: string): void {
      db.prepare("DELETE FROM sessions WHERE id = ?").run(hashSessionId(sessionId));
    },

    /** 删除这个用户的全部会话：重置密码、禁用用户时用，所有设备上的登录立即失效。 */
    deleteUserSessions,

    /** 用旧密码修改当前会话所属用户的密码；成功后删除这个用户除当前会话以外的所有会话。 */
    async changePassword(
      sessionId: string,
      oldPassword: string,
      newPassword: string,
    ): Promise<"ok" | "wrong-old-password" | "too-short"> {
      const key = hashSessionId(sessionId);
      const row = sessionWithUser(key);
      if (!row || !(await verifyPassword(oldPassword, row.password_hash))) return "wrong-old-password";
      if (newPassword.length < MIN_PASSWORD_LENGTH) return "too-short";
      db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(await hashPassword(newPassword), row.id);
      db.prepare("DELETE FROM sessions WHERE user_id = ? AND id <> ?").run(row.id, key);
      return "ok";
    },

    /** 按用户名（不分大小写）查用户。 */
    findUser(username: string): User | undefined {
      const row = userByName(username);
      return row && toUser(row);
    },

    /** 全部用户（不含密码哈希），给管理员列表用。 */
    listUsers(): AdminUser[] {
      const rows = db.prepare("SELECT * FROM users ORDER BY id").all() as unknown as UserRow[];
      return rows.map((row) => ({ ...toUser(row), createdAt: row.created_at, lastLoginAt: row.last_login_at }));
    },

    /** 设置启用/禁用状态；禁用时删除全部会话，所有设备上的登录立即失效。 */
    setStatus(userId: number, status: UserStatus): void {
      db.prepare("UPDATE users SET status = ? WHERE id = ?").run(status, userId);
      if (status === "disabled") deleteUserSessions(userId);
    },

    /** 管理员重置密码：重新哈希并删除这个用户的全部会话。 */
    async resetPassword(userId: number, newPassword: string): Promise<void> {
      db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(await hashPassword(newPassword), userId);
      deleteUserSessions(userId);
    },

    /** 修改用户角色。 */
    setRole(userId: number, role: Role): void {
      db.prepare("UPDATE users SET role = ? WHERE id = ?").run(role, userId);
    },

    /** 关闭数据库连接。 */
    close(): void {
      db.close();
    },
  };
}

export type Accounts = ReturnType<typeof openAccounts>;
