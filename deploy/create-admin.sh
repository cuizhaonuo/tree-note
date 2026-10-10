#!/usr/bin/env bash
# 创建管理员：以服务用户 treenote 的身份、用配置文件里的数据目录运行 createAdmin，交互式输入两次密码。
# 用法（在本地）：ssh -t <服务器> /opt/tree-note/deploy/create-admin.sh <用户名>
set -euo pipefail

if (($# != 1)); then echo "用法：$0 <用户名>" >&2; exit 1; fi
cd "$(dirname "$(readlink -f "$0")")/.."
data_dir=$(sudo sed -n 's/^DATA_DIR=//p' /etc/tree-note/tree-note.env)
exec sudo -u treenote env DATA_DIR="$data_dir" node_modules/.bin/tsx src/server/createAdmin.ts "$1"
