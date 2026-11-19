# 第三方组件

NoteTrail 自有代码采用 [MIT](LICENSE)。依赖、工具及其内含组件保留各自许可；项目的 MIT 不会覆盖或替代这些许可。

桌面 D1 选择性复用 [pi-gui v1.0.1](https://github.com/minghinmatthewlam/pi-gui/tree/dd5708fb61a38b5012d0ab149b62054d02c1c72f) 的界面源码：设计变量、可访问的侧栏拖动组件，以及适配后的布局和共用输入区域。版权为 © 2026 Matthew Lam，完整 [MIT 许可](desktop/PI_GUI_LICENSE) 随源码保留；复制文件指纹及改编来源见 [upstream.json](desktop/upstream.json)。没有引入上游 Pi SDK、终端、Git、插件或自动更新模块。

桌面运行时单独使用 [Electron 45.3.2](https://github.com/electron/electron/releases/tag/v45.3.2)，顶层许可为 MIT，其 Chromium 和其他内含组件保留各自许可。依赖与完整性信息单独固定在 [desktop/pnpm-lock.yaml](desktop/pnpm-lock.yaml)，不修改网页后端的依赖组合。D5 本机预览包在 `Contents/Resources/licenses/` 保留 Electron 的 LICENSE 和 LICENSES.chromium.html；Pi GUI 的 MIT 文本在应用资源的 `app/desktop/PI_GUI_LICENSE`。

本次核查了当前平台冻结安装中的 214 个 JavaScript 包和 35 个 Python 包，版本及声明见 [DEPENDENCIES.md](DEPENDENCIES.md)。没有发现缺失的许可声明；部分包没有附带独立许可文件，清单中已列明，不将“有元数据声明”当作完整归属核查。

尤其需要保留：

- `lightningcss`、其 arm64 原生包以及 `certifi` 声明 MPL-2.0。
- `pypdfium2` 附带 PDFium 与其他原生库的多份许可，不能仅按 Python 包的顶层声明处理。
- Python、Node、uv、ripgrep、pnpm 的运行环境及内含组件各有许可。Node 制品附带完整 LICENSE，ripgrep 附带 MIT/Unlicense；其他归属信息也应随上游原始制品保留。

T11 源码候选包不含第三方运行环境；安装器从 [runtime-lock.json](scripts/runtime-lock.json)、[pnpm-lock.yaml](pnpm-lock.yaml) 与 [Python 哈希锁文件](scripts/conversion-requirements-hashed.lock) 指定的来源下载原始制品，不改写其许可文本。D5 本机桌面预览则直接包含已核对的 Node、Python、ripgrep、JavaScript 依赖与 Python wheels，并保留其随包许可文件；转换环境移除运行缓存，原生文件重新作本地代码签名。未引入 uv/pnpm 作为桌面运行条件。用户已选择暂缓正式签名、公证及对外分发；正式发布前仍需对实际二进制包完成完整归属及源码提供义务核查。

官方许可资料：[MIT](https://opensource.org/license/mit)、[MPL 2.0](https://www.mozilla.org/en-US/MPL/2.0/)。这些链接用于查阅原文；本清单不宣称已完成法律审计。
