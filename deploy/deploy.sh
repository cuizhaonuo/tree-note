#!/usr/bin/env bash
# 一条命令部署：拉最新代码、装依赖、构建，安装 systemd 服务（含每日备份定时器）和 Caddy 配置，重启服务并检查能否访问。
# 用法（在本地）：ssh <服务器> /opt/tree-note/deploy/deploy.sh
# 全部逻辑放在 main 里并在同一行 exit：git pull 可能改写本文件，这样 bash 不会接着读到改动后的内容。
set -euo pipefail

# 等服务就绪：直接请求 Node 的 /api/me，未登录应返回 401；最多等 20 秒，超时则退出。
# 不经 Caddy：Caddy 只认域名，首次部署时证书可能还没申请下来。
wait_until_serving() {
  local code="" port
  port=$(sudo bash -c 'set -a; . /etc/tree-note/tree-note.env; printf %s "${PORT:-8899}"')
  for _ in $(seq 20); do
    code=$(curl -s -o /dev/null -w '%{http_code}' --noproxy '*' "http://127.0.0.1:$port/api/me" || true)
    if [[ $code == 401 ]]; then
      echo "部署完成：$(git log -1 --format='%h %s')"
      return
    fi
    sleep 1
  done
  echo "服务没有正常响应（/api/me 返回 $code），查看日志：journalctl -u tree-note -n 50" >&2
  exit 1
}

main() {
  # 非登录 shell 不加载 /etc/profile.d，GitHub 要经代理访问。
  if [[ -f /etc/profile.d/proxy.sh ]]; then . /etc/profile.d/proxy.sh; fi
  cd "$(dirname "$(readlink -f "$0")")/.."
  git pull --ff-only
  npm ci
  npm run build
  sudo install -m 644 deploy/tree-note.service deploy/tree-note-backup.service deploy/tree-note-backup.timer /etc/systemd/system/
  sudo systemctl daemon-reload
  sudo systemctl enable --quiet tree-note
  sudo systemctl enable --quiet --now tree-note-backup.timer
  sudo systemctl restart tree-note
  if ! cmp -s deploy/Caddyfile /etc/caddy/Caddyfile; then
    sudo install -m 644 deploy/Caddyfile /etc/caddy/Caddyfile
    sudo systemctl reload caddy
  fi
  wait_until_serving
}

main "$@"; exit
