#!/usr/bin/env sh
# DEEPREEL · 深刷 —— 一键启动（macOS / Linux）
cd "$(dirname "$0")"
echo "============================================"
echo "  DEEPREEL · 深刷 —— 一键启动"
echo "============================================"
echo ""
if ! command -v node >/dev/null 2>&1; then
  echo "  [错误] 未检测到 Node.js。"
  echo "  请先安装：https://nodejs.org/ （或使用 brew install node）"
  echo ""
  read -p "  按回车退出…" _
  exit 1
fi
echo "  [1/2] 启动本地代理 (端口 7392) ..."
echo "  [2/2] 将自动打开浏览器 → http://localhost:7392/"
echo ""
echo "  按 Ctrl+C 停止。"
echo ""
node proxy.js
