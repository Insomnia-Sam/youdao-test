'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const asr = require('./lib/asr');
const HOST = '127.0.0.1';
const PORT = Number(process.env.PORT || 28471);
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_BODY = 9 * 1024 * 1024;
const LOGDIR = path.join(__dirname, 'logs');
fs.mkdirSync(LOGDIR, { recursive: true });
const FILES = {'/':'index.html','/index.html':'index.html','/app.js':'app.js','/style.css':'style.css'};
const MIME={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8'};
function readJsonBody(req) {
  return new Promise((resolve,reject)=>{
    const chunks=[];let size=0;
    req.on('data',chunk=>{size+=chunk.length;if(size>MAX_BODY){reject(new Error('请求超过 9MB；本地音频最多 180 秒'));req.destroy();return;}chunks.push(chunk);});
    req.on('end',()=>{try{resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));}catch{reject(new Error('请求体必须是合法 JSON'));}});
    req.on('error',reject);
  });
}
async function handleRecognize(req,res) {
  const startedAt = new Date();
  const tag = startedAt.toISOString();
  const logLine = (obj) => {
    try {
      fs.appendFileSync(path.join(LOGDIR, 'asr.log'), `${tag} ${JSON.stringify(obj)}\n`);
    } catch (_) { /* ignore */ }
  };
  const redact = (auth) => ({ hasApiKey: !!auth?.apiKey, hasLegacy: !!(auth?.appKey && auth?.accessKey), resourceId: auth?.resourceId });
  res.writeHead(200,{'Content-Type':'application/x-ndjson; charset=utf-8','Cache-Control':'no-store','X-Accel-Buffering':'no'});
  const controller=new AbortController();
  res.on('close',()=>{if(!res.writableEnded)controller.abort();});
  const send=obj=>{if(!res.writableEnded&&!res.destroyed)res.write(JSON.stringify(obj)+'\n');};
  try{
    const payload=await readJsonBody(req);
    const {mode,auth,audio,request}=payload;
    asr.validateConfig(mode,auth,audio,request);
    logLine({event:'request', mode, auth: redact(auth), audio: {...audio, url: audio?.url ? '<url>' : undefined}, request});
    send({type:'progress',message:'参数验证通过，正在建连'});
    let result;
    if(mode==='http')result=await asr.recognizeByHttpUrl({audio,request,auth,signal:controller.signal});
    else{
      const data=payload.audioBase64;
      if(typeof data!=='string'||!data.length||data.length%4!==0||!/^[A-Za-z0-9+/]+={0,2}$/.test(data))throw new Error('缺少合法的 PCM Base64 数据');
      const pcm=Buffer.from(data,'base64');
      result=await asr.recognizeByWs({pcm,audio,request,auth,signal:controller.signal,log:event=>{
        if(event.type==='response')send({type:'frame',frame:event.frame});
        else if(event.type==='progress')send(event);
        else send({type:'progress',message:event.message});
      }});
    }
    logLine({event:'result', ok: result.ok, mode: result.mode, logid: result.logid||result.headers?.['x-tt-logid'], statusCode: result.statusCode, httpStatus: result.httpStatus, error: result.error, frames: result.frames});
    // 不回传任何鉴权字段；模型响应、业务状态与帧保留原样。
    send({type:'result',payload:result});
  }catch(err){
    logLine({event:'thrown', message: err.message});
    send({type:'error',message:err.message});
  }
  finally{if(!res.writableEnded)res.end();}
}
function createServer(){
  return http.createServer(async(req,res)=>{
    res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; media-src 'self' blob:; img-src 'self' data:; worker-src 'self'; frame-ancestors 'none'; base-uri 'self'");
    try{
      // 同源和 Host 校验阻止跨站调用本地代理及 DNS rebinding。
      const authority=req.headers.host||'';
      const hosts=[`127.0.0.1:${PORT}`,`localhost:${PORT}`];
      if(!hosts.includes(authority)){res.writeHead(403).end('Host rejected');return;}
      if(req.headers.origin&&![`http://127.0.0.1:${PORT}`,`http://localhost:${PORT}`].includes(req.headers.origin)){res.writeHead(403).end('Origin rejected');return;}
      const url=new URL(req.url,`http://${authority}`);
      if(req.method==='POST'&&url.pathname==='/api/recognize'){
        if(!String(req.headers['content-type']||'').startsWith('application/json')){res.writeHead(415).end('JSON required');return;}
        await handleRecognize(req,res);return;
      }
      if(req.method==='GET'&&url.pathname==='/api/meta'){
        res.writeHead(200,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});
        res.end(JSON.stringify({resourceIds:asr.RESOURCE_IDS,maxLocalSeconds:180}));return;
      }
      if(req.method==='GET'&&FILES[url.pathname]){
        const name=FILES[url.pathname];
        fs.readFile(path.join(PUBLIC_DIR,name),(err,data)=>{
          if(err){res.writeHead(404).end('Not found');return;}
          res.writeHead(200,{'Content-Type':MIME[path.extname(name)],'Cache-Control':'no-store'});res.end(data);
        });return;
      }
      res.writeHead(req.method==='GET'?404:405).end('Not found');
    }catch{if(!res.headersSent)res.writeHead(500);res.end('server error');}
  });
}
if(require.main===module){
  const server=createServer();
  server.on('error',err=>{console.error(`无法启动：${err.message}`);process.exitCode=1;});
  server.listen(PORT,HOST,()=>console.log(`小语种识别控制台已启动: http://${HOST}:${PORT}/`));
}
module.exports={createServer};
