# NoteTrail 桌面使用指南

## 从源码安装

适用环境：**macOS 26.6、Apple Silicon（arm64）**。首次安装需要联网，不需要预装 Node.js、Python 或包管理器。在终端进入含 `package.json` 的源码根目录，再依次执行下面四步。已有数据的用户请先看[数据与升级](#数据与升级)。

**1. 安装运行环境。** 以下示例把程序和数据放在主目录下的 `NoteTrailWorkspace`。首次安装请选择知识库和代码仓库以外的新目录。

```sh
export NT_HOME="$HOME/NoteTrailWorkspace"
sh scripts/install.sh --prefix "$NT_HOME/install" --data-dir "$NT_HOME/desktop-data"
```

**2. 选择运行环境。** 使用安装器提供的 Node.js、文档转换器和检索工具。`cd -P` 取得实际目录，避免附件转换时找不到 Python。

```sh
export NT_HOME="$HOME/NoteTrailWorkspace"
export NT_RUNTIME="$(cd -P "$NT_HOME/install/current/runtime" && pwd -P)"
export PATH="$NT_RUNTIME/node/bin:$PATH"
export NOTETRAIL_PYTHON="$NT_RUNTIME/conversion/bin/python"
export NOTETRAIL_RG="$NT_RUNTIME/rg/rg"
```

**3. 构建桌面应用。** 以下命令按项目记录的版本和校验值下载依赖。首次安装或更新源码后执行。

```sh
"$NT_RUNTIME/python/bin/python3.12" -I -B scripts/restore-js.py root --cache "$NT_HOME/install/cache/js-archives"
"$NT_RUNTIME/python/bin/python3.12" -I -B scripts/restore-js.py desktop --cache "$NT_HOME/install/cache/js-archives"
node scripts/build.mjs
node scripts/build-desktop.mjs
```

**4. 打开桌面应用。** 后台服务随窗口启动，不需要另开服务。按 ⌘Q 退出。下次打开新终端，进入同一源码目录，只需执行第 2、4 步；如果自定义了目录，请继续用原路径。

```sh
node scripts/desktop.mjs --data-dir "$NT_HOME/desktop-data" --profile-dir "$NT_HOME/desktop-profile"
```

## 打开与使用

1. 进入桌面窗口后，从设置连接自己的 Obsidian 知识库并配置云端大模型的 API 密钥。可以选择预设服务或填写兼容的聊天接口。密钥由 macOS 钥匙串保存。保存配置不会触发模型调用，主动测试连接和提问可能收费。首次连接后，从侧栏菜单或设置添加知识库。切回某个库会恢复它的聊天、草稿和附件。新库沿用模型配置，持续关注只在当前库运行。
2. 共用输入框默认提问，按 Enter 发送、Shift + Enter 换行。范围选择只限定可检索的资料；统一自动选择模型知识、知识库或网页。必要时模型直接搜索，无逐次确认或“仅依据资料”模式开关。搜索需在模型设置中保存对应搜索服务的官方 API 密钥。缺少配置时会说明尚未核实。
3. 原件和历史保存在本机。问答会将问题、检索片段、相关历史及已保存记忆发送给你配置的云端大模型。搜索关键词经过检查后另发给搜索服务，检查仍可能漏掉敏感含义。详见 [搜索与隐私边界](../WEB_SEARCH.md)。
4. 回答流式显示。关键资料事实旁显示对应文件，点击可在右侧核对原句。网页来源显示链接、获取时间和摘录。模型回答单独标记。停止／中断正文不算已核对答案，不能把模型常识当作已查证最新事实。
5. 拖入单个文件后点击“存入知识库”。输入框里的问题会保留，退出再打开也能继续。文件卡片会自动更新，出现“可用于问答”后点击“发送问题”，即可针对这份文件提问。也可以输入“帮我入库”，或使用右侧收集区。每个原件最多 100 MiB；已保存与可用于问答分开显示。PDF、DOCX、XLSX、XLS、HTML 在受限进程提取正文；异常文件可显示处理失败，原件保留。扫描图片无 OCR 保证，旧 DOC 不支持。
6. 引用、回答选段和长期记忆按明确操作保存；可查看、修改或删除记忆。退出重开保留历史、草稿、附件及未确认请求的标识，不自动重发中断问题。
7. 在历史列表点“搜索旧对话”，输入标题或记得的词。搜索会显示命中片段，点击即可定位原消息。可以从对话顶部打开“续接思路”。搜索在本机进行，不会触发模型调用。
8. 应用没有金额上限。仍保留次数、时限、文件及上下文容量保护；未知用量不伪记为免费或已结算。模型单价为统计估算，实际账单以供应商为准。

## 从一条回答继续工作

- **矛盾与证据缺口**：回答旁显示与当前问题有关的待核对项，右侧可看原文和影响，再基于该版本继续补查。提示由模型生成，不能保证穷尽或判定事实真伪。
- **续接思路**：对话顶部发起，列出目标、已确认决定、用户报告的进展、停点、待定事项和下一步；原话和历史模型表述分开，可点击回查。只整理当前对话已纳入的记录，不猜测离开期间发生的事。
- **过往经验**：输入框上方“找找过往经验”追加对照要求，发送前可取消。案例保留问题、条件、实际做法、结果、相同点、差异和借鉴边界；复制件和 AI 整理不算多次独立验证。
- **结果复盘**：从对话顶部、某条答案或关注的选定版本发起，手动补问题、时间、行动、结果；可独立调整复盘资料范围，同时保留选定旧版和聊天草稿。无记录就留为未知；用户报告不是独立验收，相关变化不是因果证明。

这些结果保存在对话历史里。建议只会填入草稿，不会自动执行；选中片段并确认后才会存入知识库。保存案例或复盘片段时，会附上相关背景、结果、适用条件与依据。

## 数据与升级

- 按本页从源码启动时，首个知识库的应用数据在 `desktop-data`，其他知识库的应用数据、窗口草稿和未发送的附件在 `desktop-profile`。不指定启动参数时，默认使用 `~/Library/Application Support/NoteTrail` 和 `~/Library/Application Support/NoteTrail Desktop`。
- Obsidian 原件仍在所选知识库；应用数据备份不包含整个知识库或钥匙串密钥。
- 替换本地应用前，先退出并保留旧应用、程序数据和桌面草稿。知识库原件也应单独备份。
- 更换桌面版本时，在新的安装目录准备运行环境，打开桌面时沿用原来的 `--data-dir` 和 `--profile-dir`。指向空目录会看到一个新的工作区，不代表原来的聊天已被删除。
- 回退前保留新产生的资料、历史和附件，使用旧应用与配套备份；不得用不支持 schema 21 的旧版直接打开当前数据库。维护工具恢复后需重新填写密钥。

删除对话前会显示关联的持续关注数量和已保存的答案版本数，版本数包含原回答。选择“保留对话”可退出。确认删除后，已存入知识库的原件仍可使用。

## 从旧工具链迁移

旧安装目录里包含 npm 或 pnpm 时，在新目录安装并恢复备份，不要覆盖旧目录。先退出桌面应用，另行备份各知识库和原桌面配置目录，再将下列路径换成实际路径。备份目标必须尚不存在。

```sh
export NT_OLD="/绝对路径/旧安装目录"
export NT_OLD_DATA="/绝对路径/旧应用数据目录"
export NT_HOME="$HOME/NoteTrailWorkspace"
"$NT_OLD/notetrail" stop
"$NT_OLD/notetrail" maintenance backup --data-dir "$NT_OLD_DATA" --to "${NT_HOME}-backup"
sh scripts/install.sh --prefix "$NT_HOME/install" --data-dir "$NT_HOME/desktop-data" --from-backup "${NT_HOME}-backup"
"$NT_HOME/install/notetrail" doctor
```

恢复后按安装说明的第 2、3 步构建。第 4 步使用恢复后的 `--data-dir`，把 `--profile-dir` 指向原桌面配置目录或其恢复副本。重新填入模型密钥，核对聊天、草稿和资料后再处理旧目录。

## 打包本机应用

需要为开发机制作本地应用时，先完成源码构建，在同一终端指定已经验证的安装目录和一个新的输出路径：

```sh
node scripts/package-desktop.mjs --runtime-prefix /绝对路径/已验证运行环境 --output /绝对路径/新目录/NoteTrail.app
node scripts/verify-desktop.mjs /绝对路径/新目录/NoteTrail.app
```

应用启动／退出后再次执行最后一条命令，核对回执文件清单、版本和签名没有变化。检查器只读；不得用会写入字节码的 Python 命令直接检查已签名应用。构建过程中的包内离线检查使用禁止写入字节码的启动方式。

此命令生成供本机使用的 `.app`，使用本机签名，不是经 Apple 公证的安装包。遇到系统安全拦截不要关闭系统保护。
