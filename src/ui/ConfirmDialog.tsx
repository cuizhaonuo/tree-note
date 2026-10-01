// 需要确认的危险操作（删除结点、删除笔记）：确认按钮默认聚焦，Esc 或点击遮罩取消。

import type { ReactNode } from "react";

export function ConfirmDialog({
  message,
  confirmLabel,
  onConfirm,
  onCancel,
}: {
  message: ReactNode;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div
        className="dialog"
        role="alertdialog"
        aria-labelledby="confirm-dialog-message"
        onKeyDown={(e) => {
          // 打开着的画布在 window 上监听按键：在确认按钮上按 Enter 不能再新建结点。
          e.stopPropagation();
          if (e.key === "Escape") {
            e.preventDefault();
            onCancel();
          }
        }}
      >
        <p id="confirm-dialog-message">{message}</p>
        <div className="dialog-actions">
          <button onClick={onCancel}>取消</button>
          <button className="danger" autoFocus onClick={onConfirm}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
