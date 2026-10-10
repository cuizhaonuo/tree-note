#!/usr/bin/env bash
# 一次性初始化服务器（可重复运行）：装 Node 22 和 Caddy，建服务用户 treenote，clone 代码到 /opt/tree-note，
# 放一份默认的环境配置文件。之后每次更新都用 deploy.sh。
# 用法（在本地）：ssh <服务器> 'sudo bash -s' < deploy/setup-server.sh
set -euo pipefail

REPO_URL=https://github.com/cuizhaonuo/tree-note.git
APP_DIR=/opt/tree-note
ENV_FILE=/etc/tree-note/tree-note.env
# 代码归登录用的普通用户所有，deploy.sh 以它的身份拉代码和构建。
DEPLOY_USER=${SUDO_USER:-ubuntu}

install_node() {
  if command -v node >/dev/null && (($(node -p 'process.versions.node.split(".")[0]') >= 22)); then return; fi
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
}

# 在子 shell 里加载代理配置再执行命令：访问 GitHub 要经代理，apt 访问腾讯云镜像则不需要。
with_proxy() {
  (
    if [[ -f /etc/profile.d/proxy.sh ]]; then . /etc/profile.d/proxy.sh; fi
    "$@"
  )
}

# Caddy 的 apt 源（cloudsmith）对这台服务器返回 402，改从 GitHub Releases 下载官方 .deb 包，
# 它同样会注册 caddy 用户和 systemd 服务。
install_caddy() {
  if command -v caddy >/dev/null; then return; fi
  local tag deb
  tag=$(with_proxy curl -fsSL https://api.github.com/repos/caddyserver/caddy/releases/latest | sed -n 's/.*"tag_name": *"\(v[^"]*\)".*/\1/p')
  deb=/tmp/caddy_${tag#v}_linux_$(dpkg --print-architecture).deb
  with_proxy curl -fsSL -o "$deb" "https://github.com/caddyserver/caddy/releases/download/$tag/$(basename "$deb")"
  dpkg -i "$deb"
  rm -f "$deb"
}

clone_repo() {
  if [[ -d $APP_DIR/.git ]]; then return; fi
  install -d -o "$DEPLOY_USER" -g "$DEPLOY_USER" "$APP_DIR"
  # 登录 shell 会加载 /etc/profile.d/proxy.sh，经代理访问 GitHub。
  sudo -u "$DEPLOY_USER" bash -lc "git clone $REPO_URL $APP_DIR"
}

install_env_file() {
  if [[ -f $ENV_FILE ]]; then return; fi
  install -d -m 755 "$(dirname "$ENV_FILE")"
  install -m 640 -o root -g treenote "$APP_DIR/deploy/tree-note.env.example" "$ENV_FILE"
}

main() {
  if ((EUID != 0)); then echo "需要以 root 运行（sudo bash -s）" >&2; exit 1; fi
  install_node
  install_caddy
  id treenote >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin treenote
  clone_repo
  install_env_file
  echo "初始化完成：node $(node -v)，$(caddy version | cut -d' ' -f1)，配置文件 $ENV_FILE"
  echo "下一步：检查配置文件，然后运行 $APP_DIR/deploy/deploy.sh"
}

main "$@"
