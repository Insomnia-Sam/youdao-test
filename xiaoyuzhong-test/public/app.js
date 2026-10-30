'use strict';

const $ = (id) => document.getElementById(id);
const STORE_PARAMS = 'xyzh.console.params.v1';
const STORE_CREDS = 'xyzh.console.creds.v1';


const LANG_LABELS = {
  'zh-CN': '中文普通话', 'yue-CN': '粤语', 'en-US': '英语', 'ja-JP': '日语', 'ko-KR': '韩语',
  'th-TH': '泰语', 'vi-VN': '越南语', 'id-ID': '印尼语', 'ms-MY': '马来语', 'fil-PH': '菲律宾语',
  'es-MX': '西班牙语', 'pt-BR': '葡萄牙语', 'de-DE': '德语', 'fr-FR': '法语', 'it-IT': '意大利语',
  'ru-RU': '俄语', 'ar-SA': '阿拉伯语', 'tr-TR': '土耳其语', 'nl-NL': '荷兰语', 'pl-PL': '波兰语',
  'uk-UA': '乌克兰语',
  speech_mand: '普通话（说话）',
  speech_en: '英语（说话）',
  speech_dia_cant: '粤语（说话）',
  speech_dia_nan: '闽南语',
  speech_dia_wuu: '吴语 / 上海话',
  speech_dia_xina: '西南官话 / 四川话',
  speech_dia_zgyu: '中原官话 / 陕西话',
  speech_ja: '日语（仅标签）',
  speech_ko: '韩语（仅标签）',
  speech_th: '泰语（仅标签）',
  speech_hi: '印地语（仅标签）',
  speech_kk: '哈萨克语（仅标签）',
  speech_bo: '藏语（仅标签）',
  speech_ug: '维语（仅标签）',
  speech_mn: '蒙古语（仅标签）',
  speech_dia_hak: '客家话（仅标签）',
  speech_dia_chao: '潮汕话（仅标签）',
  speech_dia_hsn: '湘语（仅标签）',
  speech_dia_jin: '晋语（仅标签）',
  speech_dia_gan: '赣语（仅标签）',
  speech_dia_mnp: '闽北语（仅标签）',
  speech_dia_czh: '徽语（仅标签）',
  speech_dia_cdo: '闽东话（仅标签）',
  speech_dia_ql: '琼雷话（仅标签）',
  speech_dia_juai: '江淮官话（仅标签）',
  speech_dia_lany: '兰银官话（仅标签）',
  speech_dia_dbiu: '东北官话（仅标签）',
  speech_dia_jliu: '胶辽官话（仅标签）',
  speech_dia_jlua: '冀鲁官话（仅标签）',
  singing_en: '英语（唱歌）',
  singing_mand: '普通话（唱歌）',
  singing_dia_cant: '粤语（唱歌）',
  other_langs: '其它语种人声',
  others: '检测不出',
};

const state = {
  tab: 'record',
  pcm: null,          // Int16Array
  wavUrl: null,
  duration: 0,        // 秒
  sourceName: '',
  recording: false,
  controller: null,
  pendingRequest: null,
};

/* ---------- 工具 ---------- */

