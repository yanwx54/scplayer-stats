#!/bin/bash
#==============================================================
# StarCraft 战术情报终端 - 一键部署脚本
# 适用：Ubuntu 18.04 x86_64
# 用法：bash deploy.sh
#==============================================================
set -e

echo "=========================================="
echo "  StarCraft 战术情报终端 - 部署开始"
echo "=========================================="

# ---- 0. 检查 root 权限 ----
if [ "$EUID" -ne 0 ]; then
  echo "✗ 请用 root 用户执行：sudo bash deploy.sh"
  exit 1
fi

# ---- 1. 安装 Node.js 20.x LTS ----
echo ""
echo "[1/6] 检查 Node.js..."
if command -v node &>/dev/null && [ "$(node -v | cut -dv -f2 | cut -d. -f1)" -ge 18 ]; then
  echo "  ✓ Node.js $(node -v) 已安装"
else
  echo "  安装 Node.js 20.x LTS..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
  echo "  ✓ Node.js $(node -v) 安装完成"
fi

# ---- 2. 安装 Git ----
echo ""
echo "[2/6] 检查 Git..."
if command -v git &>/dev/null; then
  echo "  ✓ Git $(git --version | cut -d' ' -f3) 已安装"
else
  echo "  安装 Git..."
  apt-get update && apt-get install -y git
  echo "  ✓ Git 安装完成"
fi

# ---- 3. 安装 PM2（进程守护，防止服务挂掉）----
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
if [ -d "$APP_DIR" ]; then
  echo "  目录已存在，拉取最新代码..."
  cd "$APP_DIR"
  git pull || true
else
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
pm2 start server.js --name scplayer-stats
pm2 save
pm2 startup 2>/dev/null | tail -1 | bash 2>/dev/null || true
echo "  ✓ 服务已启动（PM2 守护，开机自启）"

# ---- 完成 ----
SERVER_IP=$(curl -s ifconfig.me 2>/dev/null || echo "199.180.116.188")
echo ""
echo "=========================================="
echo "  ✓ 部署完成！"
echo "=========================================="
echo ""
echo "  访问地址：http://$SERVER_IP:3000"
echo ""
echo "  常用命令："
echo "    pm2 status              # 查看服务状态"
echo "    pm2 logs scplayer-stats # 查看日志"
echo "    pm2 restart scplayer-stats # 重启服务"
echo "    cd /opt/scplayer-stats && node sync.js  # 手动同步数据"
echo ""
echo "  数据同步：项目已含全量数据（60 选手），无需再同步"
echo "  如需更新数据：cd /opt/scplayer-stats && node sync.js"
echo ""
