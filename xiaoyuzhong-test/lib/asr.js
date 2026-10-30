'use strict';
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const transport = require('./ws');
const WS_URL = 'wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_nostream';
const HTTP_URL = 'https://openspeech.bytedance.com/api/v3/auc/bigmodel/recognize/flash';
const RESOURCE_IDS = {
  ws: ['volc.seedasr.sauc.duration', 'volc.seedasr.sauc.concurrent', 'volc.bigasr.sauc.duration', 'volc.bigasr.sauc.concurrent'],
  http: ['volc.bigasr.auc_turbo'],
};
const boolParams = ['enable_auto_lang','enable_lid','show_utterances','enable_itn','enable_punc','enable_ddc','show_speech_rate','show_volume','enable_speaker_info','enable_emotion_detection','enable_gender_detection','enable_age_detection','vad_segment','enable_channel_split','enable_poi_fc','enable_music_fc'];
const stringParams = ['model_name','result_type','output_zh_variant','translate_source_language','translate_target_language','sensitive_words_filter'];
const numParams = ['end_window_size','force_to_speech_time','vad_segment_duration'];
const LANGUAGES = ['', 'zh-CN','en-US','ja-JP','id-ID','es-MX','pt-BR','de-DE','fr-FR','ko-KR','fil-PH','ms-MY','th-TH','ar-SA','it-IT','bn-BD','el-GR','nl-NL','ru-RU','tr-TR','vi-VN','pl-PL','ro-RO','ne-NP','uk-UA','yue-CN'];
function plain(value) { return !!value && typeof value === 'object' && !Array.isArray(value); }
function validateConfig(mode, auth, audio, request) {
  if (!RESOURCE_IDS[mode]) throw new Error('未知接口模式');
  if (!plain(auth) || !plain(audio) || !plain(request)) throw new Error('auth、audio、request 必须是对象');
  if (!RESOURCE_IDS[mode].includes(auth.resourceId)) throw new Error('资源 ID 与当前接口不匹配');
  for (const key of ['apiKey','appKey','accessKey']) {
    if (auth[key] && (typeof auth[key] !== 'string' || /[\r\n]/.test(auth[key]) || auth[key].length > 4096)) throw new Error('凭据格式不合法');
  }
  if (!auth.apiKey && !(auth.appKey && auth.accessKey)) throw new Error('请填写 API Key，或 App ID + Access Token');
  for (const [key, value] of Object.entries(request)) {
    if (boolParams.includes(key)) { if (typeof value !== 'boolean') throw new Error(`${key} 必须是布尔值`); }
    else if (stringParams.includes(key)) { if (typeof value !== 'string') throw new Error(`${key} 必须是字符串`); }
    else if (numParams.includes(key)) { if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${key} 必须是非负整数`); }
    else if (key === 'corpus') { if (!plain(value)) throw new Error('corpus 必须是对象'); }
    else throw new Error(`当前控制台未支持参数 ${key}，未提交请求；请先按接口文档确认。`);
  }
  if (request.model_name !== 'bigmodel') throw new Error('model_name 必须是 bigmodel');
  if (request.end_window_size !== undefined && (request.end_window_size < 300 || request.end_window_size > 5000)) throw new Error('end_window_size 范围为 300–5000 ms');
  if (request.enable_auto_lang && request.corpus) throw new Error('enable_auto_lang 与 corpus 热词/上下文不能同时使用');
  if (request.enable_speaker_info && !request.show_utterances) throw new Error('说话人分离需要 show_utterances=true');
  if (request.enable_speaker_info && audio.language && audio.language !== 'zh-CN') throw new Error('说话人分离仅在未指定语种或 zh-CN 时生效');
  if (audio.language !== undefined && !LANGUAGES.includes(audio.language)) throw new Error('未知语种代码');
  const allowedAudio = mode === 'ws' ? ['format','codec','rate','bits','channel','language'] : ['url','format','codec','rate','bits','channel','language'];
  for (const key of Object.keys(audio)) if (!allowedAudio.includes(key)) throw new Error(`未知音频参数 ${key}`);
  if (mode === 'ws' && (audio.format !== 'pcm' || audio.codec !== 'raw' || audio.rate !== 16000 || audio.bits !== 16 || audio.channel !== 1)) throw new Error('上传和录音已经转换为 PCM / 16kHz / 16bit / 单声道，不能修改这些元数据');
  if (mode === 'http') {
    let url; try { url = new URL(audio.url); } catch { throw new Error('请填写合法的音频 URL'); }
    if (!['https:','http:'].includes(url.protocol) || url.username || url.password) throw new Error('音频 URL 必须是无账号密码的 HTTP(S) 链接');
    if (!['wav','mp3','ogg','spx','amr','aac','m4a'].includes(audio.format)) throw new Error('极速版不支持该音频格式');
    for (const p of ['result_type','output_zh_variant','translate_source_language','translate_target_language','enable_age_detection','enable_speaker_info','show_speech_rate','show_volume','enable_emotion_detection','enable_gender_detection','force_to_speech_time','vad_segment_duration']) {
      if (request[p] !== undefined) throw new Error(`极速版当前文档未列出 ${p}，请删除或改用一句话识别`);
    }
  }
  return { audio: { ...audio }, request: { ...request } };
}
function authHeaders(auth) {
  return { ...(auth.apiKey ? { 'X-Api-Key': auth.apiKey } : { 'X-Api-App-Key': auth.appKey, 'X-Api-Access-Key': auth.accessKey }), 'X-Api-Resource-Id': auth.resourceId };
}
function packMessage(type, flags, ser, comp, payload) {
  const body = comp === 1 ? zlib.gzipSync(payload) : payload;
  const size = Buffer.alloc(4); size.writeUInt32BE(body.length);
  return Buffer.concat([Buffer.from([0x11,(type << 4)|flags,(ser << 4)|comp,0]),size,body]);
}
function parseServerMessage(buf) {
  if (buf.length < 8 || (buf[0] >> 4) !== 1) throw new Error('响应协议头不合法');
  const type = buf[1] >> 4, flags = buf[1] & 15, comp = buf[2] & 15, ser = buf[2] >> 4;
  let off = (buf[0] & 15) * 4, sequence = null, code = null;
  if (off < 4 || off > buf.length) throw new Error('响应头长度不合法');
  const read = () => { if (off + 4 > buf.length) throw new Error('响应帧截断'); const n=buf.readUInt32BE(off); off+=4; return n; };
  if (type === 15) code = read();
  else if (flags & 1) { const n=read(); sequence=n>0x7fffffff?n-0x100000000:n; }
  const size=read(); if (size > buf.length-off) throw new Error('响应 payload 长度不匹配');
  let payload=buf.subarray(off, off+size); if (comp === 1) payload=zlib.gunzipSync(payload,{maxOutputLength:8*1024*1024}); else if (comp !== 0) throw new Error('未支持的压缩类型');
  const text=payload.toString('utf8'); let json=null; if (ser===1) { try { json=JSON.parse(text); } catch { if (type !== 15) throw new Error('响应 JSON 不合法'); } }
  return { kind: type===15?'error':'result', type, flags, sequence, code, json, text, final: !!(flags & 2) || (sequence !== null && sequence < 0) };
}
async function recognizeByWs(options) {
  const { pcm, audio, request, auth, timeoutMs=90000, gapMs=100, signal, log=()=>{}, connect=transport.connect }=options;
  validateConfig('ws',auth,audio,request);
  if (!Buffer.isBuffer(pcm) || !pcm.length || pcm.length % 2) throw new Error('PCM 音频为空或长度不合法');
  if (pcm.length > 16000*2*180) throw new Error('本地调试控制台最多接收 180 秒音频');
  const started=Date.now(), id=crypto.randomUUID();
  const body={audio,request};
  let client;
  try { client=await connect(WS_URL,{...authHeaders(auth),'X-Api-Connect-Id':id,'X-Api-Request-Id':id}); }
  catch (err) { return {ok:false,mode:'ws',endpoint:WS_URL,request:body,response:null,error:err.message,headers:err.responseHeaders||{},elapsedMs:Date.now()-started}; }
  return new Promise(resolve=>{
    let complete=false, sender=null, timer=null, lastJson=null;
    const frames=[];
    const done=(error=null)=>{
      if (complete) return; complete=true; clearTimeout(timer); clearTimeout(sender);
      signal?.removeEventListener('abort',abort); client.close();
      resolve({ok:!error,mode:'ws',endpoint:WS_URL,request:body,response:lastJson,frames,error,headers:client.headers,elapsedMs:Date.now()-started});
    };
    const abort=()=>done('已取消请求');
    timer=setTimeout(()=>done('等待最终识别响应超时；保留已收到的原始响应'),timeoutMs + Math.ceil(pcm.length / 32000 * 1000));
    signal?.addEventListener('abort',abort,{once:true});
    if (signal?.aborted) { abort(); return; }
    client.onError(err=>done(err.message));
    client.onClose((code)=>done(`连接关闭 (${code})，未收到最终结果；不能视为识别完成`));
    client.onMessage(buf=>{
      try {
        const frame=parseServerMessage(buf); frames.push(frame); log({type:'response',frame});
        if (frame.kind==='error') { done(`服务端错误 ${frame.code}: ${frame.text}`); return; }
        if (frame.json) lastJson=frame.json;
        if (frame.json && typeof frame.json.code==='number' && ![0,20000000].includes(frame.json.code)) {done(`服务端业务错误 ${frame.json.code}`); return;}
        if (frame.final) { if (!lastJson) done('最终帧没有 JSON 识别结果'); else done(); }
      } catch(err) {done(`解析响应失败：${err.message}`);}
    });
    try {
      client.send(packMessage(1,0,1,1,Buffer.from(JSON.stringify(body))));
      log({type:'status',message:'鉴权握手成功，已发送请求参数'});
      const chunkBytes=3200, total=Math.ceil(pcm.length/chunkBytes); let sent=0;
      const pump=()=>{
        if(complete) return;
        try {
          const end=Math.min(pcm.length,(sent+1)*chunkBytes), final=end===pcm.length;
          client.send(packMessage(2,final?2:0,0,1,pcm.subarray(sent*chunkBytes,end)));
          sent++; log({type:'progress',sent,total});
          if(!final) sender=setTimeout(pump,gapMs);
          else log({type:'status',message:'音频已发送完毕，等待最终结果'});
        } catch(err){done(err.message);}
      };
      pump();
    }catch(err){done(err.message);}
  });
}
async function recognizeByHttpUrl({audio,request,auth,timeoutMs=90000,signal}) {
  validateConfig('http',auth,audio,request);
  const started=Date.now(), body={audio,request};
  const signals=[AbortSignal.timeout(timeoutMs)]; if(signal)signals.push(signal);
  try {
    const res=await fetch(HTTP_URL,{method:'POST',redirect:'error',headers:{'Content-Type':'application/json',...authHeaders(auth),'X-Api-Request-Id':crypto.randomUUID(),'X-Api-Sequence':'-1'},body:JSON.stringify(body),signal:AbortSignal.any(signals)});
    const raw=await res.text(); let json=null; try{json=JSON.parse(raw);}catch{}
    const headers=Object.fromEntries(res.headers), code=res.headers.get('x-api-status-code');
    const ok=res.ok && code==='20000000';
    return {ok,mode:'http',endpoint:HTTP_URL,request:body,headers,httpStatus:res.status,response:json,raw,elapsedMs:Date.now()-started,error:ok?null:`HTTP ${res.status} / ${code||'缺少业务状态码'} / ${res.headers.get('x-api-message')||''}`};
  }catch(err){return {ok:false,mode:'http',endpoint:HTTP_URL,request:body,response:null,error:err.message,elapsedMs:Date.now()-started};}
}
module.exports={recognizeByWs,recognizeByHttpUrl,parseServerMessage,packMessage,authHeaders,validateConfig,RESOURCE_IDS};
