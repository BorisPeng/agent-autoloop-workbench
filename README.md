# Agent Autoloop Workbench

一个运行在本机的 Windows 桌面工作台，用于查看和管理 [Agent Autoloop](https://github.com/KKKKhazix/agent-autoloop)。它通过原项目的 HTTP 协议和命令行连接已有中台，不替代原项目的内核、接单程序或插件。

> **项目来源：**本工作台围绕 [KKKKhazix/agent-autoloop](https://github.com/KKKKhazix/agent-autoloop) 开发。感谢原项目作者数字生命卡兹克；本仓库是独立客户端，并非原项目官方发行版。原项目的 MIT 许可见 [third_party/AGENT-AUTOLOOP-LICENSE](third_party/AGENT-AUTOLOOP-LICENSE)。

## 功能

- 在一个窗口中查看运行、待处理卡片、Agent、通道、用量和规则；基于快照和事件流更新。
- 回答或结案卡片，查看轮次时间线，停止轮次，暂停、恢复或手动运行规则。
- 使用表单新建和编辑任务，填写描述、选择目录、Agent、模型、思考强度、权限及触发方式。
- 发送和预演事件，通过逐项表单管理规则、连接设置与环境变量，无需手写配置文件。
- 初始化或连接中台，临时启动中台，管理登录服务、密钥、插件、备份和恢复；提供提问、协议检查和 MCP 接入信息。

新任务的模型列表取自本机 Codex 的模型缓存，也可以填写其他受所选 Agent 支持的模型。模型和思考强度能否生效取决于 Agent 接入方式：Codex 和 Claude Code 支持；未提供相应能力的接入方式会使用其自身设置。为单个任务修改模型、思考强度或权限时，工作台会创建独立的 Agent 配置，避免改动其他任务。

## 安装与启动

1. 安装 [Agent Autoloop](https://github.com/KKKKhazix/agent-autoloop#上手)，或准备已有的 Agent Autoloop 数据目录。工作台安装包包含自己的 Node 运行时，但**不包含 Agent Autoloop 中台程序**。
2. 从本仓库的 [Releases](https://github.com/BorisPeng/agent-autoloop-workbench/releases) 下载 Windows x64 安装包并运行。
3. 从桌面或开始菜单打开 **Agent Autoloop Workbench**。若未自动找到原项目，选择其数据目录；必要时再选择包含 `bin/agent-autoloop.ts` 的程序目录。

可以在窗口菜单「连接 → 更换 Agent Autoloop 数据目录」切换安装。关闭工作台会停止由它临时启动的中台；原本独立运行的中台或登录服务不受影响。安装包目前没有代码签名，Windows 可能显示发布者未知提示。

桌面程序优先使用系统里符合要求的 Node 24 或更新版本；没有时，会将安装包内的 Node 复制到工作台用户数据目录并使用它。项目原有的配置、数据库、密钥和 Agent 不会被打包或上传。

## 从源码运行

需要 Node.js 24 或更新版本、Git，以及一个已有的 Agent Autoloop 安装。设置 `AGENT_AUTOLOOP_HOME` 指向数据目录，`AGENT_AUTOLOOP_APP` 指向包含 `bin/agent-autoloop.ts` 的原项目目录：

```powershell
git clone https://github.com/BorisPeng/agent-autoloop-workbench.git
cd agent-autoloop-workbench
npm ci
$env:AGENT_AUTOLOOP_HOME = 'C:\path\to\agent-autoloop-data'
$env:AGENT_AUTOLOOP_APP = 'C:\path\to\agent-autoloop-app'
npm run desktop
```

只运行浏览器版可使用 `npm start`，然后打开终端显示的本机地址。也可以通过 `AGENT_AUTOLOOP_RULES` 和 `WORKBENCH_PORT` 覆盖规则文件和浏览器版端口。

## 构建与验证

Windows x64 安装包使用官方 **Node.js v24.16.0 x64** 构建；构建脚本将该 Node 可执行文件复制进安装包。安装依赖后运行：

```powershell
npm ci
npm test
npm run build:win
```

安装包输出到 `dist/`。测试需要将 `AGENT_AUTOLOOP_APP` 指向原项目的完整源码目录；测试使用临时安装和测试 Agent，不操作现有中台。桌面包的专项测试可以在构建后执行：

```powershell
$env:WORKBENCH_DESKTOP_EXE = "$PWD\dist\win-unpacked\Agent Autoloop Workbench.exe"
node --test tests/desktop.test.mjs
```

## 数据与安全

工作台服务仅监听本机 `127.0.0.1`。访问工作台的用户拥有相应的本机操作权限，不要将它反向代理或共享给不可信用户。连接设置中的密钥默认隐藏；环境变量可以逐项查看或替换，密钥创建操作的输出应妥善保存。

规则、连接设置和环境变量在保存前会检查是否被其他程序改动；连接设置或环境变量变更后需要重启中台。长时间操作的结果保存在当前工作台进程的内存中，关闭窗口后不再保留。备份包含密钥，应放在安全位置。MCP 接入页按项提供可复制的启动信息，MCP 进程由客户端启动。

工作台源码使用 [MIT License](LICENSE)。Windows 安装包包含 Node.js，其许可见 [third_party/NODE-LICENSE](third_party/NODE-LICENSE)；Electron 和 Chromium 的许可随安装包提供。
