# 拍照学英语模型测试台

本地 Python 全栈网页，用于绕过 Agent/Harness 编排层，直接测试 OpenAI Chat Completions 兼容的多模态模型。

## 已实现

- 可编辑平台、Base URL、模型 ID、结果模型名、API Key、超时与额外请求参数。
- 可编辑用户资料、首轮提示词并上传测试图片。
- 首轮响应自动提取和校验 JSON，同时记录官方 `usage`、墙钟时延、请求 ID 和原始响应。
- 首轮 JSON 可人工修订；确认后按 `scene.context_zh + 每个 item` 生成详情提示词。
- 每个 item 单独人工触发；详情是否携带原图可切换。
- 页面与终端同时输出完整提示词和指标，但绝不输出 API Key 或图片 Base64。
- 每次首轮调用自动创建“模型名-本地时间戳”测试目录；该轮全部 item 结果固定写入同一目录。

## 启动

macOS / Linux：

```bash
cd "/Users/bytedance/work/youdao-test/photo-english-model-tester"
python3 server.py
```

浏览器打开：

```text
http://127.0.0.1:8765
```

停止服务：在启动终端按 `Ctrl+C`。

项目仅使用 Python 标准库，不需要安装 pip 或 npm 依赖。

## 默认模型配置

### 火山方舟 Seed 2.1 Lite

- Base URL：`https://ark.cn-beijing.volces.com/api/v3`
- 模型 ID：`doubao-seed-2-1-lite-260915`
- 默认关闭深度思考，并请求 JSON object 输出；如当前账户或模型版本不接受某个额外参数，可在页面直接删除。

### 阿里云百炼 Qwen3.8-Flash

- 模型 ID：`qwen3.8-flash`
- Base URL 中必须把 `YOUR_WORKSPACE_ID` 替换为百炼业务空间 ID：
  `https://YOUR_WORKSPACE_ID.cn-beijing.maas.aliyuncs.com/compatible-mode/v1`
- 需要在阿里云百炼开通模型服务并创建 API Key。是否产生费用、免费额度和实时价格以控制台为准。

## 输出结构

示例：

```text
results/
└── seed-2.1-lite-20261018-174256/
    ├── seed-2.1-lite-总体结果.json
    ├── seed-2.1-lite-item1.json
    ├── seed-2.1-lite-item2.json
    └── archive/
```

每次点击“调用首轮模型”都会创建新目录，即使图片和模型没有变化也不会复用旧目录。同一轮里重复调用某个 item 时，旧的同名结果会先复制到该轮的 `archive/`。

每个 JSON 主要包含：

- `request.prompt`：本次完整提示词。
- `request.body_without_image_or_secret`：去掉图片正文与密钥的请求体。
- `response.raw_json`：供应商原始 JSON 响应。
- `response.content` / `response.parsed_json`：模型正文与解析结果。
- `response.validation_errors`：结构检查问题，不会静默修复。
- `metrics.wall_clock_ms`：本地发出请求至完整读取响应的墙钟时间。
- `metrics.usage_raw`：供应商返回的原始 usage。
- `metrics.usage_normalized`：统一后的输入、输出、总计、缓存与思考 token。
- `test_context.detail_includes_image`：详情调用是否携带原图。

## 计量边界

- 时延包含本机网络、TLS、服务端排队和模型生成时间，不包含页面准备提示词的时间。
- 当前使用非流式请求，所以记录的是完整结果时延，不是首 Token 时延。
- Token 只记录供应商返回的 `usage`，缺失时显示“未提供”，不会估算成实测。
- 图片使用 Base64 Data URL 发送，避免额外图片托管服务影响测试；不同平台对图片 token 的计算方法仍可能不同。
- 若要比较模型，建议固定图片字节、提示词、思考模式、结构化输出参数、区域和调用时间窗口。

## 安全说明

- API Key 不写入任何结果文件或日志。
- 原图 Base64 不写入审计 JSON，仅记录 MIME 类型和字节数。
- 本地服务默认只监听 `127.0.0.1`，不会暴露到局域网。
