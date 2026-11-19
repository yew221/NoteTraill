# 参与 NoteTrail

项目围绕从个人资料中找到依据、问答和回查原件。Electron 加载桌面界面并启动本机后台。[桌面入口](src/desktop/main.mjs) · [桌面界面](src/desktop/renderer/main.tsx) · [本地服务](src/server/app.ts) · [共享接口](src/shared/api.ts)

## 普通问题反馈

在 GitHub 仓库的 **Issues → New issue** 选择「普通故障」或「功能建议」。请只提交适合公开的标题、正文和附件。

- **普通故障**　例如，用虚构文档点击引用后，原文没有打开。写清版本、系统与芯片、最少操作、预期和实际结果。如有错误代码，只摘录代码即可。[普通故障模板](.github/ISSUE_TEMPLATE/bug_report.yml)
- **功能建议**　例如，希望可以更快找到已暂停的关注。写清使用场景、现在遇到的困难，以及什么变化能解决它。[功能建议模板](.github/ISSUE_TEMPLATE/feature_request.yml)

请用可公开的虚构样例替换真实资料，去掉密钥、启动凭据、个人路径、笔记正文和完整对话或日志。凡是涉及资料泄露、越权访问，或一时无法判断能否公开的细节，请按安全政策私下报告。[安全问题报告](SECURITY.md)

## 提交 Pull Request

欢迎提交文档和代码改进。先 Fork 仓库，在自己的分支完成修改，再向本仓库的 `main` 提交 Pull Request（PR）。写清改了什么、为什么改、怎样验证；只改文档时，注明核对过哪些步骤或链接即可。

Git 提交会公开作者和提交者的邮箱，即使正文没有写邮箱也一样。希望保密时，请在提交前按 [GitHub 邮箱隐私说明](https://docs.github.com/en/account-and-profile/concepts/email-addresses) 设置：网页使用隐私邮箱，本地仓库的 `user.email` 使用 GitHub 提供的 `noreply` 地址。发起 PR 前检查分支中的每次提交；修改设置不会替换已有提交的邮箱。

疑似漏洞、私人资料或密钥不要放进 PR、补丁或截图，处理方式见[安全问题报告](SECURITY.md)。

## 开发与验证

修改检索时，请用虚构资料核对回答能否打开正确的原文。修改收集或保存流程时，请分别检查原件、提取文本和失败状态，并确认普通提问只进入聊天历史，选段经使用者预览确认后才写入知识库。[公开样例与预期依据](tests/fixtures/public/t00/README.md)

维护者使用独立开发环境中的 Node 24.22.1、pnpm 11.25.0，在干净源码副本中按 CI 冻结安装两份锁。安装器使用的 macOS 依赖布局由 Python 脚本与这两份实际安装逐项核对。下载、运行目录和附件转换环境见[桌面安装指南](desktop/README.md#从源码安装)。

在项目根目录依次运行以下检查。JavaScript 测试使用合成模型，Python 测试使用公开文档，桌面检查包括类型检查和构建。

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm --dir desktop --ignore-workspace install --frozen-lockfile --ignore-scripts
python3 scripts/freeze-js.py
pnpm check
pnpm audit --audit-level high
pnpm --dir desktop --ignore-workspace audit --audit-level high
"$NOTETRAIL_PYTHON" -B -m unittest discover -s tests -p 'test_*.py' -v
```

客户端错误码应与 [API 错误码表](API_SPEC.md) 一致。

macOS 的钥匙串回归使用单独的测试钥匙串，并在执行前后核对当前登录会话的默认钥匙串。若把整个用户主目录替换为空目录，该项可能找不到系统默认钥匙串。要运行跨文件系统备份用例，可把 `NOTETRAIL_TEST_VOLUME` 指向另一个已挂载、可写的本地卷。未提供时该项会标为跳过。

贡献者须有权按项目许可提供所提交的代码或材料。[项目许可](LICENSE)
