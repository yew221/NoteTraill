# NoteTrail 本机 API

## 对话和资料相关接口

路径相对于 `/api/v1`，使用本机会话鉴权。

| 接口 | 作用 |
| --- | --- |
| `GET /sessions/search` | 必填 `vaultId,q`，可选 `cursor,limit,sessionId`。查询当前知识库中的标题、用户消息和权限仍有效的答复。每段对话返回一条命中片段及可选消息位置。用 `sessionId` 复查时不带游标。 |
| `GET /sessions/{id}/deletion-impact` | 返回受影响的 `watches,versions`，含暂停的关注和原回答。 |
| `DELETE /sessions/{id}` | 提交预览得到的 `{watches,versions}`。数量变化时返回 `REVISION_CONFLICT`，需重新核对。 |
| `GET /vaults/{id}/catalog-revision` | 返回本地资料目录修订号，界面据此刷新可读状态。 |

## 7. 错误约定

客户端根据错误码和 HTTP 状态显示处理结果。公开字段包括 `code`、`message`、`retryable`，以及经过筛选的可选 `details`。下表适用于任务被接受之前的错误。任务返回 HTTP 202 后，错误记录在任务对象中并随事件发送。

| code | HTTP | 含义与重试规则 |
| --- | --- | --- |
| BAD_REQUEST | 400 | 参数无效；工具错误附经过筛选的参数修正提示 |
| QUESTION_TOO_LONG | 413 | 超过 16,000 UTF-8 字节；发送前阻止并保留草稿 |
| CONTEXT_LIMIT | 422 | 本轮必要上下文超过容量；缩小范围或分开提问 |
| BUDGET_REVIEW_REQUIRED | 422 | 兼容旧历史错误；新版本不再产生费用暂停，可重新发送 |
| MODEL_REQUEST_BUSY | 409 | 当前仍有模型请求进行中，请稍后再试 |
| TOOL_READ_LIMIT | 422 | 资料读取容量已用完；用已读内容收尾，不冒充完整核查 |
| UNAUTHORIZED / ORIGIN_DENIED | 401 / 403 | 本机凭证或来源验证失败；不自动重试 |
| VAULT_ACCESS_DENIED / PATH_OUTSIDE_SCOPE / SOURCE_EXCLUDED | 403 | 无权限、越界或被排除；不得换路径绕过 |
| NOT_FOUND / SOURCE_MISSING | 404 / 410 | 资源不存在 / 已登记原件消失 |
| SOURCE_CHANGED / SOURCE_NOT_READY | 409 | 版本变化 / 当前不能读取；需刷新或等待 |
| SESSION_BUSY | 409 | 会话已有活动任务 |
| MEMORY_LIMIT_EXCEEDED | 422 | 有效记忆条数或合计字符数达到已确认上限；整次变更拒绝 |
| IDEMPOTENCY_CONFLICT / REVISION_CONFLICT | 409 | 重复键载荷不一致 / 并发修订冲突 |
| CONTEXT_CHANGED / DERIVED_MODIFIED | 409 | 有效上下文撤销 / 派生件存在人工改动 |
| FILE_TOO_LARGE | 413 | 超出已公布的文件限制 |
| CONFIG_REQUIRED / INTENT_UNCLEAR | 422 | 必要配置缺失 / 无法确定用户动作 |
| UNSUPPORTED_FORMAT | 422 | 操作要求当前格式的正文，但没有对应支持 |
| CONVERSION_FAILED / EXTRACTION_EMPTY / EXTRACTION_PARTIAL | 422 | 转换失败 / 未提取到正文 / 已知提取限制（partial来源携带此警告，仍可读） |
| CITATION_INVALID / BUDGET_EXCEEDED | 422 | 引用不满足契约 / 超出任务上限 |
| URL_BLOCKED / URL_FETCH_FAILED | 403 / 502 | 目标不允许访问 / 未能获取网页正文 |
| SEARCH_CONFIG_REQUIRED / SEARCH_LIMIT_REACHED | 422 | 缺少对应搜索服务的官方 API 密钥 / 本题搜索次数已到上限。保留已有回答并说明缺口 |
| SEARCH_PRIVACY_BLOCKED | 422 | 搜索包含可识别的私密内容或隐私上下文无法完整检查；未发出搜索，模型可自动改用公开关键词，不询问批准 |
| SEARCH_UNAVAILABLE | 503 | 搜索未成功，未取得可引用内容；不伪装为已联网核实 |
| MODEL_PRICING_REQUIRED | 422 | 当前模型缺少预算单价，保存后可补齐；不得将未知费用记为零 |
| MODEL_SETTINGS_BUSY | 409 | 问答或模型测试尚未结束，暂不能编辑、切换或删除模型配置 |
| MODEL_AUTH_FAILED / MODEL_PROTOCOL_ERROR | 502 | 上游凭据失败 / 模型交互或输出协议不兼容 |
| MODEL_RATE_LIMITED / MODEL_UNAVAILABLE | 503 | 上游限流或不可用；仅按预算作有界重试 |
| CREDENTIAL_STORE_UNAVAILABLE / SERVICE_UNAVAILABLE | 503 | 密钥存储或本地服务不可用 |
| DEADLINE_EXCEEDED | 504 | 超时并停止后续处理 |
| WORKER_EXITED / SESSION_UNREADABLE | 500 | 工作进程退出 / 会话无法读取；保留诊断和原文件 |
| RUN_INTERRUPTED | 409 | 服务重启发现任务未结束；不自动付费续跑 |

## 8. 核对契约

[共享错误目录](src/shared/api.ts)定义服务端可返回的状态和消息。[契约测试](tests/test_contracts.mjs)会核对上表中每一个错误码的 HTTP 状态。
