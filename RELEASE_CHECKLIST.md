# 源码与桌面分发检查清单

本清单适用于 `0.1.0-desktop.17`，数据库格式为 21。安装器接受 macOS 26.6、Apple Silicon。

## 已在本机核对的范围

| 项目 | 实际结果 |
| --- | --- |
| 首次安装 | 使用独立源码副本、安装目录、缓存和应用数据，按锁恢复依赖，并验证打包后的桌面应用。 |
| 核心流程 | 用模拟模型和合成资料核对资料问答及出处。测试覆盖附件状态更新、重开后保留问题、按关键词返回旧消息及删除前影响提示。 |
| 多知识库 | 核对同一窗口切换、独立聊天与草稿、附件恢复，以及只运行当前库的持续关注。 |
| 回归与恢复 | 自动化覆盖 JavaScript 回归、Python 转换与依赖恢复，以及跨文件系统备份还原。维护者按确切源码清单保存回执。 |

## 对外分发前待核对

- [ ] 每次新候选均须复核两份完整依赖锁的高危审计、安装工具与归档、实际安装目录和桌面包。保留运行记录及候选 SHA-256。
- 让另一位使用者在第二台目标 Mac 上按文档独立安装，验证首次权限提示、模型配置、提问与原文回查。其他系统和芯片仍缺实测。
- 在最终源码上运行远端 CI，逐份核对拟分发的内容、许可和依赖说明。
- 如分发 `.app`，对同一份二进制完成随附组件许可复核、Developer ID 签名、Apple 公证及新机 Gatekeeper 验收。本机开发签名仅用于本机试用。[桌面使用与制品检查](desktop/README.md)

## 公开仓库和反馈渠道

- [ ] 公开前检查所有分支、标签、提交署名和提交正文，确认没有个人邮箱或内部历史。检查自动构建日志和附件；源码仓库不附带本机的知识库或配置。
- [ ] 确认仓库允许外部用户提交 Pull Request。用普通贡献者视角核对目标分支为 `main`，新 PR 能显示投稿模板。维护者在网页上提交或合并前，检查使用的是 GitHub 隐私邮箱。

- [ ] 确认正式仓库及负责接收报告的维护者。在默认分支核对安全政策和三份表单的位置，开启 Issues。在仓库设置的 **Advanced Security** 中启用 **Private vulnerability reporting**。请负责维护者订阅安全提醒并核对通知设置。[GitHub 私密报告设置](https://docs.github.com/en/code-security/how-tos/report-and-fix-vulnerabilities/configure-vulnerability-reporting/configure-for-a-repository)
- [ ] 从普通贡献者视角打开 **Security and quality → Advisories → Report a vulnerability**。核对显示的是项目的私密表单，有“版本与环境”和“影响范围”等字段。GitHub 在自定义表单无效时可能显示默认表单，只看到按钮不足以核验模板。
- [ ] 打开 **Issues → New issue**，分别预览“普通故障”和“功能建议”。两份都应提示内容将公开，并把疑似安全问题引向安全政策。若选择器显示安全报告入口，确认它打开私密报告页面。[GitHub Issue 模板配置](https://docs.github.com/en/communities/using-templates-to-encourage-useful-issues-and-pull-requests/configuring-issue-templates-for-your-repository)
- [ ] 用虚构内容核对私密报告的可见范围和维护者收件情况。没有验证到私密入口时，不要引导报告人把安全细节发到公开 Issue 或 PR。
