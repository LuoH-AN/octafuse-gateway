# 文本协议转换

代理服务支持 OpenAI Chat Completions、Anthropic Messages、Gemini generateContent 三类文本 API 的六个跨协议方向。普通 JSON 响应和流式 SSE 均按客户端协议返回。OpenAI Responses 仍使用独立的同协议透传路由。

## 配置

在路由（Model Routes）中选择协议适配器（Protocol adapter），管理后台会自动填写请求入口（Request Surface）和上游目标（Upstream Target）的协议与操作：

| 客户端入口 | 上游 API | 适配器 ID |
|---|---|---|
| OpenAI `/v1/chat/completions` | Anthropic `/v1/messages` | `openai-chat-to-anthropic` |
| OpenAI `/v1/chat/completions` | Gemini generateContent | `openai-chat-to-gemini` |
| Anthropic `/v1/messages` | OpenAI Chat Completions | `anthropic-to-openai-chat` |
| Anthropic `/v1/messages` | Gemini generateContent | `anthropic-to-gemini` |
| Gemini `/v1beta/models/{model}:{action}` | OpenAI Chat Completions | `gemini-to-openai-chat` |
| Gemini `/v1beta/models/{model}:{action}` | Anthropic `/v1/messages` | `gemini-to-anthropic` |

同协议路由继续使用 `passthrough`。转换路由需要显式创建；新增某个上游或导入模型不会自动开启其他客户端入口。供应商只需提供适配器上游侧的端点，例如 `anthropic-to-openai-chat` 只需要供应商的 OpenAI Chat 端点。

同一请求入口的路由池（Route Pool）可包含同协议透传目标和转换目标。故障转移的每次尝试重新从客户端请求构造目标协议的请求体，不修改客户端历史。

## 支持范围

- 系统提示、用户与助手文本、图片输入。
- 函数工具定义、强制指定函数、自动调用、禁止调用、必须调用；并行函数调用与结果回传。Gemini 历史缺少调用 ID 时，根据前面的函数名称与调用顺序关联结果，并生成稳定的请求内 ID。
- `max_tokens` / `max_completion_tokens` / `maxOutputTokens`、采样温度、`top_p` / `topP`、`top_k` / `topK`、停止序列。
- JSON Schema 输出；OpenAI 与 Gemini 的 JSON 对象模式。Anthropic 的结构化输出需要 Schema。
- 推理内容输出、常见推理档位及 Anthropic 与 Gemini 的推理预算。具体档位仍须被目标模型接受。
- Gemini 的动态推理预算（`thinkingBudget: -1`）转到 Anthropic 时使用自适应推理（`thinking.type: adaptive`）；预算为 0 或 OpenAI 的 `none` / `minimal` 档位映射为关闭推理。目标 Anthropic 模型需要支持对应模式。
- 转到 OpenAI Chat 时，数字推理预算近似映射为档位：0 为 `none`，1–2048 为 `low`，2049–8192 为 `medium`，更高为 `high`；动态预算为 `medium`。这不保证相同推理 Token 上限，可在路由中覆盖上游档位。
- 普通 JSON 响应、流式文本与推理、工具参数、结束原因、原生错误和用量。

Gemini 转换路由的图片输入需要 base64 data URL；不代用户下载远程图片或读取 Google 文件资源。OpenAI 与 Anthropic 转换时可保留图片 URL。不支持的内容块、内置搜索等托管工具、多候选、音频／视频／文件输入或非文本输出，返回 400，调用方可改用对应协议的透传路由。转换前的本地参数错误不会触发用户与模型级上游熔断。

跨厂商的推理签名无法通用，转到 Anthropic 或 Gemini 时不回传历史推理内容块。OpenAI 目标保留无签名的 `reasoning_content`，供需要推理历史的工具续轮使用。Gemini 工具签名可通过 OpenAI `tool_calls[].extra_content.google.thought_signature` 或 Anthropic 转换响应的 `tool_use.extra_content.google.thought_signature` 扩展保留，JSON 与 SSE 均支持。客户端续轮时应保留这项扩展，以便回传到 Google 的 OpenAI 兼容或 Gemini 上游；转换为 Gemini 时缺少签名的工具历史采用 `skip_thought_signature_validator` 占位。转到原生 Anthropic 的出站请求仍不传递 Google 签名。缓存控制、Gemini `cachedContent`、安全设置以及厂商特有参数没有通用映射：显式缓存资源和安全设置返回 400，消息中的缓存控制不迁移；目标上游的参数写入路由自定义参数（Custom params）。

自定义请求体使用**上游格式**，在协议转换后合并。默认客户端已映射的参数优先；强制覆盖（Force override）仍可锁定上游参数。Anthropic 上游的最大输出缺省为 4096，可由客户端或路由覆盖。模型名由上游目标统一替换。

## 流式与计费

文本和推理增量即时返回；目标协议为 Gemini 或 Anthropic 时，工具参数在完整 JSON 到达后发送。OpenAI 目标可直接转发函数参数增量。SSE 解析支持 UTF-8 跨块、CRLF 和多行 `data:`；畸形数据、工具参数残缺或缺少终止事件会产生客户端协议的错误事件，不补成功终止。

实际请求仍交给已有的 OpenAI、Anthropic、Gemini 上游驱动，复用响应头、首事件、空闲超时、取消后的限时用量读取和供应商故障转移。计费始终取实际上游驱动的用量，而非转换后的客户端响应。Anthropic 输入与缓存用量来自 `message_start.message.usage`，随后合并 `message_delta.usage` 的输出增量。请求日志分别记录客户端协议和实际上游协议；上游请求体按转换后的格式脱敏。

管理后台的调试台（Playground）与路由快速测试使用同一转换模块，模板和响应预览按客户端协议选择；发送请求预览展示转换并合并路由参数后的上游格式。

## 实现与参考

- 注册表：`packages/core/src/adapters/registry.ts`。
- 请求与响应转换、流式状态：`packages/core/src/text-protocol/`。
- 调度与日志：`packages/proxy/src/services/egress/text-conversion-driver.ts`。

设计参考 [New API 的请求转换注册表](https://github.com/QuantumNous/new-api/blob/b388140acfd80369ec6243b16869daff1b4051f4/relaykit/relayconvert/request_registry.go)、[响应转换注册表](https://github.com/QuantumNous/new-api/blob/b388140acfd80369ec6243b16869daff1b4051f4/relaykit/relayconvert/response_registry.go)及流式终止状态测试。本仓库使用独立的 TypeScript 实现，按现有适配器、驱动和计费接缝集成。
