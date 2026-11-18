import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

const data=mkdtempSync(path.join(tmpdir(),'kf-region-')),calls=[],modes=new Map(),names=new Map();
let mock,base,child,db,topic=100,seq=1000,update=100,logs='',blockingTopic,releaseEdit,editStarted=false,failedRestoreTitle;
const wait=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,timeout=12000){const start=Date.now();while(Date.now()-start<timeout){const result=await fn();if(result)return result;await wait(30);}throw Error('Timed out '+logs.slice(-500));}
async function reserve(){const s=createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const port=s.address().port;await new Promise(r=>s.close(r));return port;}
async function start(){
 child=spawn(process.execPath,['--import',new URL('./fixtures/geo-fetch.mjs',import.meta.url).pathname,'server.mjs'],{env:{...process.env,PORT:new URL(base).port,HOST:'127.0.0.1',PUBLIC_ORIGIN:base,ALLOWED_ORIGINS:'',DATA_DIR:data,BOT_TOKEN:'123:test-token',TG_CHAT_ID:'-100123',STAFF_IDS:'42',WEBHOOK_SECRET:'region-secret',GEO_ENABLED:'1',IP138_TOKEN:'fixture-token',KF_GEO_TEST_URL:`http://127.0.0.1:${mock.address().port}/geo`,TG_API_BASE:`http://127.0.0.1:${mock.address().port}`,NODE_ENV:'test'},stdio:['ignore','pipe','pipe']});
 child.stdout.on('data',d=>logs+=d);child.stderr.on('data',d=>logs+=d);
 await until(async()=>{try{return(await fetch(base+'/healthz')).ok;}catch{return false;}});
}
async function stop(){if(child?.exitCode===null){const ended=new Promise(r=>child.once('exit',r));child.kill('SIGTERM');await ended;}}
async function session(ip){const r=await fetch(base+'/api/session',{method:'POST',headers:{Origin:base,'Content-Type':'application/json','X-Forwarded-For':ip},body:'{}'});assert.equal(r.status,200);const body=await r.json();return {cookie:r.headers.get('set-cookie').split(';')[0],v:db.prepare('SELECT * FROM visitors WHERE number=?').get(Number(body.number))};}
async function hook(v,name,bot=false){const r=await fetch(base+'/telegram/webhook',{method:'POST',headers:{'Content-Type':'application/json','X-Telegram-Bot-Api-Secret-Token':'region-secret'},body:JSON.stringify({update_id:update++,message:{message_id:seq++,message_thread_id:v.topic_id,chat:{id:-100123},from:{id:bot?123:42,is_bot:bot},date:Math.floor(Date.now()/1000),forum_topic_edited:{name}}})});assert.equal(r.status,200);}
const visitor=id=>db.prepare('SELECT * FROM visitors WHERE id=?').get(id);
const regionDone=id=>!db.prepare("SELECT 1 FROM jobs WHERE kind='region' AND json_extract(payload,'$.visitorId')=?").get(id);
before(async()=>{
 mock=createServer(async(req,res)=>{
  try{
   if(req.url.startsWith('/geo/')){
    const url=new URL(req.url,'http://test'),provider=url.pathname.split('/')[2];
    const ip=provider==='ip.cn'?decodeURIComponent(url.pathname.split('/').pop().slice(0,-5)):url.searchParams.get('ip');
    const mode=modes.get(ip)||{};calls.push({method:'lookup',ip,provider});await wait(mode.delay??250);
    if(mode.primaryFail&&provider==='ip.cn'||mode.secondaryFail&&provider==='api.ip138.com'){res.writeHead(503);res.end('unavailable');return;}
    if(provider==='api.ip138.com'){assert.equal(req.headers.token,'fixture-token');res.setHeader('Content-Type','application/json');res.end(JSON.stringify({ret:'ok',ip,data:['中国','浙江','杭州','']}));return;}
    res.setHeader('Content-Type','text/html');res.end(`<table><tr><th>您查询的IP</th><td><span>${ip}</span></td></tr><tr><th>所在地理位置</th><td><span>中国 浙江 杭州</span></td></tr></table>`);return;
   }
   const chunks=[];for await(const c of req)chunks.push(c);const body=chunks.length?JSON.parse(Buffer.concat(chunks)):{};
   const method=req.url.split('/').pop();calls.push({method,body});let result=true;
   if(method==='createForumTopic'){result={message_thread_id:++topic,name:body.name};names.set(topic,body.name);}
   else if(method==='editForumTopic'){
    if(body.message_thread_id===blockingTopic){blockingTopic=null;editStarted=true;await new Promise(r=>releaseEdit=r);}
    if(body.name===failedRestoreTitle){failedRestoreTitle=null;res.setHeader('Content-Type','application/json');res.end(JSON.stringify({ok:false,error_code:500,description:'fixture restore failure'}));return;}
    names.set(body.message_thread_id,body.name);
   }else result={message_id:++seq};
   res.setHeader('Content-Type','application/json');res.end(JSON.stringify({ok:true,result}));
  }catch{res.writeHead(500);res.end('{}');}
 });await new Promise(r=>mock.listen(0,'127.0.0.1',r));base=`http://127.0.0.1:${await reserve()}`;await start();db=new Database(path.join(data,'chat.sqlite'));db.pragma('busy_timeout=5000');
});
after(async()=>{releaseEdit?.();await stop();db?.close();mock.closeAllConnections();await new Promise(r=>mock.close(r));rmSync(data,{recursive:true,force:true});});

