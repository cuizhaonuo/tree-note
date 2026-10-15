# 上线部署

把本地修改发布到 https://treenote.site 的完整流程（本地开发机执行）：

1. **验证**：确认 `npm test` 与 `npm run typecheck` 通过；本地起服务检查功能（`DATA_DIR=.dev-data npx tsx src/server/index.ts`，访问 http://localhost:8899）。
2. **提交并推送**：
   ```bash
   git push origin main
   ```
3. **远程部署**：登录服务器执行一条命令的部署脚本（拉代码、npm ci、构建、重启 systemd 服务、健康检查）：
   ```bash
   ssh ubuntu@49.233.15.228 /opt/tree-note/deploy/deploy.sh
   ```
   成功时最后输出 `部署完成：<commit>`。
4. **线上验证**：`curl -s https://treenote.site/` 应返回 200；按本次改动内容做一次功能抽查。

## 相关文件

- `deploy/deploy.sh` — 服务器上的部署脚本（被远程调用）
- `deploy/setup-server.sh`、`deploy/wizard.sh` — 首次初始化服务器用，日常部署不需要
- `deploy/Caddyfile`、`deploy/tree-note.service`、`/etc/tree-note/tree-note.env`（服务器上）— HTTPS 与服务配置
- `deploy/create-admin.sh` — 在服务器上创建管理员账号
- 排查日志：`ssh ubuntu@49.233.15.228 journalctl -u tree-note -n 50`
