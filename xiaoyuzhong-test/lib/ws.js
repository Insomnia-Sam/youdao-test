'use strict';
// 使用成熟的 ws 实现握手、TLS 校验、分片、ping/pong 和客户端掩码。
const WebSocket = require('ws');
function connect(url, headers, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, {
      headers, handshakeTimeout: timeoutMs, maxPayload: 8 * 1024 * 1024,
      perMessageDeflate: false, followRedirects: false,
    });
    let responseHeaders = {};
    const handlers = {};
    const pending = [];
    let opened = false;
    socket.on('upgrade', response => { responseHeaders = response.headers; });
    socket.on('unexpected-response', (_req, res) => {
      const err = new Error(`WebSocket 握手失败：HTTP ${res.statusCode}；请检查鉴权、资源 ID 和服务权限。`);
      err.responseHeaders = res.headers;
      res.resume(); socket.terminate(); reject(err);
    });
    socket.on('error', err => {
      if (!opened) reject(err);
      else if (handlers.error) handlers.error(err);
    });
    socket.on('message', data => {
      if (handlers.message) handlers.message(Buffer.from(data));
      else pending.push(Buffer.from(data));
    });
    socket.on('close', (code, reason) => {
      if (!opened) reject(new Error(`握手结束前连接关闭 (${code})`));
      if (handlers.close) handlers.close(code, reason.toString());
    });
    socket.on('open', () => {
      opened = true;
      resolve({
        headers: responseHeaders,
        onMessage(fn) { handlers.message = fn; while (pending.length) fn(pending.shift()); },
        onError(fn) { handlers.error = fn; },
        onClose(fn) { handlers.close = fn; },
        send(payload) {
          if (socket.readyState !== WebSocket.OPEN) throw new Error('WebSocket 未连接');
          socket.send(payload, { binary: true });
        },
        close() { socket.terminate(); },
      });
    });
  });
}
module.exports = { connect };
