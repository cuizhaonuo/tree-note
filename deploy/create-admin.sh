#!/usr/bin/env bash
# 创建管理员：以服务用户 treenote 的身份、用配置文件里的数据目录运行 createAdmin，交互式输入两次密码。
# 直接调用 tsx 而不是 npm run create-admin：treenote 没有家目录，npm 会因写不了缓存而报错。
# 数据目录由 systemd 在服务首次启动时创建，所以要先跑过 deploy.sh。
# 用法（在本地）：ssh -t <服务器> /opt/tree-note/deploy/create-admin.sh <用户名>
set -euo pipefail

if (($# != 1)); then echo "用法：$0 <用户名>" >&2; exit 1; fi
cd "$(dirname "$(readlink -f "$0")")/.."
# 用 shell 解析配置文件（和 systemd 一样会去掉值两边的引号），保证和服务读到的是同一个目录。
data_dir=$(sudo bash -c 'set -a; . /etc/tree-note/tree-note.env; printf %s "${DATA_DIR:-}"')
if [[ -z $data_dir ]]; then echo "/etc/tree-note/tree-note.env 里没有设置 DATA_DIR" >&2; exit 1; fi
if ! sudo test -d "$data_dir"; then echo "数据目录 $data_dir 不存在，先运行 deploy.sh 启动一次服务" >&2; exit 1; fi
exec sudo -u treenote env DATA_DIR="$data_dir" node_modules/.bin/tsx src/server/createAdmin.ts "$1"
