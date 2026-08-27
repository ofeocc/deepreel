# DEEPREEL · 深刷

> 把 B 站变成你的自习室 —— 专注、持续、深度、沉浸学习。

![version](https://img.shields.io/badge/version-1.0.0-14110B?style=flat)
![license](https://img.shields.io/github/license/ofeocc/deepreel)
![language](https://img.shields.io/github/languages/top/ofeocc/deepreel)
![stars](https://img.shields.io/github/stars/ofeocc/deepreel)
![last commit](https://img.shields.io/github/last-commit/ofeocc/deepreel)
![pages](https://img.shields.io/github/deployments/ofeocc/deepreel/github-pages)

导入你挑中的长视频，屏蔽推荐与干扰，按分 P 像目录一样推进进度；AI 帮你摘要「学到了什么」，已学知识不再重复刷。学习足迹记入治学札记，坚持在日历上可见。

## 🌐 在线演示

<https://ofeocc.github.io/deepreel/>

> 在线演示为界面预览：浏览 / 导入 / 封面 / 示例课程可用；**视频解析、AI 摘要、高清画质需本地代理**（浏览器 CORS 限制），请克隆到本地运行以获得完整体验。

## ✨ 特性

- **藏书式课程库** —— 粘贴 B 站链接即入架，搜索 / 分类 / 置顶 / 分页
- **专注播放器** —— 隐去一切推荐，分 P 目录推进，自动记录观看与思考时长
- **AI 学习助手** —— DeepSeek 驱动：字幕摘要去重、随问随答、出题自测（可自选模型）
- **治学札记** —— 学习日历热力图、月度 / 年度报告、叙事化学习报告一键复制
- **B 站扫码登录** —— 本地代理转发，解锁 1080P+ 高清，Cookie 仅存本地
- **三套主题** —— 宣纸自习室 / 深夜书房 / 青绿笔记，随时换装
- **数据备份** —— 课程、记录、配置一键导出 JSON，跨浏览器迁移
- **云同步（可选）** —— 数据 AES-256 加密后备份到 WebDAV 网盘（坚果云等），换设备一键恢复

## 🚀 快速开始

**需要 [Node.js](https://nodejs.org/)（仅用于本地代理，版本 ≥ 14）。**

```bash
git clone <本仓库地址>
cd deepreel
npm start
```

`npm start` 一条命令完成全部：启动本地代理（端口 7392）→ 托管整个应用 → **自动打开浏览器**。

- **Windows 用户**：也可以直接双击 `start.bat`，无需命令行
- **macOS / Linux**：`./start.sh` 或 `npm start`

> 直接双击 `index.html` 也能打开界面（浏览、导入、封面可用），但**视频流解析、AI 摘要、高清画质需要本地代理**——应用会自动检测并在未启动时提示。

### 💡 可选：Windows 开机自启（个人电脑长期使用）

不想每次手动启动代理？把 `autostart.vbs` 的**快捷方式**放入启动目录即可（Win+R → `shell:startup` → 粘贴快捷方式），登录 Windows 后代理自动在后台运行（不会自动弹浏览器）。不想自启了，删除该快捷方式即可。

## ⚙️ 配置

打开页面 → 「设置」：

1. **B 站账号**：扫码登录解锁高清画质；可选默认清晰度
2. **DeepSeek**：填入 API Key 与模型即启用 AI 摘要 / 助手（无 Key 时用本地摘要兜底）
3. **外观主题**：宣纸 / 深夜 / 青绿 三套主题一键切换
4. **数据备份**：导出 JSON 留档，或在新环境导入恢复

## 🧱 技术栈

- 纯前端：原生 JavaScript + CSS（无构建步骤），动效 GSAP / Lenis，字体 Fraunces + Noto Serif SC
- 本地代理：Node.js（仅标准库 http / https，零依赖）

## 📁 目录结构

```
deepreel/
├── index.html      # 单页应用入口
├── app.js          # 全部前端逻辑（~2900 行）
├── styles.css      # 设计系统（CSS 变量 + 三套主题）
├── proxy.js        # 本地代理：托管应用 + DeepSeek / B 站 API（零依赖）
├── package.json    # npm start = node proxy.js
├── start.bat       # Windows 双击启动
└── start.sh        # macOS / Linux 一键启动
```

## 🔒 隐私

- 所有数据（课程、学习记录、API Key、B 站 Cookie）仅存于**浏览器 localStorage**，不经过任何服务器
- 本地代理仅在本机转发请求，无日志落盘

## ⚖️ 免责声明

本项目为学习工具，视频内容版权归原作者所有；生成内容仅供参考，请自行判断。
