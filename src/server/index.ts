// 服务入口：用环境变量里的数据目录、监听地址和端口启动 HTTP 服务，同时提供 `dist/` 里构建好的前端。
// 默认只监听本机：生产环境由 Caddy 转发，登录按 IP 锁定信任 X-Forwarded-For，不能让外部绕过 Caddy 直连伪造它。

import { mkdir } from "node:fs/promises";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { openAccounts } from "./accounts";
import { createApp } from "./app";

const dataDir = process.env.DATA_DIR ?? ".dev-data";
const hostname = process.env.HOST ?? "127.0.0.1";
const port = Number(process.env.PORT ?? 8899);

await mkdir(dataDir, { recursive: true });
const app = createApp(dataDir, openAccounts(dataDir));
// 前端静态文件；开发时没有 dist/ 也无妨，前端由 vite 提供。相对路径以启动时的工作目录（仓库根目录）为准。
app.use("/*", serveStatic({ root: "./dist" }));
serve({ fetch: app.fetch, hostname, port }, (info) => {
  console.log(`tree-note listening on http://${hostname}:${info.port}, data dir: ${dataDir}`);
});
