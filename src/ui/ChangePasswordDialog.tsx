// 修改密码对话框：错误消息直接用服务器返回的原文（“旧密码错误”等）。

import { useState, type FormEvent } from "react";
import { changePassword, HttpError } from "./api";

export function ChangePasswordDialog({ onClose }: { onClose: () => void }) {
  const [oldPassword, setOldPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await changePassword(oldPassword, newPassword);
      setDone(true);
    } catch (err) {
      setError(err instanceof HttpError ? err.message : `无法修改密码：${String(err)}`);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      {done ? (
        <div className="dialog" onKeyDown={(e) => e.key === "Escape" && onClose()}>
          <p>密码已修改，其他设备需要重新登录。</p>
          <div className="dialog-actions">
            <button autoFocus onClick={onClose}>
              关闭
            </button>
          </div>
        </div>
      ) : (
        <form className="dialog" onSubmit={submit} onKeyDown={(e) => e.key === "Escape" && onClose()}>
          <label htmlFor="old-password">当前密码</label>
          <input
            id="old-password"
            type="password"
            autoFocus
            autoComplete="current-password"
            value={oldPassword}
            onChange={(e) => setOldPassword(e.target.value)}
          />
          <label htmlFor="new-password">新密码（至少 8 个字符）</label>
          <input
            id="new-password"
            type="password"
            autoComplete="new-password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
          />
          {error && <div className="error">{error}</div>}
          <div className="dialog-actions">
            <button type="button" onClick={onClose}>
              取消
            </button>
            <button type="submit" disabled={submitting || !oldPassword || !newPassword}>
              {submitting ? "修改中…" : "修改密码"}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
