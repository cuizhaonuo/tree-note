// 登录状态的门卫：进入时先问服务器当前有没有登录（api.me），
// 未登录显示全屏登录页，已登录显示 App。
// 会话中途失效（任何接口 401，由 api.onUnauthorized 上报）时 App 保持挂载，
// 上面盖一层登录遮罩——编辑器里没保存的内容和自动保存会话都还在，
// 重新登录后 flushSaves 继续写。

import { useCallback, useEffect, useState } from "react";
import { App } from "./App";
import * as api from "./api";
import { flushSaves, setCurrentUser } from "./autosave";
import { LoginPage } from "./LoginPage";

export function SessionGate() {
  // undefined = 还在问服务器；null = 未登录。
  const [user, setUser] = useState<api.AuthUser | null | undefined>(undefined);
  // 启动时问服务器失败（不是 401，而是服务器不在）的消息；401 才是未登录。
  const [bootError, setBootError] = useState<string | null>(null);
  // 点“重试”加一，重新问服务器。
  const [bootAttempt, setBootAttempt] = useState(0);
  // 会话中途失效时服务器给的消息；非空时盖登录遮罩。
  const [sessionLost, setSessionLost] = useState<string | null>(null);
  // 重新登录一次就加一，传给 App 让它刷新笔记列表。
  const [epoch, setEpoch] = useState(0);

  useEffect(() => {
    let alive = true;
    api.me().then(
      (me) => {
        if (!alive) return;
        setCurrentUser(me.username);
        setUser(me);
      },
      (e: unknown) => {
        if (!alive) return;
        // 401 才是“未登录”；别的错误（比如服务器没启动）不能当成未登录，要报出来。
        if (e instanceof api.HttpError && e.status === 401) setUser(null);
        else setBootError(`无法连接服务器：${String(e)}`);
      },
    );
    return () => {
      alive = false;
    };
  }, [bootAttempt]);

  useEffect(() => {
    api.onUnauthorized((message) => setSessionLost(message));
    return () => api.onUnauthorized(null);
  }, []);

  const onLogout = useCallback(() => {
    // 先把还没写的改动写出去；写不出去（比如会话已经失效）也照常退出。
    void flushSaves()
      .catch(() => {})
      .then(() => api.logout())
      .catch(() => {})
      .then(() => {
        setSessionLost(null);
        setUser(null);
      });
  }, []);

  if (user === undefined && bootError !== null) {
    return (
      <div className="empty login-loading">
        <div className="error">{bootError}</div>
        <button
          onClick={() => {
            setBootError(null);
            setBootAttempt((n) => n + 1);
          }}
        >
          重试
        </button>
      </div>
    );
  }

  if (user === undefined) return <div className="empty login-loading">读取登录状态…</div>;

  if (user === null) {
    return (
      <div className="login-page">
        <LoginPage
          onLogin={(loggedIn) => {
            setCurrentUser(loggedIn.username);
            setSessionLost(null);
            setUser(loggedIn);
          }}
        />
      </div>
    );
  }

  return (
    <>
      <App user={user} epoch={epoch} onLogout={onLogout} />
      {sessionLost !== null && (
        <div className="overlay">
          <LoginPage
            notice={sessionLost === "账号已被禁用" ? sessionLost : "登录已过期，请重新登录，未保存的内容已保留"}
            onLogin={(loggedIn) => {
              if (loggedIn.username !== user.username) {
                // 换成了另一个账号：没保存的暂存按用户分开（旧账号的留在旧账号名下），
                // 界面上的笔记也属于旧账号，直接重新加载最干净。
                window.location.reload();
                return;
              }
              setCurrentUser(loggedIn.username);
              setSessionLost(null);
              void flushSaves();
              setEpoch((e) => e + 1);
            }}
          />
        </div>
      )}
    </>
  );
}
