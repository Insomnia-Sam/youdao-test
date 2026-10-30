# 小语种识别控制台

本地调试工具：上传音频或现场录一段，调用豆包语音识别，看语种标签、识别文本和原始响应，参数可手动改。

## 启动

```bash
cd xiaoyuzhong-test
npm install      # 只装一个 ws 依赖
node server.js   # 默认 http://127.0.0.1:28471
```

想换端口：`PORT=28500 node server.js`。

## 两条调用路径

| 路径 | 接口 | 什么时候用 |
|---|---|---|
| 录完再识别 / 上传文件 | WebSocket 一句话识别 `bigmodel_nostream` | 音频在本机，先转 16kHz 单声道 PCM 再发。支持 `enable_lid` 和 `enable_auto_lang` |
| 公网链接 | HTTP 录音文件识别极速版 `recognize/flash` | 音频本身有公网直链，同步返回，不需要转码 |

## 鉴权

页面里填，不写进文件、不进日志：

- 新版控制台：只填 **API Key**（走 `X-Api-Key`）
- 旧版控制台：填 **App ID + Access Token**（走 `X-Api-App-Key` / `X-Api-Access-Key`）

资源 ID 按路径自动切换：WS 侧是 `volc.seedasr.sauc.duration` 等，HTTP 侧是 `volc.bigasr.auc_turbo`。

## 关于语种

- `enable_lid`：请求返回 `additions.lid_lang` 语种/场景标签，不能等同于自动选择外语转写模型。最新一句话识别与极速版文档列出了中文、英文、上海话、闽南语、四川话、陕西话、粤语标签；其他语种可能返回 `other_langs`，不承诺逐种返回标签。
- `enable_auto_lang`：自动判断支持列表内的语种进行识别，覆盖 25 个语种。没有返回语种字段时，界面明确显示“无 lid_lang”，不会根据文本猜测语种。
- `enable_auto_lang` 不能与 `corpus` 热词/上下文同时使用。
- 音频过短时 `lid_lang` 可能为空；效果需要用真实业务录音验证。

接口依据：
- 一句话识别：https://docs.volcengine.com/docs/6561/2628951?lang=zh
- 极速版：https://docs.volcengine.com/docs/6561/2608628?lang=zh
- WebSocket 二进制协议：https://www.volcengine.com/docs/6561/1354869

高级参数区可以用 JSON 编辑 `audio` 和 `request`。只允许当前控制台支持的字段，未知或不适用字段会在提交前报错；上传/录音实际已经转换为 PCM 16kHz / 16bit / 单声道，不能伪造格式参数。

## 安全与边界

- 服务只监听 `127.0.0.1`，不会暴露到局域网。
- 凭据只存在于浏览器内存；勾选「记住凭据」才会写 localStorage，可在页面取消。
- 本地音频上限 180 秒；极速版单文件上限 100MB / 2 小时。
- 这个控制台只是调试壳子，接口行为（语种范围、准确率、计费）以火山引擎文档为准。

## 测试

```bash
npm test    # 协议帧、gzip 请求体、错误帧、参数校验
```
