// 登录表单：全屏（还没登录）或盖在 App 上的遮罩（会话失效）两种用法。
// 错误消息直接用服务器返回的原文（“用户名或密码错误”等）。

import { useState, type FormEvent } from "react";
import { HttpError, login, type AuthUser } from "./api";

export function LoginPage({ notice, onLogin }: { notice?: string | null; onLogin: (user: AuthUser) => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      onLogin(await login(username, password));
    } catch (err) {
      setError(err instanceof HttpError ? err.message : `无法登录：${String(err)}`);
      setSubmitting(false);
    }
  }

  return (
    <form className="dialog login-form" onSubmit={submit}>
      <h2 className="login-title">登录 tree-note</h2>
      {notice && <div className="error login-notice">{notice}</div>}
      <label htmlFor="login-username">用户名</label>
      <input
        id="login-username"
        autoFocus
        autoComplete="username"
        value={username}
        onChange={(e) => setUsername(e.target.value)}
      />
      <label htmlFor="login-password">密码</label>
      <input
        id="login-password"
        type="password"
        autoComplete="current-password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
      />
      {error && <div className="error">{error}</div>}
      <div className="dialog-actions">
        <button type="submit" disabled={submitting || !username || !password}>
          {submitting ? "登录中…" : "登录"}
        </button>
      </div>
    </form>
  );
}
