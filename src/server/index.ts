// 开发用入口：用环境变量里的数据目录和端口启动 HTTP 服务。

import { mkdir } from "node:fs/promises";
import { serve } from "@hono/node-server";
import { createApp } from "./app";

const dataDir = process.env.DATA_DIR ?? ".dev-data";
const port = Number(process.env.PORT ?? 8899);

await mkdir(dataDir, { recursive: true });
serve({ fetch: createApp(dataDir).fetch, port }, (info) => {
  console.log(`notes api listening on http://localhost:${info.port}, data dir: ${dataDir}`);
});
