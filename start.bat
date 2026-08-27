@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ============================================
echo   DEEPREEL · 深刷 —— 一键启动
echo ============================================
echo.
where node >nul 2>nul
if errorlevel 1 (
  echo   [错误] 未检测到 Node.js。
  echo   请先到 https://nodejs.org/ 下载安装（一路默认即可），然后重新双击本文件。
  echo.
  pause
  exit /b 1
)
echo   [1/2] 启动本地代理 ^(端口 7392^) ...
echo   [2/2] 将自动打开浏览器 → http://localhost:7392/
echo.
echo   关闭本窗口即停止代理。
echo.
node proxy.js
pause