function pad(n) { return String(n).padStart(2, '0'); }
function fmtClock(sec) { return `${pad(Math.floor(sec / 60))}:${pad(Math.floor(sec % 60))}`; }
function fmtMs(ms) { if (ms == null) return '—'; return ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${ms} ms`; }

function writeString(view, offset, text) {
  for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
}

function encodeWav(int16, sampleRate) {
  const buffer = new ArrayBuffer(44 + int16.length * 2);
  const view = new DataView(buffer);
  writeString(view, 0, 'RIFF');
  view.setUint32(4, 36 + int16.length * 2, true);
  writeString(view, 8, 'WAVE');
  writeString(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeString(view, 36, 'data');
  view.setUint32(40, int16.length * 2, true);
  new Int16Array(buffer, 44).set(int16);
  return buffer;
}

async function resample(input, inRate, outRate) {
  if (inRate === outRate) return input;
  const length = Math.max(1, Math.round(input.length * outRate / inRate));
  const offline = new OfflineAudioContext(1, length, outRate);
  const buffer = offline.createBuffer(1, input.length, inRate);
  buffer.copyToChannel(input, 0);
  const source = offline.createBufferSource();
  source.buffer = buffer;
  source.connect(offline.destination);
  source.start();
  return (await offline.startRendering()).getChannelData(0);
}

function toInt16(float32) {
  const out = new Int16Array(float32.length);
  for (let i = 0; i < float32.length; i++) {
    const s = Math.max(-1, Math.min(1, float32[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

function mixToMono(buffer) {
  const channels = buffer.numberOfChannels;
  if (channels === 1) return buffer.getChannelData(0);
  const len = buffer.length;
  const out = new Float32Array(len);
  for (let c = 0; c < channels; c++) {
    const data = buffer.getChannelData(c);
    for (let i = 0; i < len; i++) out[i] += data[i] / channels;
  }
  return out;
}

function setClip(int16, sampleRate, sourceName) {
  if (!int16.length || int16.length > 16000 * 180) throw new Error('音频必须非空，且不能超过 180 秒');
  state.pcm = int16;
  state.duration = int16.length / sampleRate;
  state.sourceName = sourceName;
  const wav = encodeWav(int16, sampleRate);
  if (state.wavUrl) URL.revokeObjectURL(state.wavUrl);
  state.wavUrl = URL.createObjectURL(new Blob([wav], { type: 'audio/wav' }));
  const player = $('player');
  player.hidden = false;
  player.src = state.wavUrl;
  $('clipTag').textContent = `${state.duration.toFixed(1)} s`;
  $('clip').querySelector('.clip-info')?.remove();
  const info = document.createElement('div');
  info.className = 'clip-info';
  const spanSource = document.createElement('span');
  spanSource.textContent = '来源 ';
  const bSource = document.createElement('b');
  bSource.textContent = sourceName;
  spanSource.appendChild(bSource);
  const spanDur = document.createElement('span');
  spanDur.textContent = `时长 ${state.duration.toFixed(2)} s`;
  const spanFmt = document.createElement('span');
  spanFmt.textContent = '已转为 16 kHz / 16 bit / 单声道';
  info.append(spanSource, spanDur, spanFmt);
  $('clip').prepend(info);
  $('statDuration').textContent = `${state.duration.toFixed(2)} s`;
}

/* ---------- 页签 ---------- */

function setTab(tab) {
  state.tab = tab;
  document.querySelectorAll('.tab').forEach((el) => el.classList.toggle('is-active', el.dataset.tab === tab));
  document.querySelectorAll('.panel').forEach((el) => el.classList.toggle('is-active', el.dataset.panel === tab));
  const isHttp = tab === 'url';
  $('modeTag').textContent = isHttp ? '极速版（HTTP）' : '一句话识别（WS）';
  document.querySelectorAll('.ws-only').forEach((el) => {
    el.style.display = isHttp ? 'none' : '';
  });
  fillResourceIds(isHttp ? 'http' : 'ws');
  $('runHint').textContent = isHttp
    ? '这条路径把音频链接交给录音文件识别极速版，同步返回完整结果。'
    : '本地音频走 WebSocket 一句话识别，先在本机转成 16 kHz PCM 再发送。';
}

document.querySelectorAll('.tab').forEach((el) => el.addEventListener('click', () => setTab(el.dataset.tab)));

function fillResourceIds(mode) {
  const urlIds = ['volc.bigasr.auc_turbo'];
  const wsIds = ['volc.seedasr.sauc.duration', 'volc.seedasr.sauc.concurrent', 'volc.bigasr.sauc.duration', 'volc.bigasr.sauc.concurrent'];
  const list = mode === 'http' ? urlIds : wsIds;
  const sel = $('resourceId');
  const prev = sel.value;
  sel.innerHTML = list.map((id) => `<option value="${id}">${id}</option>`).join('');
  if (list.includes(prev)) sel.value = prev;
}

/* ---------- 录音 ---------- */

let recorder = null;

function drawWave() {
  const canvas = $('wave');
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
    canvas.width = w * dpr;
    canvas.height = h * dpr;
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  const bars = recorder ? recorder.levels : [];
  ctx.fillStyle = '#0b6b5b';
  const slot = Math.max(2, Math.floor(w / 64));
  bars.forEach((level, i) => {
    const bh = Math.max(2, Math.min(h - 6, level * (h - 6)));
    ctx.fillRect(4 + i * slot, (h - bh) / 2, Math.max(2, slot - 2), bh);
  });
}

async function listMics() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const mics = devices.filter((d) => d.kind === 'audioinput');
    const sel = $('micDevice');
    const prev = sel.value;
    sel.replaceChildren(new Option('系统默认', ''));
    mics.forEach((d, i) => sel.appendChild(new Option(d.label || `麦克风 ${i + 1}`, d.deviceId)));
    if ([...sel.options].some((o) => o.value === prev)) sel.value = prev;
  } catch (_) { /* ignore */ }
}

async function startRecording() {
  if (!navigator.mediaDevices?.getUserMedia) {
    alert('当前浏览器不支持麦克风采集，请改用上传文件。');
    return;
  }
  const deviceId = $('micDevice').value;
  const audio = { channelCount: 1, echoCancellation: true, noiseSuppression: true };
  if (deviceId) audio.deviceId = { exact: deviceId };
  const stream = await navigator.mediaDevices.getUserMedia({ audio });
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  if (ctx.state === 'suspended') await ctx.resume();
  await listMics();
  const source = ctx.createMediaStreamSource(stream);
  const proc = ctx.createScriptProcessor(4096, 1, 1);
  const chunks = [];
  const levels = [];
  const startedAt = performance.now();

  proc.onaudioprocess = (event) => {
    const data = event.inputBuffer.getChannelData(0);
    chunks.push(new Float32Array(data));
    let peak = 0;
    for (let i = 0; i < data.length; i++) peak = Math.max(peak, Math.abs(data[i]));
    if (recorder) recorder.maxPeak = Math.max(recorder.maxPeak, peak);
    levels.push(Math.min(1, peak * 4));
    if (levels.length > 64) levels.shift();
    drawWave();
    const db = peak > 0 ? 20 * Math.log10(peak) : -100;
    const el = $('micLevel');
    el.textContent = db <= -60 ? `输入电平 ${db.toFixed(0)} dB（几乎无声）` : `输入电平 ${db.toFixed(0)} dB`;
    el.classList.toggle('is-silent', db <= -60);
    const elapsed = (performance.now() - startedAt) / 1000;
    $('recTimer').textContent = fmtClock(elapsed);
    if (elapsed >= 180) stopRecording();
  };

  // 走 0 增益节点再进 destination：既让 ScriptProcessor 有运行时，又不把麦克风回放到扬声器造成啸叫。
  const mute = ctx.createGain();
  mute.gain.value = 0;
  source.connect(proc);
  proc.connect(mute);
  mute.connect(ctx.destination);

  recorder = { stream, ctx, proc, source, mute, chunks, levels, startedAt, maxPeak: 0 };
  state.recording = true;
  $('recBtn').textContent = '停止录音';
  $('recBtn').classList.add('is-recording');
  drawWave();
}

async function stopRecording() {
  if (!recorder) return;
  const { stream, ctx, proc, source, mute, chunks, startedAt, maxPeak } = recorder;
  const sampleRate = ctx.sampleRate;
  const elapsed = (performance.now() - startedAt) / 1000;
  proc.onaudioprocess = null;
  try { source.disconnect(); proc.disconnect(); mute.disconnect(); } catch (_) { /* ignore */ }
  stream.getTracks().forEach((t) => t.stop());
  ctx.close();
  recorder = null;
  state.recording = false;
  $('recBtn').textContent = '开始录音';
  $('recBtn').classList.remove('is-recording');
  $('recTimer').textContent = fmtClock(elapsed);
  drawWave();

  const total = chunks.reduce((sum, c) => sum + c.length, 0);
  if (!total) {
    alert('没有采集到音频，请检查麦克风输入。');
    return;
  }
  const merged = new Float32Array(total);
  let offset = 0;
  for (const c of chunks) { merged.set(c, offset); offset += c.length; }
  const down = await resample(merged, sampleRate, 16000);
  setClip(toInt16(down), 16000, '麦克风录音');
  if (maxPeak < 0.01) {
    alert('这段录音几乎全是静音（峰值 ' + (maxPeak ? (20 * Math.log10(maxPeak)).toFixed(0) : '-∞') + ' dB）。\n\n按顺序检查：\n1. 系统设置 → 声音 → 输入：选中的设备是否是你要用的麦克风，输入音量是否接近 0；\n2. 笔记本或耳机上是否有硬件静音键/拨杆；\n3. 页面上“麦克风设备”下拉里换一个设备再录一次，录音时看输入电平有没有到 -30 dB 以上；\n4. 如果输入电平一直不动，说明浏览器拿到的是无声流，可以重启浏览器再试。');
  }
}

$('recBtn').addEventListener('click', async () => {
  try {
    if (state.recording) await stopRecording();
    else {
      $('recTimer').textContent = '00:00';
      await startRecording();
    }
  } catch (err) {
    alert(`启动录音失败：${err.message}`);
  }
});

$('micTest').addEventListener('click', async () => {
  const out = $('micTestOut');
  const say = (text, bad) => {
    out.textContent = text;
    out.classList.toggle('is-bad', !!bad);
  };
  say('正在请求麦克风…');
  let stream;
  try {
    const deviceId = $('micDevice').value;
    stream = await navigator.mediaDevices.getUserMedia({ audio: deviceId ? { deviceId: { exact: deviceId } } : true });
  } catch (err) {
    const hint = {
      NotAllowedError: '浏览器或系统拒绝了麦克风权限',
      NotFoundError: '系统里没有可用的输入设备',
      NotReadableError: '设备被其它程序占用或硬件不可读',
      OverconstrainedError: '选中的设备已经不存在，换回系统默认',
      SecurityError: '当前页面不是安全上下文',
      AbortError: '采集被系统中断',
    }[err.name] || err.message;
    say(`失败：${err.name} — ${hint}`, true);
    return;
  }
  try {
    const track = stream.getAudioTracks()[0];
    const info = track ? track.getSettings() : {};
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === 'suspended') await ctx.resume();
    const source = ctx.createMediaStreamSource(stream);
    const proc = ctx.createScriptProcessor(4096, 1, 1);
    const mute = ctx.createGain();
    mute.gain.value = 0;
    let peak = 0;
    let frames = 0;
    proc.onaudioprocess = (event) => {
      const data = event.inputBuffer.getChannelData(0);
      frames += 1;
      for (let i = 0; i < data.length; i++) peak = Math.max(peak, Math.abs(data[i]));
    };
    source.connect(proc); proc.connect(mute); mute.connect(ctx.destination);
    await new Promise((r) => setTimeout(r, 2000));
    proc.onaudioprocess = null;
    try { source.disconnect(); proc.disconnect(); mute.disconnect(); } catch (_) { /* ignore */ }
    const rate = ctx.sampleRate;
    ctx.close();
    stream.getTracks().forEach((t) => t.stop());
    await listMics();

    const db = peak > 0 ? 20 * Math.log10(peak) : -100;
    const where = info.label || $('micDevice').selectedOptions[0]?.textContent || '未知设备';
    say(`峰值 ${db.toFixed(0)} dB（回调 ${frames} 次，采样率 ${rate} Hz，设备 ${where}）${frames === 0 ? '；回调没触发，采集链路没跑起来' : db <= -60 ? '；电平几乎是静音' : '；电平正常'}`, frames === 0 || db <= -60);
  } catch (err) {
    say(`自检异常：${err.name || ''} ${err.message}`, true);
    stream.getTracks().forEach((t) => t.stop());
  }
});



async function decodeFile(file) {
  const data = await file.arrayBuffer();
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  try {
    if (file.size > 50 * 1024 * 1024) throw new Error('本地上传最大 50MB');
    const buffer = await ctx.decodeAudioData(data.slice(0));
    if (buffer.duration > 180) throw new Error('本地音频最大 180 秒');
    const mono = mixToMono(buffer);
    const down = await resample(mono, buffer.sampleRate, 16000);
    setClip(toInt16(down), 16000, file.name);
  } finally {
    ctx.close();
  }
}

$('file').addEventListener('change', async (event) => {
  const file = event.target.files?.[0];
  if (!file) return;
  try {
    await decodeFile(file);
  } catch (err) {
    alert(`这个文件浏览器无法解码：${err.message}。可以先用工具转成 wav 再上传。`);
  }
});

const drop = $('drop');
['dragenter', 'dragover'].forEach((type) => drop.addEventListener(type, (e) => {
  e.preventDefault();
  drop.classList.add('is-over');
}));
['dragleave', 'drop'].forEach((type) => drop.addEventListener(type, (e) => {
  e.preventDefault();
  drop.classList.remove('is-over');
}));
drop.addEventListener('drop', async (event) => {
  const file = event.dataTransfer?.files?.[0];
  if (!file) return;
  try {
    await decodeFile(file);
  } catch (err) {
    alert(`这个文件浏览器无法解码：${err.message}`);
  }
});

/* ---------- 参数 ---------- */

const BOOL_KEYS = [
  'enable_auto_lang', 'enable_lid', 'show_utterances', 'enable_itn', 'enable_punc', 'enable_ddc',
  'show_speech_rate', 'show_volume', 'enable_speaker_info', 'enable_emotion_detection', 'enable_gender_detection',
];
const WS_ONLY = ['show_speech_rate', 'show_volume', 'enable_speaker_info', 'enable_emotion_detection', 'enable_gender_detection'];

function saveParams() {
  const data = { tab: state.tab, language: $('language').value, end_window_size: $('end_window_size').value, resourceId: $('resourceId').value };
  BOOL_KEYS.forEach((k) => { data[k] = $(k).checked; });
  localStorage.setItem(STORE_PARAMS, JSON.stringify(data));
  if ($('remember').checked) {
    localStorage.setItem(STORE_CREDS, JSON.stringify({ apiKey: $('apiKey').value, appKey: $('appKey').value, accessKey: $('accessKey').value }));
  } else {
    localStorage.removeItem(STORE_CREDS);
  }
}

function restoreParams() {
  const saved = (() => { try { return JSON.parse(localStorage.getItem(STORE_PARAMS) || '{}'); } catch (_) { return {}; } })();
  BOOL_KEYS.forEach((k) => { if (typeof saved[k] === 'boolean') $(k).checked = saved[k]; });
  if (saved.language) $('language').value = saved.language;
  if (saved.end_window_size) $('end_window_size').value = saved.end_window_size;
  if (saved.resourceId) {
    if ([...$('resourceId').options].some((o) => o.value === saved.resourceId)) $('resourceId').value = saved.resourceId;
  }
  try {
    const creds = JSON.parse(localStorage.getItem(STORE_CREDS) || 'null');
    if (creds) {
      $('apiKey').value = creds.apiKey || '';
      $('appKey').value = creds.appKey || '';
      $('accessKey').value = creds.accessKey || '';
      $('remember').checked = true;
    }
  } catch (_) { /* ignore */ }
}

/* ---------- 请求 ---------- */

function buildRequest(mode) {
  const request = { model_name: 'bigmodel' };
  for (const key of BOOL_KEYS) {
    if (mode === 'http' && WS_ONLY.includes(key)) continue;
    request[key] = $(key).checked;
  }
  const end = $('end_window_size').value.trim();
  if (end) request.end_window_size = Number(end);
  return request;
}

function buildAudio(mode) {
  const language = $('language').value;
  if (mode === 'http') {
    const audio = { url: $('audioUrl').value.trim(), format: $('urlFormat').value };
    if (language) audio.language = language;
    return audio;
  }
  const audio = { format: 'pcm', codec: 'raw', rate: 16000, bits: 16, channel: 1 };
  if (language) audio.language = language;
  return audio;
}

function setStatus(text, kind) {
  const el = $('statusTag');
  el.textContent = text;
  el.className = `tag${kind ? ` tag-${kind}` : ''}`;
}

function renderLangBadges(tags) {
  const strip = $('langStrip');
  strip.innerHTML = '';
  if (!tags.length) {
    const div = document.createElement('div');
    div.className = 'lang-badge is-empty';
    div.innerHTML = '<b>无 lid_lang</b><span>本次响应没有语种标签</span>';
    strip.appendChild(div);
    return;
  }
  for (const tag of tags) {
    const div = document.createElement('div');
    div.className = 'lang-badge';
    const b = document.createElement('b');
    b.textContent = LANG_LABELS[tag] || tag;
    const span = document.createElement('span');
    span.textContent = tag;
    div.append(b, span);
    strip.appendChild(div);
  }
}

function showPlaceholder(message) {
  const box = $('textOut');
  box.innerHTML = '';
  const span = document.createElement('span');
  span.className = 'placeholder';
  span.textContent = message;
  box.appendChild(span);
}

function renderResult(payload) {
  const response = payload.response;
  const result = response?.result;
  const text = result?.text || '';
  if (text) $('textOut').textContent = text;
  else showPlaceholder('没有识别文本');

  const durationMs = response?.audio_info?.duration || (state.duration ? Math.round(state.duration * 1000) : 0);
  const utterances = Array.isArray(result?.utterances) ? result.utterances : [];

  const tags = new Set();
  const rootTag = result?.additions?.lid_lang || result?.additions?.language;
  if (rootTag) tags.add(rootTag);
  for (const u of utterances) {
    const t = u?.additions?.lid_lang || u?.additions?.language;
    if (t) tags.add(t);
  }
  renderLangBadges([...tags]);

  const timeline = $('timeline');
  timeline.innerHTML = '';
  if (utterances.length && durationMs) {
    for (const u of utterances) {
      const seg = document.createElement('div');
      seg.className = 'seg';
      const from = Math.max(0, u.start_time || 0);
      const to = Math.min(durationMs, u.end_time || durationMs);
      seg.style.flex = `${Math.max(1, to - from)} 1 0`;
      seg.title = `${(from / 1000).toFixed(2)}–${(to / 1000).toFixed(2)} s：${u.text || ''}`;
      if (u.additions?.lid_lang) seg.style.background = '#0b6b5b';
      timeline.appendChild(seg);
    }
  }

  const list = $('utterances');
  list.innerHTML = '';
  utterances.forEach((u) => {
    const row = document.createElement('div');
    row.className = 'utt';
    const time = document.createElement('time');
    const start = Number(u.start_time || 0) / 1000;
    const end = Number(u.end_time || 0) / 1000;
    time.textContent = `${start.toFixed(2)}–${end.toFixed(2)} s`;
    const body = document.createElement('div');
    body.textContent = u.text || '';
    const extras = [];
    if (u.additions?.lid_lang) extras.push(u.additions.lid_lang);
    if (u.additions?.speaker_id) extras.push(`speaker ${u.additions.speaker_id}`);
    if (u.additions?.speech_rate) extras.push(`${u.additions.speech_rate} token/s`);
    if (u.additions?.volume) extras.push(`${u.additions.volume} dB`);
    if (u.additions?.emotion) extras.push(u.additions.emotion);
    if (u.additions?.gender) extras.push(u.additions.gender);
    if (u.additions?.age) extras.push(`age ${u.additions.age}`);
    if (typeof u.definite === 'boolean') extras.push(u.definite ? 'definite' : '待定');
    if (extras.length) {
      const tagBox = document.createElement('div');
      tagBox.className = 'utt-tags';
      for (const extra of extras) {
        const tag = document.createElement('span');
        tag.className = 'utt-tag';
        tag.textContent = extra;
        tagBox.appendChild(tag);
      }
      body.appendChild(tagBox);
    }
    row.append(time, body);
    list.appendChild(row);
  });

  $('rawJson').textContent = payload.response ? JSON.stringify(payload.response, null, 2) : (payload.raw || payload.error || '无响应体');
  $('reqJson').textContent = JSON.stringify(payload.request || state.pendingRequest, null, 2);
  $('statElapsed').textContent = fmtMs(payload.elapsedMs);
  if (durationMs) $('statDuration').textContent = `${(durationMs / 1000).toFixed(2)} s`;
  $('statLogid').textContent = payload.logid || payload.headers?.['x-tt-logid'] || payload.headers?.['X-Tt-Logid'] || '—';
  $('statLogid').title = $('statLogid').textContent;
}

async function run() {
  const mode = state.tab === 'url' ? 'http' : 'ws';

  let body;
  if ($('jsonOverride').checked) {
    let parsed;
    try {
      parsed = JSON.parse($('paramJson').value);
    } catch (err) {
      alert(`JSON 解析失败：${err.message}`);
      return;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !parsed.audio || !parsed.request || Object.keys(parsed).some(key => !['audio', 'request'].includes(key))) {
      alert('参数 JSON 必须仅包含 audio 和 request 两个对象；凭据请填写左侧鉴权区。');
      return;
    }
    body = { mode, auth: {
      apiKey: $('apiKey').value.trim(),
      appKey: $('appKey').value.trim(),
      accessKey: $('accessKey').value.trim(),
      resourceId: $('resourceId').value,
    }, audio: parsed.audio, request: parsed.request };
  } else {
    body = {
      mode,
      auth: {
        apiKey: $('apiKey').value.trim(),
        appKey: $('appKey').value.trim(),
        accessKey: $('accessKey').value.trim(),
        resourceId: $('resourceId').value,
      },
      request: buildRequest(mode),
      audio: buildAudio(mode),
    };
  }
  const auth = body.auth;

  if (!auth.apiKey && !(auth.appKey && auth.accessKey)) {
    alert('请先填鉴权：新版控制台的 API Key，或旧版的 App ID + Access Token。');
    return;
  }

  if (mode === 'ws') {
    if (!state.pcm || !state.pcm.length) {
      alert('还没有音频：先录一段或上传一个文件。');
      return;
    }
    const bytes = new Uint8Array(state.pcm.buffer, state.pcm.byteOffset, state.pcm.byteLength);
    let binary = '';
    const step = 0x8000;
    for (let i = 0; i < bytes.length; i += step) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + step));
    body.audioBase64 = btoa(binary);
  } else if (!body.audio.url) {
    alert('请填写公网可访问的音频直链。');
    return;
  }

  state.pendingRequest = {audio: body.audio, request: body.request};
  $('reqJson').textContent = JSON.stringify(state.pendingRequest, null, 2);
  $('rawJson').textContent = '等待响应';
  $('langStrip').replaceChildren();
  $('utterances').replaceChildren();
  $('timeline').replaceChildren();
  saveParams();

  state.controller = new AbortController();
  $('run').disabled = true;
  $('stop').disabled = false;
  setStatus('运行中', 'busy');
  $('statLogid').textContent = '—';
  $('statElapsed').textContent = '—';

  try {
    const res = await fetch('/api/recognize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: state.controller.signal,
    });
    if (!res.ok || !res.body) throw new Error(`本机服务返回 HTTP ${res.status}`);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let finalPayload = null;

    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        let event;
        try { event = JSON.parse(line); } catch { continue; }
        if (event.type === 'progress') {
          if (typeof event.sent === 'number') setStatus(`发送 ${event.sent}/${event.total} 包`, 'busy');
          else if (event.message) setStatus(event.message, 'busy');
        } else if (event.type === 'error') {
          throw new Error(event.message);
        } else if (event.type === 'result') {
          finalPayload = event.payload;
        }
      }
    }

    if (!finalPayload) throw new Error('没有收到结果');
    renderResult(finalPayload);
    if (finalPayload.ok) setStatus('成功', 'ok');
    else {
      setStatus('失败', 'fail');
      showPlaceholder(finalPayload.error || '调用失败');
      $('rawJson').textContent = finalPayload.raw || JSON.stringify(finalPayload, null, 2);
    }
  } catch (err) {
    if (err.name === 'AbortError') setStatus('已取消', 'fail');
    else {
      setStatus('失败', 'fail');
      showPlaceholder(String(err.message));
    }
  } finally {
    state.controller = null;
    $('run').disabled = false;
    $('stop').disabled = true;
  }
}

$('run').addEventListener('click', run);
$('fillJson').addEventListener('click', () => {
  const mode = state.tab === 'url' ? 'http' : 'ws';
  $('paramJson').value = JSON.stringify({ audio: buildAudio(mode), request: buildRequest(mode) }, null, 2);
});
$('jsonOverride').addEventListener('change', () => {
  $('paramJson').disabled = !$('jsonOverride').checked;
});
$('stop').addEventListener('click', () => state.controller?.abort());
$('clear').addEventListener('click', () => {
  $('statusTag').textContent = '待运行';
  $('statusTag').className = 'tag';
  $('textOut').innerHTML = '<span class="placeholder">识别文本会显示在这里</span>';
  $('langStrip').innerHTML = '';
  $('timeline').innerHTML = '';
  $('utterances').innerHTML = '';
  $('rawJson').textContent = '—';
  $('reqJson').textContent = '—';
  $('statElapsed').textContent = '—';
  $('statLogid').textContent = '—';
});

['change', 'input'].forEach((type) => {
  document.querySelectorAll('input, select').forEach((el) => el.addEventListener(type, saveParams));
});

/* ---------- 启动 ---------- */

(async function init() {
  fillResourceIds('ws');
  restoreParams();
  setTab(state.tab);
  try {
    const res = await fetch('/api/meta');
    if (res.ok) {
      $('health').textContent = '本机服务正常';
      $('health').className = 'pill pill-ok';
    } else {
      throw new Error('bad');
    }
  } catch (_) {
    $('health').textContent = '本机服务异常';
    $('health').className = 'pill pill-fail';
  }
})();
