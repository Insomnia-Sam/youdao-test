'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { WebSocketServer } = require('ws');
const asr = require('../lib/asr');

function unpackClientMessage(buf) {
  assert.strictEqual(buf[0] >> 4, 1, 'protocol version 必须为 1');
  const headerSize = (buf[0] & 0x0f) * 4;
  const type = buf[1] >> 4;
  const flags = buf[1] & 0x0f;
  const ser = buf[2] >> 4;
  const comp = buf[2] & 0x0f;
  const size = buf.readUInt32BE(headerSize);
  let payload = buf.subarray(headerSize + 4, headerSize + 4 + size);
  if (comp === 1) payload = zlib.gunzipSync(payload);
  return { type, flags, ser, comp, payload };
}

function buildServerFrame(jsonText, { type = 0x09, flags = 0x01, comp = 1, seq = 1, gzip = true } = {}) {
  const body = gzip ? zlib.gzipSync(Buffer.from(jsonText)) : Buffer.from(jsonText);
  const header = Buffer.from([0x11, (type << 4) | flags, (0x01 << 4) | comp, 0x00]);
  const seqBuf = Buffer.alloc(4);
  seqBuf.writeUInt32BE(seq);
  const size = Buffer.alloc(4);
  size.writeUInt32BE(body.length);
  return Buffer.concat([header, seqBuf, size, body]);
}

function startMock(handler) {
  return new Promise((resolve) => {
    const server = http.createServer();
    const wss = new WebSocketServer({ server, path: '/api/v3/sauc/bigmodel_nostream' });
    wss.on('connection', (socket, req) => {
      socket.on('message', (data) => handler(socket, req, Buffer.from(data)));
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ port, close: () => { wss.close(); server.close(); } });
    });
  });
}

test('WS 一句话识别：协议帧、gzip 请求体与最终结果解析', async () => {
  const seen = { headers: null, requests: [], audioBytes: 0, lastFlags: null };
  const mock = await startMock((socket, req, data) => {
    seen.headers = req.headers;
    const msg = unpackClientMessage(data);
    if (msg.type === 0x01) {
      seen.requests.push(JSON.parse(msg.payload.toString('utf8')));
      assert.strictEqual(msg.ser, 1);
      assert.strictEqual(msg.comp, 1);
      socket.send(buildServerFrame(JSON.stringify({ code: 0, result: { text: '' } }), { flags: 0x01, seq: 1 }));
      return;
    }
    if (msg.type === 0x02) {
      seen.audioBytes += msg.payload.length;
      seen.lastFlags = msg.flags;
      if (msg.flags === 0x02) {
        socket.send(buildServerFrame(JSON.stringify({
          code: 0,
          audio_info: { duration: 3000 },
          result: { additions: { log_id: 'mock-logid' }, text: 'これはテストです', utterances: [
            { start_time: 0, end_time: 3000, text: 'これはテストです', additions: { lid_lang: 'speech_ja' } },
          ] },
        }), { flags: 0x03, seq: 3 }));
      }
    }
  });

  const pcm = Buffer.alloc(32000 * 2, 1); // 2 秒 16k 16bit
  const result = await asr.recognizeByWs({
    pcm,
    audio: { format: 'pcm', codec: 'raw', rate: 16000, bits: 16, channel: 1 },
    request: { model_name: 'bigmodel', enable_lid: true, show_utterances: true },
    auth: { apiKey: 'test-key', resourceId: 'volc.seedasr.sauc.duration' },
    gapMs: 1,
    timeoutMs: 5000,
    connect: (url, headers) => require('../lib/ws').connect(`ws://127.0.0.1:${mock.port}/api/v3/sauc/bigmodel_nostream`, headers),
  });
  mock.close();

  assert.strictEqual(result.ok, true, result.error);
  assert.strictEqual(seen.headers['x-api-key'], 'test-key');
  assert.strictEqual(seen.headers['x-api-resource-id'], 'volc.seedasr.sauc.duration');
  assert.strictEqual(seen.requests[0].audio.format, 'pcm');
  assert.strictEqual(seen.requests[0].request.enable_lid, true);
  assert.strictEqual(seen.audioBytes, pcm.length);
  assert.strictEqual(seen.lastFlags, 0x02);
  assert.strictEqual(result.response.result.text, 'これはテストです');
  assert.strictEqual(result.response.result.utterances[0].additions.lid_lang, 'speech_ja');
});

test('解析服务端错误帧', () => {
  const message = 'invalid audio format';
  const body = Buffer.from(message);
  const header = Buffer.from([0x11, (0x0f << 4) | 0x00, (0x01 << 4) | 0x00, 0x00]);
  const code = Buffer.alloc(4); code.writeUInt32BE(45000151);
  const size = Buffer.alloc(4); size.writeUInt32BE(body.length);
  const parsed = asr.parseServerMessage(Buffer.concat([header, code, size, body]));
  assert.strictEqual(parsed.kind, 'error');
  assert.strictEqual(parsed.code, 45000151);
  assert.strictEqual(parsed.text, message);
});

test('本地音频只接受 pcm 16k 单声道元数据', () => {
  assert.throws(() => asr.validateConfig('ws', { apiKey: 'k', resourceId: 'volc.seedasr.sauc.duration' },
    { format: 'mp3', codec: 'raw', rate: 16000, bits: 16, channel: 1 },
    { model_name: 'bigmodel' }), /不能修改/);
});

test('拒绝未知参数而不是静默忽略', () => {
  assert.throws(() => asr.validateConfig('ws', { apiKey: 'k', resourceId: 'volc.seedasr.sauc.duration' },
    { format: 'pcm', codec: 'raw', rate: 16000, bits: 16, channel: 1 },
    { model_name: 'bigmodel', enable_unknown_thing: true }), /未支持参数/);
});

test('enable_auto_lang 与 corpus 互斥', () => {
  assert.throws(() => asr.validateConfig('ws', { apiKey: 'k', resourceId: 'volc.seedasr.sauc.duration' },
    { format: 'pcm', codec: 'raw', rate: 16000, bits: 16, channel: 1 },
    { model_name: 'bigmodel', enable_auto_lang: true, corpus: {} }), /不能同时使用/);
});

test('end_window_size 范围校验', () => {
  assert.throws(() => asr.validateConfig('ws', { apiKey: 'k', resourceId: 'volc.seedasr.sauc.duration' },
    { format: 'pcm', codec: 'raw', rate: 16000, bits: 16, channel: 1 },
    { model_name: 'bigmodel', end_window_size: 100 }), /300–5000/);
});

test('HTTP 模式拒绝 URL 中的账号密码', () => {
  assert.throws(() => asr.validateConfig('http', { apiKey: 'k', resourceId: 'volc.bigasr.auc_turbo' },
    { url: 'https://user:pass@example.com/a.wav', format: 'wav' },
    { model_name: 'bigmodel' }), /账号密码/);
});
