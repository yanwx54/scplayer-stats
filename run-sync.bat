@echo off
rem 过盾同步 + 推送服务器（供 Windows 任务计划/手动调用）
rem 默认增量：只同步近 14 天有比赛的活跃选手；距上次全量超 7 天自动全量兜底
rem 强制全量: node local-sync.js --full
rem 无需手动启动 Chrome：脚本会自动启动/关闭专用同步实例
rem 日志: sync-local.log
cd /d %~dp0
echo ===== %date% %time% ===== >> sync-local.log
node local-sync.js >> sync-local.log 2>&1
