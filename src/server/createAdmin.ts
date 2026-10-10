// 命令行创建管理员：`DATA_DIR=<数据目录> npm run create-admin -- <用户名>`，然后交互式输入两次密码。
// 第一个管理员只能这样创建，因为这时还没有任何人能登录管理界面。标准输入不是终端时（管道），读第一行作为密码。

import { mkdir } from "node:fs/promises";
import readline from "node:readline";
import { MIN_PASSWORD_LENGTH, openAccounts } from "./accounts";

/** 在终端里读一行，不回显输入的字符。 */
function promptHidden(question: string): Promise<string> {
  const stdin = process.stdin;
  process.stdout.write(question);
  stdin.setRawMode(true);
  stdin.setEncoding("utf8");
  stdin.resume();
  return new Promise((resolve, reject) => {
    let value = "";
    const finish = () => {
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      process.stdout.write("\n");
    };
    const onData = (chunk: string) => {
      for (const char of chunk) {
        if (char === "\r" || char === "\n") {
          finish();
          resolve(value);
          return;
        }
        if (char === "\u0003") {
          finish();
          reject(new Error("已取消"));
          return;
        }
        value = char === "\u007f" || char === "\b" ? value.slice(0, -1) : value + char;
      }
    };
    stdin.on("data", onData);
  });
}

async function readFirstLine(): Promise<string> {
  const lines = readline.createInterface({ input: process.stdin });
  for await (const line of lines) {
    lines.close();
    return line;
  }
  return "";
}

async function readPassword(): Promise<string> {
  if (!process.stdin.isTTY) return readFirstLine();
  const password = await promptHidden("密码：");
  if (password !== (await promptHidden("再输入一次："))) throw new Error("两次输入的密码不一致");
  return password;
}

async function main(): Promise<void> {
  const username = process.argv[2]?.trim();
  if (!username) throw new Error("用法：npm run create-admin -- <用户名>");
  const dataDir = process.env.DATA_DIR ?? ".dev-data";
  await mkdir(dataDir, { recursive: true });
  const accounts = openAccounts(dataDir);
  try {
    if (accounts.findUser(username)) throw new Error(`用户名已存在：${username}`);
    const password = await readPassword();
    if (password.length < MIN_PASSWORD_LENGTH) throw new Error(`密码至少 ${MIN_PASSWORD_LENGTH} 个字符`);
    await accounts.createUser(username, password, "admin");
    console.log(`已创建管理员 ${username}（数据目录：${dataDir}）`);
  } finally {
    accounts.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
