#!/bin/bash
#==============================================================
# StarCraft 战术情报终端 - 一键部署脚本
# 适用：Ubuntu 18.04 x86_64（libc6 2.27，需 Node.js 16.x）
# 用法：bash deploy.sh
# 端口：3001（避免与旧项目 starcraft 的 3000 冲突）
#==============================================================
set -e

APP_PORT=3001

echo "=========================================="
echo "  StarCraft 战术情报终端 - 部署开始"
echo "=========================================="

# ---- 0. 检查 root 权限 ----
if [ "$EUID" -ne 0 ]; then
  echo "✗ 请用 root 用户执行：sudo bash deploy.sh"
  exit 1
fi

# ---- 1. 安装 Node.js 16.x LTS（官方二进制，兼容 Ubuntu 18.04）----
echo ""
echo "[1/6] 检查 Node.js..."
if command -v node &>/dev/null && [ "$(node -v | cut -dv -f2 | cut -d. -f1)" -ge 16 ]; then
  echo "  ✓ Node.js $(node -v) 已安装"
else
  echo "  下载 Node.js 16.20.2 官方二进制..."
  cd /tmp
  if [ ! -f node-v16.20.2-linux-x64.tar.xz ]; then
    curl -fsSL -O https://nodejs.org/dist/v16.20.2/node-v16.20.2-linux-x64.tar.xz
  fi
  echo "  解压安装到 /usr/local..."
  tar -xf node-v16.20.2-linux-x64.tar.xz -C /usr/local --strip-components=1
  rm -f node-v16.20.2-linux-x64.tar.xz
  echo "  ✓ Node.js $(node -v) 安装完成"
fi

# ---- 2. 检查 Git ----
echo ""
echo "[2/6] 检查 Git..."
if command -v git &>/dev/null; then
  echo "  ✓ Git $(git --version | cut -d' ' -f3) 已安装"
else
  echo "  安装 Git..."
  apt-get update && apt-get install -y git
  echo "  ✓ Git 安装完成"
fi

# ---- 3. 安装 PM2（进程守护）----
echo ""
echo "[3/6] 检查 PM2..."
if command -v pm2 &>/dev/null; then
  echo "  ✓ PM2 已安装"
else
  echo "  安装 PM2..."
  npm install -g pm2
  echo "  ✓ PM2 安装完成"
fi

# ---- 4. 克隆项目 ----
echo ""
echo "[4/6] 克隆项目..."
APP_DIR="/opt/scplayer-stats"
if [ -d "$APP_DIR/.git" ]; then
  echo "  目录已存在，拉取最新代码..."
  cd "$APP_DIR"
  git fetch --all
  git reset --hard origin/master
else
  rm -rf "$APP_DIR"
  git clone https://github.com/yanwx54/scplayer-stats.git "$APP_DIR"
  cd "$APP_DIR"
fi
echo "  ✓ 代码就绪：$APP_DIR"

# ---- 5. 安装依赖 ----
echo ""
echo "[5/6] 安装依赖..."
npm install --production
echo "  ✓ 依赖安装完成"

# ---- 6. 用 PM2 启动服务 ----
echo ""
echo "[6/6] 启动服务..."
pm2 delete scplayer-stats 2>/dev/null || true
PORT=$APP_PORT pm2 start server.js --name scplayer-stats
pm2 save
# 配置开机自启（如果系统支持 systemctl）
if command -v systemctl &>/dev/null; then
  pm2 startup 2>/dev/null | grep "sudo" | bash 2>/dev/null || true
fi
echo "  ✓ 服务已启动（PM2 守护，开机自启）"

# ---- 开放防火墙端口 ----
echo ""
echo "配置防火墙..."
if command -v ufw &>/dev/null; then
  ufw allow ${APP_PORT}/tcp 2>/dev/null || true
  echo "  ✓ ufw 已放行 ${APP_PORT} 端口"
elif command -v firewall-cmd &>/dev/null; then
  firewall-cmd --permanent --add-port=${APP_PORT}/tcp 2>/dev/null || true
  firewall-cmd --reload 2>/dev/null || true
  echo "  ✓ firewalld 已放行 ${APP_PORT} 端口"
else
  echo "  ! 未检测到防火墙工具，请确保服务商安全组放行 ${APP_PORT} 端口"
fi

# ---- 完成 ----
echo ""
echo "=========================================="
echo "  ✓ 部署完成！"
echo "=========================================="
echo ""
echo "  访问地址：http://199.180.116.188:${APP_PORT}"
echo ""
echo "  常用命令："
echo "    pm2 status                 # 查看服务状态"
echo "    pm2 logs scplayer-stats    # 查看日志"
echo "    pm2 restart scplayer-stats # 重启服务"
echo "    cd /opt/scplayer-stats && node sync.js  # 手动同步数据"
echo ""
echo "  数据已随仓库一起部署，无需再同步"
echo ""
