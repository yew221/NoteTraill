# 构建与验证脚本

`build.mjs` 构建桌面所用的本机后台，`build-desktop.mjs` 检查并构建桌面界面。`install.sh` 为支持的 macOS 环境准备独立运行时，`package-source.mjs` 生成用于安装和构建的精简源码包。

`pnpm check` 执行离线 JavaScript 回归。在这份快照中，`pnpm verify:deepseek` 使用公开样例和合成响应运行 Pi 适配器。真实问答请通过应用设置使用自己的模型配置。

开发依赖及测试命令见[贡献说明](../CONTRIBUTING.md)。
