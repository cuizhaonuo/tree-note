// 管理页：用户列表（含笔记数量和占用空间，不含笔记内容）、新建用户、按行的重置密码/禁用启用/修改角色。
// 针对自己的禁用、改角色不渲染，服务器也会拒绝；重置自己的密码是允许的（重置后自己的会话也会失效）。

import { useEffect, useState, type FormEvent } from "react";
import type { Role } from "../server/accounts";
import * as api from "./api";
import { HttpError } from "./api";

export function AdminPage({ user }: { user: api.AuthUser }) {
  const [users, setUsers] = useState<api.AdminUser[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [resetTarget, setResetTarget] = useState<string | null>(null);

  function refresh() {
    return api.adminListUsers().then(setUsers, (e: unknown) => setError(`无法读取用户列表：${String(e)}`));
  }
  useEffect(() => {
    refresh();
  }, []);

  async function run(action: () => Promise<unknown>, prefix: string) {
    try {
      await action();
      setError(null);
      await refresh();
    } catch (e) {
      setError(e instanceof HttpError ? e.message : `${prefix}：${String(e)}`);
    }
  }

  return (
    <div className="admin-page">
      <div className="admin-header">
        <h2>用户管理</h2>
      </div>
      {error && <div className="error">{error}</div>}
      <button onClick={() => setCreating(true)}>新建用户</button>
      {users === null && !error && <div className="empty">读取用户列表…</div>}
      {users !== null && (
        <table className="admin-users">
          <thead>
            <tr>
              <th>用户名</th>
              <th>角色</th>
              <th>状态</th>
              <th>创建时间</th>
              <th>最后登录</th>
              <th>笔记数量</th>
              <th>占用空间</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => {
              const isSelf = u.username === user.username;
              return (
                <tr key={u.username}>
                  <td>{u.username}</td>
                  <td>{roleLabel(u.role)}</td>
                  <td>{u.status === "active" ? "正常" : "已禁用"}</td>
                  <td>{formatTime(u.createdAt)}</td>
                  <td>{u.lastLoginAt === null ? "从未登录" : formatTime(u.lastLoginAt)}</td>
                  <td>{u.noteCount}</td>
                  <td>{formatBytes(u.diskBytes)}</td>
                  <td>
                    <button onClick={() => setResetTarget(u.username)}>重置密码</button>
                    {!isSelf && (
                      <>
                        <button onClick={() => run(() => api.adminSetStatus(u.username, u.status === "active" ? "disabled" : "active"), "无法修改状态")}>
                          {u.status === "active" ? "禁用" : "启用"}
                        </button>
                        <button onClick={() => run(() => api.adminSetRole(u.username, u.role === "admin" ? "user" : "admin"), "无法修改角色")}>
                          {u.role === "admin" ? "设为普通用户" : "设为管理员"}
                        </button>
                      </>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {creating && <CreateUserDialog onClose={() => setCreating(false)} onCreated={() => { setCreating(false); refresh(); }} />}
      {resetTarget && <ResetPasswordDialog username={resetTarget} onClose={() => setResetTarget(null)} />}
    </div>
  );
}

function CreateUserDialog({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<Role>("user");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await api.adminCreateUser(username.trim(), password, role);
      onCreated();
    } catch (err) {
      // 服务器消息原文显示，用户名重复（409）等错误用户能直接看懂。
      setError(err instanceof HttpError ? err.message : `无法新建用户：${String(err)}`);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form className="dialog" onSubmit={submit} onKeyDown={(e) => e.key === "Escape" && onClose()}>
        <label htmlFor="new-user-name">用户名</label>
        <input id="new-user-name" autoFocus value={username} onChange={(e) => setUsername(e.target.value)} />
        <label htmlFor="new-user-password">初始密码（至少 8 个字符）</label>
        <input id="new-user-password" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        <label htmlFor="new-user-role">角色</label>
        <select id="new-user-role" value={role} onChange={(e) => setRole(e.target.value as Role)}>
          <option value="user">普通用户</option>
          <option value="admin">管理员</option>
        </select>
        {error && <div className="error">{error}</div>}
        <div className="dialog-actions">
          <button type="button" onClick={onClose}>
            取消
          </button>
          <button type="submit" disabled={submitting || !username.trim() || !password}>
            {submitting ? "创建中…" : "创建"}
          </button>
        </div>
      </form>
    </div>
  );
}

function ResetPasswordDialog({ username, onClose }: { username: string; onClose: () => void }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await api.adminResetPassword(username, password);
      setDone(true);
    } catch (err) {
      setError(err instanceof HttpError ? err.message : `无法重置密码：${String(err)}`);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      {done ? (
        <div className="dialog" onKeyDown={(e) => e.key === "Escape" && onClose()}>
          <p>已重置 {username} 的密码，该用户需要重新登录。</p>
          <div className="dialog-actions">
            <button autoFocus onClick={onClose}>
              关闭
            </button>
          </div>
        </div>
      ) : (
        <form className="dialog" onSubmit={submit} onKeyDown={(e) => e.key === "Escape" && onClose()}>
          <label htmlFor="reset-password">为 {username} 设置新密码（至少 8 个字符）</label>
          <input
            id="reset-password"
            type="password"
            autoFocus
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          {error && <div className="error">{error}</div>}
          <div className="dialog-actions">
            <button type="button" onClick={onClose}>
              取消
            </button>
            <button type="submit" disabled={submitting || !password}>
              {submitting ? "重置中…" : "重置密码"}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

function roleLabel(role: Role): string {
  return role === "admin" ? "管理员" : "普通用户";
}

function formatTime(ms: number): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}
