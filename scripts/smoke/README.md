# Gateway smoke scripts

仓库内**保留**的冒烟脚本用于：（1）对**已启动**的 Node Proxy / Admin 发 HTTP，验证核心路由与可选管理写路径（含**同一用户多 key**与**级联删用户**）；（2）对 **`@octafuse/core`** 关键写路径做 **mock DB** 单测；（3）在配置 **`DATABASE_URL`** 时直连 Postgres/MySQL，验证 **`insertRequestUsageAndChargeTx` 并发累加**（与 Proxy `recordUsage` 相同存储路径）。它们**不是**运行时转发逻辑的一部分。

## 1. Node + SQL（Postgres / MySQL 等）

实现位于 **`test-node-core-routes.ts`**。`test-postgres-core-routes.ts` 为历史文件名入口，与前者共用同一套逻辑。

先按文档启动 **Proxy**（及可选 **Admin**），在仓库根：

```bash
npm run test:gateway:node-smoke
# 或（与上式等价实现，名称保留）
npm run test:gateway:postgres-smoke
```

环境变量与开关见 **`test-node-core-routes.ts` 文件头注释**（`GATEWAY_BASE_URL`、`GATEWAY_MASTER_*`、`GATEWAY_SMOKE_SKIP_ADMIN` 等）。

## 2. Core 写路径（无需 Proxy）

```bash
npx tsx --test scripts/smoke/test-critical-write-paths.ts
```

使用 `node:test` + mock D1 / Postgres 客户端，校验 `createApiKeyWithAudit` 等批处理 / 事务边界。

## 3. Postgres / MySQL：存储层并发扣费（与 Proxy 同一路径）

```bash
npm run test:gateway:sql-storage-smoke
```

直连 **`DATABASE_URL`**（`DATABASE_DRIVER` 默认 `postgres`，MySQL 须显式 `mysql`），在同一 `users` 下并发调用 `insertRequestUsageAndChargeTx`，断言 `budget_spent` 原子累加；结束 **`deleteUserHard`** 清理。**非严格模式下未配置 `DATABASE_URL` 时脚本退出 0（跳过）；配置无效或严格模式下缺少配置均失败**。

**D1**：单 Worker 内 `batch()` 串行；生产语义与 SQL 累加一致；端到端可依赖 **`npm run test:gateway:node-smoke`**（对真实 Admin + Proxy + D1 发 HTTP）。

本地可顺序执行（需已启动 Proxy/Admin 时再跑第 1 步）：

```bash
npm run test:gateway:node-smoke
npm run test:gateway:sql-storage-smoke   # 无 DATABASE_URL 则跳过
npx tsx --test scripts/smoke/test-critical-write-paths.ts
```

## CI 严格检查

`Docker Compose Smoke (node-pg)` 先启动临时 Postgres，通过迁移镜像应用全部迁移，再构建并启动 Proxy 与 Admin。
CI 设置 `GATEWAY_SMOKE_STRICT=1` 并显式提供临时库的管理凭证，执行管理读写、审计、多 Key、MCP 接入与并发扣费检查；缺少数据库配置、跳过关键检查或请求失败都会导致任务失败。
数据库与容器在任务结束时删除，不访问生产环境。

`npm run test:unit` 包含关键写入事务契约与冒烟配置回归；`npm run typecheck` 检查所有包，包含 Core 测试源码。
CI 还执行生产依赖审计（`scripts/ci/audit-prod.mjs`，仅对上游无修复版本的通告做带过期时间的豁免）、管理后台静态检查与 Proxy 打包检查。开发依赖审计需另行运行 `npm audit`。

## 4. 协议与路由的手工回归

已移除未在 `package.json` 声明依赖的 OpenAI / Anthropic / Gemini **官方 SDK** 示例脚本。需要测上游协议时，请用 **curl**、自写小脚本，或在你自己的客户端里把 `baseURL` 指到本网关；`model_routes` 的 **`custom_params`** 与请求体合并顺序仍为：

1. `custom_params`
2. 用户请求体（用户字段优先）

可在管理后台配好路由后，用「不传某字段 / 显式覆盖」做回归。

### 三类文本协议互转（需真实上游）

