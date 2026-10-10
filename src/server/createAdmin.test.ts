import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openAccounts } from "./accounts";
import { createApp } from "./app";

const SCRIPT = path.join(import.meta.dirname, "createAdmin.ts");

describe("create-admin script", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "tree-note-admin-"));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  /** 像在服务器上那样运行脚本：用户名作参数，密码从标准输入读（这里用管道代替交互输入）。 */
  const run = (args: string[], input: string) =>
    spawnSync(process.execPath, ["--import", "tsx", SCRIPT, ...args], {
      input,
      env: { ...process.env, DATA_DIR: dir },
      encoding: "utf8",
    });

  const login = async (username: string, password: string) => {
    const accounts = openAccounts(dir);
    try {
      return await createApp(dir, accounts).request("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
    } finally {
      accounts.close();
    }
  };

  it("creates an admin who can then log in", async () => {
    const result = run(["alice"], "alice-password\n");
    expect(result.status).toBe(0);

    const res = await login("alice", "alice-password");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ username: "alice", role: "admin" });
  });

  it("fails without creating anything when the username is taken", async () => {
    expect(run(["alice"], "alice-password\n").status).toBe(0);
    const again = run(["alice"], "other-password\n");
    expect(again.status).not.toBe(0);
    expect(again.stderr).toContain("用户名已存在");
    expect((await login("alice", "other-password")).status).toBe(401);
  });

  it("fails when the password is too short or the username is missing", async () => {
    expect(run(["alice"], "short\n").status).not.toBe(0);
    expect(run([], "alice-password\n").status).not.toBe(0);
    expect((await login("alice", "short")).status).toBe(401);
  });
});
