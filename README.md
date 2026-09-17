# mock-llm-service

假扮 Claude/GPT 上游 API 的 mock 服务，用于压测 new-api 中转站。零依赖（Node >= 18 原生模块）。

## 用法

```bash
cp .env.example .env   # 按需调参数
npm start              # 或 node server.js
```

new-api 加自定义渠道，Base URL 指向 `http://localhost:8787`，模型从 `GET /v1/models` 拉取
（渠道类型选 OpenAI；Claude 协议的 `/v1/messages` 同时支持）。

## 端点

| 端点 | 说明 |
| --- | --- |
| `POST /v1/chat/completions` | OpenAI 格式，支持 stream |
| `POST /v1/messages` | Anthropic 格式，支持 stream（含 message_start/content_block_delta 等事件） |
| `GET /v1/models` | 模型列表 |
| `GET /metrics` | 请求计数、QPS、TTFT/总延迟 P50/P95/P99、错误数，按模型分组 |

## 行为

- 响应内容 = 请求最后一句话前 80 字符 + 随机词填充，到目标 token 数为止
- token 数估算：约 4 字符 = 1 token
- 延迟模型：TTFT（默认 500ms）+ 逐 chunk 间隔（默认 20ms）
- 请求体里可单请求覆盖（调压测强度/定向注入用）：
  - `mock_max_tokens` — 输出长度
  - `mock_ttft_ms` / `mock_interval_ms` — 延迟模型
  - `mock_fault` — 强制注入指定故障（绕过概率）
- new-api 侧的 `max_tokens` 小于默认值时按它来（Anthropic 协议）
- OpenAI 流式带 `stream_options: {"include_usage": true}` 时最后追加 usage chunk
- SIGTERM/SIGINT 优雅停机：排空在途请求后 dump 最终 `/metrics`

## 故障注入（.env 概率 或 body.mock_fault 强制）

各项比率独立累加，`ERROR_RATE` 是兜底（命中后返回 500）：

```bash
ERROR_RATE=0            # 通用错误(500)
ERROR_429_RATE=0        # 限流
ERROR_500_RATE=0        # 服务端错误
ERROR_TIMEOUT_RATE=0    # 挂起不响应，挂 TIMEOUT_MS 后 504
ERROR_DISCONNECT_RATE=0 # 200 + 输出约30%后断连（无结束标记，测中转站断流处理）
ERROR_PAUSE_RATE=0      # 200 + 中途停顿 PAUSE_MS 后继续并正常完成
ERROR_HEARTBEAT_RATE=0  # 200 + 只有 SSE 心跳(: ping)无内容，HEARTBEAT_MS 后无结束标记收尾
ERROR_EVENT_RATE=0      # 200 + 流中协议错误事件（OpenAI error data / Anthropic event:error），无结束标记
```

`/metrics` 的 `error_types` 按类型分账：`disconnect` / `pause` / `heartbeat` / `error_event` /
`rate_limit` / `server_error` / `timeout` / `client_abort`（客户端主动取消）。

## 验证

```bash
curl -s localhost:8787/v1/models | jq '.data[].id'

# OpenAI stream
curl -N localhost:8787/v1/chat/completions -H 'Content-Type: application/json' \
  -d '{"model":"mock-gpt-4o","stream":true,"messages":[{"role":"user","content":"hi"}]}'

# Anthropic 非 stream
curl -s localhost:8787/v1/messages -H 'Content-Type: application/json' \
  -d '{"model":"mock-claude-sonnet","max_tokens":64,"messages":[{"role":"user","content":"hi"}]}'

curl -s localhost:8787/metrics
```
