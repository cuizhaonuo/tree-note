// 每日备份，由 systemd 定时器（deploy/tree-note-backup.timer）每天运行一次：
// 1. 用 SQLite 的备份机制把 accounts.db 导出成一致的副本 accounts.snapshot.db，再对数据目录做 git commit，没有变化就跳过；
//    正在使用的 accounts.db 不进 git（见下面的 .gitignore），历史里只有副本。
// 2. 把刚提交的数据目录（git archive HEAD，和提交的内容一致，不会打包到写了一半的文件）打包上传到 COS 私有桶，按日期命名。
//    桶上的生命周期规则负责删除 30 天前的备份。
// 任何一步失败都打印出错的步骤并以非零状态退出，systemd 把它记进日志：journalctl -u tree-note-backup。
//
// 恢复：
// - 某篇笔记：git -C <数据目录> log -- users/<id>/<文件名>，再 git checkout <提交> -- users/<id>/<文件名>。
// - 整个数据目录：从 COS 下载备份包解压到数据目录，停掉服务后把 accounts.snapshot.db 复制成 accounts.db，再启动服务。

import { execFileSync } from "node:child_process";
import { createHash, createHmac } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync, backup } from "node:sqlite";

const SNAPSHOT = "accounts.snapshot.db";
const GITIGNORE = ["/accounts.db", `/${SNAPSHOT}.tmp`, "/accounts.db-journal", "/accounts.db-wal", "/accounts.db-shm", ""].join("\n");

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`环境变量 ${name} 没有设置（/etc/tree-note/tree-note.env）`);
  return value;
}

function git(dataDir: string, ...args: string[]): string {
  return execFileSync("git", ["-C", dataDir, "-c", "user.name=tree-note backup", "-c", "user.email=backup@tree-note", ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/** 本地时区的日期，例如 2026-10-10。 */
function today(): string {
  return new Date().toLocaleDateString("sv-SE");
}

// 每次导出到新文件再替换：覆盖已有文件会让它头部的修改计数加一，数据没变也会产生一次提交。
async function snapshotDatabase(dataDir: string): Promise<void> {
  const tmpSnapshot = path.join(dataDir, `${SNAPSHOT}.tmp`);
  await rm(tmpSnapshot, { force: true });
  const db = new DatabaseSync(path.join(dataDir, "accounts.db"), { readOnly: true });
  try {
    await backup(db, tmpSnapshot);
  } finally {
    db.close();
  }
  await rename(tmpSnapshot, path.join(dataDir, SNAPSHOT));
}

/** 提交数据目录，返回是否产生了新提交。 */
function commitDataDir(dataDir: string, date: string): boolean {
  if (!existsSync(path.join(dataDir, ".git"))) git(dataDir, "init", "--quiet");
  const gitignore = path.join(dataDir, ".gitignore");
  if (!existsSync(gitignore) || readFileSync(gitignore, "utf8") !== GITIGNORE) writeFileSync(gitignore, GITIGNORE);
  git(dataDir, "add", "--all");
  try {
    git(dataDir, "diff", "--cached", "--quiet");
    return false;
  } catch (error) {
    // 退出码 1 表示有变化，其他都是 git 本身出错。
    if ((error as { status?: number }).status !== 1) throw error;
  }
  git(dataDir, "commit", "--quiet", "-m", `backup ${date}`);
  return true;
}

/** COS 请求签名，见 https://cloud.tencent.com/document/product/436/7778 。 */
function cosAuthorization(
  secretId: string,
  secretKey: string,
  method: string,
  pathname: string,
  headers: Record<string, string>,
): string {
  const start = Math.floor(Date.now() / 1000) - 60;
  const keyTime = `${start};${start + 3600}`;
  const hmac = (key: string, data: string) => createHmac("sha1", key).update(data).digest("hex");
  const names = Object.keys(headers).map((name) => name.toLowerCase()).sort();
  const lower = Object.fromEntries(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]));
  const headerString = names.map((name) => `${encodeURIComponent(name)}=${encodeURIComponent(lower[name])}`).join("&");
  const httpString = `${method.toLowerCase()}\n${pathname}\n\n${headerString}\n`;
  const stringToSign = `sha1\n${keyTime}\n${createHash("sha1").update(httpString).digest("hex")}\n`;
  const signature = hmac(hmac(secretKey, keyTime), stringToSign);
  return [
    "q-sign-algorithm=sha1",
    `q-ak=${secretId}`,
    `q-sign-time=${keyTime}`,
    `q-key-time=${keyTime}`,
    `q-header-list=${names.join(";")}`,
    "q-url-param-list=",
    `q-signature=${signature}`,
  ].join("&");
}

async function uploadToCos(body: Buffer, key: string): Promise<string> {
  const bucket = requireEnv("COS_BUCKET");
  const region = requireEnv("COS_REGION");
  const secretId = requireEnv("COS_SECRET_ID");
  const secretKey = requireEnv("COS_SECRET_KEY");
  const host = `${bucket}.cos.${region}.myqcloud.com`;
  const pathname = `/${key}`;
  const headers = { Host: host, "Content-MD5": createHash("md5").update(body).digest("base64") };
  const response = await fetch(`https://${host}${pathname}`, {
    method: "PUT",
    headers: {
      ...headers,
      "Content-Type": "application/gzip",
      Authorization: cosAuthorization(secretId, secretKey, "PUT", pathname, headers),
    },
    body: new Uint8Array(body),
  });
  if (!response.ok) throw new Error(`COS 返回 ${response.status}：${(await response.text()).trim()}`);
  return `cos://${bucket}${pathname}`;
}

async function step<T>(name: string, run: () => T | Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    const detail = error instanceof Error ? ((error as { stderr?: string }).stderr?.trim() || error.message) : String(error);
    throw new Error(`${name}时出错：${detail}`, { cause: error });
  }
}

async function main(): Promise<void> {
  const dataDir = requireEnv("DATA_DIR");
  const date = today();

  await step("导出数据库副本", () => snapshotDatabase(dataDir));
  const committed = await step("git 提交", () => commitDataDir(dataDir, date));
  console.log(committed ? `已提交：${git(dataDir, "log", "-1", "--format=%h %s").trim()}` : "数据没有变化，跳过提交");

  const tmp = await mkdtemp(path.join(tmpdir(), "tree-note-backup-"));
  try {
    const archive = path.join(tmp, "backup.tar.gz");
    await step("打包", () => git(dataDir, "archive", "--format=tar.gz", "-o", archive, "HEAD"));
    const body = await readFile(archive);
    const location = await step("上传到 COS", () => uploadToCos(body, `backups/tree-note-${date}.tar.gz`));
    console.log(`已上传：${location}（${body.length} 字节）`);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

try {
  await main();
} catch (error) {
  console.error(`备份失败：${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