`test-text-protocol-conversion-live.ts` 使用当前源码的协议转换与上游驱动，真实调用 OpenAI Chat、Anthropic Messages、Gemini 端点。可以复用已部署的 Cloudflare Worker 作为上游，也可以直连供应商。脚本不部署 Worker、不修改路由、不写入本地数据库；使用线上网关作为上游时，线上仍会按正常请求计费和记日志。

复制 [`text-protocol-live.example.json`](text-protocol-live.example.json) 为仓库根 `.env.text-protocol-live.json`，填写端点及各协议可用模型。凭据可通过 `apiKeyEnv` 指定环境变量，或在本地配置中填写 `apiKey`；该本地配置已被 `.gitignore` 忽略。`customParams` 可按上游格式填写模型要求的路由参数。

```bash
npm run test:gateway:text-conversion-live -- .env.text-protocol-live.json
```

覆盖六个转换方向，每个方向检查普通 JSON、SSE 文本及终止事件、函数调用与真实工具结果续轮，共 18 项检查、正常情况下 24 次模型调用，并核对实际驱动读取的用量。失败或缺少配置均以非零状态退出，不把跳过算通过。报告默认写到 `data/text-protocol-live-report.json`，不记录 Key 或完整响应。

只测试已配置的上游时，可通过 `adapters` 显式指定适配器 ID 子集；报告会列出 `excludedAdapters`，子集通过不代表六个方向全部通过。`cases` 可选 `json`、`sse`、`tool-roundtrip`，用于定向复查失败。请求超过 `timeoutMs` 时停止并写入部分报告，未执行项计入 `notRun`。

这个测试验证当前本地转换代码与真实上游的兼容性；Cloudflare Worker 上的新版本部署、HTTP 鉴权、数据库选路和本地计费落库需要另外做完整网关联调。流式工具参数与图片尚不在这份真实冒烟范围内。

### DashScope 实时 ASR（需真实上游）

`test-dashscope-realtime-asr.ts` **不进 CI**。未设置 `GATEWAY_API_KEY` 或 `GATEWAY_REALTIME_PCM` 时跳过。需要已启动的代理服务、已配置的流式 ASR 路由，以及 16 kHz / 16 bit / 单声道裸 PCM：

```bash
ffmpeg -i speech.wav -ar 16000 -ac 1 -f s16le speech.pcm
GATEWAY_API_KEY=sk-... GATEWAY_REALTIME_PCM=./speech.pcm npx tsx scripts/smoke/test-dashscope-realtime-asr.ts
```

可选 `GATEWAY_MASTER_URL` + `GATEWAY_MASTER_KEY` 核对请求日志里 `billing_kind=audio_per_second` 且状态为成功。脚本结束时不带 Close 码关闭套接字，用于回归 Node 运行时的保留码记账。

### ElevenLabs 实时 WebSocket（需真实上游）

`test-elevenlabs-realtime.ts` **不进 CI**。覆盖 `/elevenlabs/v1/text-to-speech/{voice_id}/stream-input` 与 `/elevenlabs/v1/speech-to-text/realtime`（不含 multi-stream-input）。需要已启动的代理服务和对应实时路由；TTS 只需 `GATEWAY_ELEVENLABS_VOICE_ID`，STT 需要 16 kHz / 16 bit / 单声道裸 PCM。两项都不设时跳过：

```bash
GATEWAY_API_KEY=sk-... GATEWAY_ELEVENLABS_VOICE_ID=<voice_id> GATEWAY_REALTIME_PCM=./speech.pcm npx tsx scripts/smoke/test-elevenlabs-realtime.ts
```

可选 `GATEWAY_MASTER_URL` + `GATEWAY_MASTER_KEY` 核对请求日志（TTS `audio_per_character`、STT `audio_per_second`）。实时会话的用量由网关按客户端发出的文本字符 / 音频字节估算，需与 ElevenLabs 控制台对账。

## 说明

`test-postgres-core-routes` 名称中的 “postgres” 为历史遗留：脚本对 **任意** `DATABASE_DRIVER` 下的 Node 网关同样适用（见 `test-node-core-routes.ts` 内 `smokeLabel()`）。