test('twenty new visitors receive corrected regions while chat delivery remains independent',async()=>{
 const sessions=await Promise.all(Array.from({length:20},(_,i)=>session(`8.8.4.${i+1}`)));
 const first=sessions[0],form=new FormData();form.set('clientId','region-message');form.set('text','chat must not wait for region backlog');
 const r=await fetch(base+'/api/messages',{method:'POST',headers:{Origin:base,Cookie:first.cookie},body:form});assert.equal(r.status,201);const {message}=await r.json();
 await until(()=>db.prepare('SELECT status FROM messages WHERE id=?').get(message.id).status==='sent');
 assert.ok(sessions.some(({v})=>!regionDone(v.id)),'chat should finish while region tasks remain');
 await until(()=>sessions.every(({v})=>regionDone(v.id)));
 for(const {v}of sessions){const current=visitor(v.id);assert.equal(current.title,`${current.number}-浙江杭州`);assert.equal(names.get(current.topic_id),current.title);}
});

test('primary failure automatically uses the configured IP138 secondary',async()=>{
 const ip='9.9.9.9';modes.set(ip,{primaryFail:true,delay:20});const {v}=await session(ip);await until(()=>regionDone(v.id));
 assert.equal(visitor(v.id).title,`${v.number}-浙江杭州`);assert.deepEqual(calls.filter(c=>c.ip===ip).map(c=>c.provider),['ip.cn','api.ip138.com']);
});

test('both providers failing preserves delivery and a durable region retry survives restart',async()=>{
 const ip='8.8.8.8';modes.set(ip,{primaryFail:true,secondaryFail:true,delay:10});const {v}=await session(ip);
 const job=await until(()=>db.prepare("SELECT * FROM jobs WHERE kind='region' AND json_extract(payload,'$.visitorId')=? AND attempts>0").get(v.id));
 await until(()=>visitor(v.id).topic_id&&db.prepare("SELECT status FROM messages WHERE visitor_id=? AND direction='welcome'").get(v.id)?.status==='sent');
 assert.equal(visitor(v.id).title,`${v.number}-未知地区`);const original=visitor(v.id);
 await stop();modes.set(ip,{delay:10});db.prepare('UPDATE jobs SET available_at=0 WHERE id=?').run(job.id);await start();
 await until(()=>regionDone(v.id));assert.equal(visitor(v.id).title,`${v.number}-浙江杭州`);assert.equal(visitor(v.id).topic_id,original.topic_id);assert.equal(visitor(v.id).token_hash,original.token_hash);
});

test('manual rename while lookup is pending prevents automatic replacement and old bot echoes',async()=>{
 const ip='1.1.1.1';modes.set(ip,{delay:450});const {v}=await session(ip);const current=await until(()=>visitor(v.id).topic_id&&visitor(v.id));
 names.set(current.topic_id,'人工会话名');await hook(current,'人工会话名');await until(()=>visitor(v.id).title==='人工会话名');
 await until(()=>regionDone(v.id));assert.equal(visitor(v.id).title,'人工会话名');assert.equal(visitor(v.id).auto_title,null);assert.equal(names.get(current.topic_id),'人工会话名');
 await hook(current,`${v.number}-浙江杭州`,true);await wait(400);assert.equal(visitor(v.id).title,'人工会话名');
});

test('manual rename crossing an in-flight automatic edit is restored on Telegram',async()=>{
 const ip='1.0.0.1';modes.set(ip,{delay:400});const {v}=await session(ip);const current=await until(()=>visitor(v.id).topic_id&&visitor(v.id));blockingTopic=current.topic_id;editStarted=false;
 await until(()=>editStarted);names.set(current.topic_id,'保留人工修改');await hook(current,'保留人工修改');await until(()=>visitor(v.id).auto_title===null);
 releaseEdit();releaseEdit=null;await until(()=>regionDone(v.id)&&names.get(current.topic_id)==='保留人工修改');assert.equal(visitor(v.id).title,'保留人工修改');assert.equal(visitor(v.id).pending_title,null);
});

test('private addresses use unknown region without failed lookup jobs or external requests',async()=>{
 const {v}=await session('192.168.1.8');await until(()=>visitor(v.id).topic_id);assert.equal(visitor(v.id).title,`${v.number}-未知地区`);assert.ok(regionDone(v.id));assert.ok(!calls.some(c=>c.ip==='192.168.1.8'));
});

test('failed compensation remains durable and retries the manual title instead of losing it',async()=>{
 const ip='4.2.2.2';modes.set(ip,{delay:400});const {v}=await session(ip);const current=await until(()=>visitor(v.id).topic_id&&visitor(v.id));blockingTopic=current.topic_id;editStarted=false;
 await until(()=>editStarted);names.set(current.topic_id,'人工名称需要重试');await hook(current,'人工名称需要重试');await until(()=>visitor(v.id).auto_title===null);
 failedRestoreTitle='人工名称需要重试';releaseEdit();releaseEdit=null;
 const job=await until(()=>db.prepare("SELECT * FROM jobs WHERE kind='restore-title' AND json_extract(payload,'$.visitorId')=? AND attempts>0").get(v.id));
 assert.equal(job.state,'pending');assert.equal(visitor(v.id).title,'人工名称需要重试');
 db.prepare('UPDATE jobs SET available_at=0 WHERE id=?').run(job.id);
 await until(()=>names.get(current.topic_id)==='人工名称需要重试'&&!db.prepare('SELECT 1 FROM jobs WHERE id=?').get(job.id));
});
