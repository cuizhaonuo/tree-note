// 服务入口：用环境变量里的数据目录、监听地址和端口启动 HTTP 服务。
// 默认只监听本机：生产环境由 Caddy 转发，登录按 IP 锁定信任 X-Forwarded-For，不能让外部绕过 Caddy 直连伪造它。

import { mkdir } from "node:fs/promises";
import { serve } from "@hono/node-server";
import { openAccounts } from "./accounts";
import { createApp } from "./app";

const dataDir = process.env.DATA_DIR ?? ".dev-data";
const hostname = process.env.HOST ?? "127.0.0.1";
const port = Number(process.env.PORT ?? 8899);

await mkdir(dataDir, { recursive: true });
serve({ fetch: createApp(dataDir, openAccounts(dataDir)).fetch, hostname, port }, (info) => {
  console.log(`notes api listening on http://${hostname}:${info.port}, data dir: ${dataDir}`);
});
