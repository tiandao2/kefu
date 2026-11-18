import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { WebSocket } from 'ws';
import sharp from 'sharp';

const base='http://127.0.0.1:15301', origin=base, data=mkdtempSync(path.join(tmpdir(),'kf-test-'));
const delays=new Map();
const calls=[];let seq=1000,topic=10,child,mock,db,update=1,logs='';
const deletedTopics=new Set(),closedTopics=new Set(),inboundTopics=new Map(),faults=[];
const png=await sharp({create:{width:32,height:24,channels:3,background:'#c96'}}).png().toBuffer();
const telegramPhoto=await sharp(png).resize(24,18).jpeg().toBuffer();
const wait=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,timeout=12000){const start=Date.now();while(Date.now()-start<timeout){const v=await fn();if(v)return v;await wait(80);}throw new Error('Timed out. '+logs);}
async function request(url,body,cookie,extra={}){
 const r=await fetch(base+url,{method:body?'POST':'GET',headers:{...(body?{'Content-Type':'application/json',Origin:origin}:{}),...(cookie?{Cookie:cookie}:{}),...extra},body:body?JSON.stringify(body):undefined});
 const text=await r.text();let d;try{d=JSON.parse(text);}catch{d={text};}return {r,d,cookie:r.headers.get('set-cookie')?.split(';')[0]};
}
async function hook(message,edited=false,id=update++){inboundTopics.set(message.message_id,message.message_thread_id);return request('/telegram/webhook',{update_id:id,[edited?'edited_message':'message']:message},null,{'X-Telegram-Bot-Api-Secret-Token':'test-secret'});}
function staff(topicId,message_id,text,from=42){return {message_id,message_thread_id:topicId,chat:{id:-100123,type:'supergroup'},from:{id:from,is_bot:false},date:Math.floor(Date.now()/1000),text};}
before(async()=>{
 mock=createServer(async(req,res)=>{
  if(req.url.startsWith('/file/')){const id=req.url.split('/').pop();if(delays.has('file:'+id))await wait(delays.get('file:'+id));res.end(id==='heic-original'?readFileSync(new URL('./fixtures/solid.heic',import.meta.url)):req.url.includes('doc-')?png:telegramPhoto);return;}
  const chunks=[];for await(const c of req)chunks.push(c);const bytes=Buffer.concat(chunks);
  let body={};if(req.headers['content-type']?.includes('multipart/form-data')){
   const form=await new Request('http://localhost'+req.url,{method:'POST',headers:req.headers,body:bytes}).formData();
   for(const [k,v]of form)body[k]=typeof v==='string'?v:{name:v.name,bytes:Buffer.from(await v.arrayBuffer())};
  }else if(bytes.length)body=JSON.parse(bytes);
  const method=req.url.split('/').pop();const call={method,body};calls.push(call);let result;
  const delay=delays.get(method+':'+(body.text || body.file_id || '')) || delays.get(method);if(delay)await wait(delay);
  let failure=faults.find(f=>f.remaining>0&&f.method===method&&(f.topic===undefined||f.topic===Number(body.message_thread_id))&&(f.message===undefined||f.message===body.message_id)&&(f.fileId===undefined||f.fileId===body.file_id)&&(f.text===undefined||f.text===body.text));
  if(failure)failure.remaining--;
  else if(['sendMessage','sendDocument','sendPhoto','reopenForumTopic'].includes(method)&&deletedTopics.has(Number(body.message_thread_id)))failure={code:400,description:'Bad Request: message thread not found'};
  else if(['sendMessage','sendDocument','sendPhoto'].includes(method)&&closedTopics.has(Number(body.message_thread_id)))failure={code:400,description:'Bad Request: TOPIC_CLOSED'};
  else if(method==='setMessageReaction'&&deletedTopics.has(inboundTopics.get(body.message_id)))failure={code:400,description:'Bad Request: MESSAGE_ID_INVALID'};
  if(failure){call.failed=true;res.setHeader('Content-Type','application/json');res.end(JSON.stringify({ok:false,error_code:failure.code,description:failure.description,parameters:failure.retry_after?{retry_after:failure.retry_after}:undefined}));return;}
  if(method==='createForumTopic')result={message_thread_id:++topic,name:body.name};
  else if(method==='getFile')result={file_path:body.file_id,file_size:body.file_id.startsWith('doc-')?png.length:telegramPhoto.length};
  else if(method==='sendPhoto'){const id=++seq;result={message_id:id,photo:[{file_id:`telegram-largest-${id}`,width:1280,height:960,file_size:telegramPhoto.length},{file_id:`telegram-small-${id}`,width:90,height:90,file_size:10}]};}
  else if(method==='reopenForumTopic'){closedTopics.delete(body.message_thread_id);result=true;}
  else if(method==='setMessageReaction')result=true;
  else result={message_id:++seq};
  res.setHeader('Content-Type','application/json');res.end(JSON.stringify({ok:true,result}));
 });await new Promise(r=>mock.listen(15302,'127.0.0.1',r));
 child=spawn(process.execPath,['server.mjs'],{env:{...process.env,PORT:'15301',HOST:'127.0.0.1',PUBLIC_ORIGIN:origin,ALLOWED_ORIGINS:' https://alternate.example , ',BOT_TOKEN:'test-token',TG_CHAT_ID:'-100123',STAFF_IDS:'42,43',WEBHOOK_SECRET:'test-secret',DATA_DIR:data,TG_API_BASE:'http://127.0.0.1:15302',NODE_ENV:'test',GEO_ENABLED:'0'},stdio:['ignore','pipe','pipe']});
 child.stdout.on('data',d=>logs+=d);child.stderr.on('data',d=>logs+=d);
 await until(async()=>{try{return(await fetch(base+'/healthz')).ok;}catch{return false;}});
 db=new Database(path.join(data,'chat.sqlite'));db.pragma('busy_timeout=5000');
});
after(async()=>{child?.kill('SIGTERM');await new Promise(r=>child.once('exit',r));db?.close();await new Promise(r=>mock.close(r));rmSync(data,{recursive:true,force:true});});

test('full customer / Telegram lifecycle, security boundaries and retention',async()=>{
 const a=await request('/api/session',{});assert.equal(a.r.status,200);assert.equal(a.d.messages.length,1);assert.equal(a.d.messages[0].direction,'welcome');const cookie=a.cookie;
 const v=await until(()=>{const v=db.prepare('SELECT * FROM visitors WHERE number=1').get();return v?.topic_id && v;});assert.ok(v.topic_id);
 assert.equal(v.title,'1-未知地区');assert.equal(calls.find(c=>c.method==='createForumTopic').body.name,'1-未知地区');
 const reopened=await request('/api/session',{},cookie);assert.equal(reopened.d.number,a.d.number);assert.equal(calls.filter(c=>c.method==='createForumTopic').length,1);assert.equal(reopened.d.messages.length,1);
 const b=await request('/api/session',{});assert.notEqual(a.d.number,b.d.number);
 assert.equal((await request('/api/session',{},null,{Origin:'https://evil.example'})).r.status,403);
 assert.equal((await request('/api/messages')).r.status,401);
 assert.equal((await request('/telegram/webhook',{update_id:999})).r.status,403);
 const ws=new WebSocket(base.replace('http','ws')+'/ws',{headers:{Cookie:cookie,Origin:origin}});const events=[];ws.on('message',d=>events.push(JSON.parse(d)));await new Promise(r=>ws.once('open',r));
 const form=new FormData();form.append('clientId','client-test-123');form.append('text','客户文字');
 let r=await fetch(base+'/api/messages',{method:'POST',headers:{Origin:origin,Cookie:cookie},body:form});const own=(await r.json()).message;assert.equal(r.status,201);
 await until(()=>db.prepare('SELECT status FROM messages WHERE id=?').get(own.id)?.status==='sent');
 const duplicate=new FormData();duplicate.append('clientId','client-test-123');duplicate.append('text','客户文字');
 r=await fetch(base+'/api/messages',{method:'POST',headers:{Origin:origin,Cookie:cookie},body:duplicate});assert.equal((await r.json()).message.id,own.id);
 assert.equal(calls.filter(c=>c.body.text==='客户文字').length,1);
 await hook(staff(v.topic_id,501,'客服答复'));
 const reply=await until(()=>db.prepare('SELECT * FROM messages WHERE tg_message_id=501').get());assert.equal(reply.body,'客服答复');await until(()=>events.some(e=>e.message?.id===reply.id));
 await hook(staff(v.topic_id,502,'不允许转发',999));await wait(500);assert.equal(db.prepare('SELECT id FROM messages WHERE tg_message_id=502').get(),undefined);
 await request('/api/read',{ids:[reply.id]},b.cookie);assert.equal(db.prepare('SELECT read_at FROM messages WHERE id=?').get(reply.id).read_at,null);
 await request('/api/read',{ids:[reply.id]},cookie);await request('/api/read',{ids:[reply.id]},cookie);
 await until(()=>calls.some(c=>c.method==='setMessageReaction'&&c.body.message_id===501));assert.equal(calls.filter(c=>c.method==='setMessageReaction'&&c.body.message_id===501).length,1);
 assert.deepEqual(calls.find(c=>c.method==='setMessageReaction'&&c.body.message_id===501).body.reaction,[{type:'emoji',emoji:'👍'}]);assert.ok(!calls.some(c=>c.body.text==='已读'));
 const edited=staff(v.topic_id,501,'编辑后的答复');edited.edit_date=Math.floor(Date.now()/1000);await hook(edited,true);
 await until(()=>db.prepare('SELECT body FROM messages WHERE id=?').get(reply.id).body==='编辑后的答复');await until(()=>calls.some(c=>c.body.text==='已更新'));
 assert.equal(db.prepare('SELECT sent_at FROM messages WHERE id=?').get(reply.id).sent_at,reply.sent_at);
 const revoke=staff(v.topic_id,503,'撤回');revoke.reply_to_message={message_id:501};await hook(revoke);
 await until(()=>db.prepare('SELECT revoked FROM messages WHERE id=?').get(reply.id).revoked===1);await until(()=>calls.some(c=>c.body.text==='已撤回'));
 assert.ok(!(await request('/api/messages',null,cookie)).d.messages.some(m=>m.id===reply.id));assert.ok(!calls.some(c=>c.method==='deleteMessage'));
 const doc=staff(v.topic_id,504,undefined);delete doc.text;doc.document={file_id:'doc-1',file_name:'原图.png',mime_type:'image/png',file_size:png.length};await hook(doc);
 const image=await until(()=>{const m=db.prepare('SELECT * FROM messages WHERE tg_message_id=504').get();return m?.file_status==='ready' && m;});
 r=await fetch(base+`/api/files/${image.id}`,{headers:{Cookie:cookie}});assert.deepEqual(Buffer.from(await r.arrayBuffer()),png);assert.match(r.headers.get('cache-control'),/no-store/);
 assert.equal((await fetch(base+`/api/files/${image.id}`,{headers:{Cookie:b.cookie}})).status,404);
 db.prepare('UPDATE messages SET sent_at=? WHERE id=?').run(Date.now()-86400001,image.id);
 assert.equal((await fetch(base+`/api/files/${image.id}`,{headers:{Cookie:cookie}})).status,404);
 const up=new FormData();up.append('clientId','client-file-123');up.append('text','图片');up.append('file',new Blob([png],{type:'image/png'}),'原图.png');
 r=await fetch(base+'/api/messages',{method:'POST',headers:{Origin:origin,Cookie:cookie},body:up});assert.equal(r.status,201);const upm=(await r.json()).message;
 await until(()=>{const m=db.prepare('SELECT * FROM messages WHERE id=?').get(upm.id);return m.status==='sent' && m.file_status==='ready';});
 assert.deepEqual(calls.find(c=>c.method==='sendPhoto').body.photo.bytes,png);
 assert.equal(db.prepare('SELECT tg_file_id FROM messages WHERE id=?').get(upm.id).tg_file_id.startsWith('telegram-largest-'),true);
 assert.deepEqual(Buffer.from(await (await fetch(base+`/api/files/${upm.id}`,{headers:{Cookie:cookie}})).arrayBuffer()),telegramPhoto);
 assert.equal((await request('/api/messages',null,cookie)).d.messages.find(m=>m.id===upm.id).originalFile,false);
 const compressed=staff(v.topic_id,505,undefined);delete compressed.text;compressed.photo=[{file_id:'photo-large',width:1280,height:960,file_size:png.length},{file_id:'photo-small',width:90,height:90,file_size:10}];compressed.caption='客服直接发送照片';await hook(compressed);
 const photo=await until(()=>{const m=db.prepare('SELECT * FROM messages WHERE tg_message_id=505').get();return m?.file_status==='ready' && m;});assert.equal(photo.kind,'image');assert.equal(photo.tg_file_id,'photo-large');assert.equal(photo.is_photo,1);assert.equal(photo.body,compressed.caption);
 r=await fetch(base+`/api/files/${photo.id}`,{headers:{Cookie:cookie}});assert.deepEqual(Buffer.from(await r.arrayBuffer()),telegramPhoto);
 assert.equal((await request('/api/messages',null,cookie)).d.messages.find(m=>m.id===photo.id).originalFile,false);
 const editedPhoto={...compressed,caption:'照片新说明',photo:[{file_id:'photo-new',width:1500,height:1500,file_size:png.length}],edit_date:Math.floor(Date.now()/1000)};await hook(editedPhoto,true);
 await until(()=>db.prepare('SELECT tg_file_id FROM messages WHERE id=?').get(photo.id).tg_file_id==='photo-new');assert.equal(db.prepare('SELECT body FROM messages WHERE id=?').get(photo.id).body,'照片新说明');
 const revokePhoto=staff(v.topic_id,506,'撤回');revokePhoto.reply_to_message={message_id:505};await hook(revokePhoto);await until(()=>db.prepare('SELECT revoked FROM messages WHERE id=?').get(photo.id).revoked===1);
 assert.equal((await fetch(base+`/api/files/${photo.id}`,{headers:{Cookie:cookie}})).status,404);
 const big=new FormData();big.append('clientId','oversized-file');big.append('file',new Blob([Buffer.alloc(20*1024*1024+1)]),'big.bin');
 r=await fetch(base+'/api/messages',{method:'POST',headers:{Origin:origin,Cookie:cookie},body:big});assert.equal(r.status,400);
 db.prepare('UPDATE messages SET sent_at=? WHERE visitor_id=?').run(Date.now()-86400001,v.id);
 const renewed=await request('/api/session',{},cookie);assert.equal(renewed.d.messages.length,1);assert.equal(renewed.d.messages[0].direction,'welcome');assert.equal(renewed.d.number,a.d.number);assert.equal(db.prepare('SELECT topic_id FROM visitors WHERE id=?').get(v.id).topic_id,v.topic_id);
 const records=db.prepare('SELECT COUNT(*) AS n FROM messages WHERE visitor_id=?').get(v.id).n;assert.ok(records>1,'24-hour expiry must not delete server history');
 ws.close();
});

test('20 concurrent visitors stay isolated and retain their original topics',async()=>{
 const start=Date.now();const sessions=await Promise.all(Array.from({length:20},()=>request('/api/session',{})));
 assert.ok(sessions.every(x=>x.r.status===200));assert.equal(new Set(sessions.map(x=>x.d.number)).size,20);
 const reopened=await Promise.all(sessions.map(x=>request('/api/session',{},x.cookie)));
 for(let i=0;i<sessions.length;i++)assert.equal(reopened[i].d.number,sessions[i].d.number);
 console.log(`20 concurrent mock sessions completed in ${Date.now()-start} ms`);
});

async function freshVisitor(){
 const s=await request('/api/session',{});
 const v=await until(()=>{const v=db.prepare('SELECT * FROM visitors WHERE number=?').get(Number(s.d.number));return v?.topic_id && v;});
 await until(()=>db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE kind='welcome' AND json_extract(payload,'$.messageId') IN (SELECT id FROM messages WHERE visitor_id=?)").get(v.id).n===0);
 return {s,v};
}
async function submit(cookie,id,text,file){
 const form=new FormData();form.append('clientId',id);form.append('text',text);
 if(file)form.append('file',new Blob([file],{type:'image/png'}),'客户原图.png');
 const r=await fetch(base+'/api/messages',{method:'POST',headers:{Origin:origin,Cookie:cookie},body:form});assert.equal(r.status,201);return (await r.json()).message;
}

test('deleted topics recover once, retain identity and custom name, and resume queued text and Telegram photos',async()=>{
 const {s,v}=await freshVisitor();
 await hook({...staff(v.topic_id,10001,undefined),forum_topic_edited:{name:'人工客户名称'}});
 await until(()=>db.prepare('SELECT title FROM visitors WHERE id=?').get(v.id).title==='人工客户名称');
 await hook(staff(v.topic_id,10002,'旧话题客服消息'));
 const oldReply=await until(()=>db.prepare('SELECT * FROM messages WHERE tg_message_id=10002').get());
 await request('/api/read',{ids:[oldReply.id]},s.cookie);
 db.prepare("UPDATE jobs SET available_at=? WHERE kind='read' AND json_extract(payload,'$.messageId')=?").run(Date.now()+60000,oldReply.id);
 const backlog='deleted-topic-backlog';
 db.prepare("INSERT INTO messages(id,visitor_id,client_id,direction,body,sent_at,status) VALUES(?,?,?,'visitor',?,?,'delayed')").run(backlog,v.id,backlog,'恢复前的积压消息',Date.now());
 db.prepare("INSERT INTO jobs(kind,payload,dedup,attempts,available_at,created_at) VALUES('outgoing',?,?,9,?,?)").run(JSON.stringify({messageId:backlog}),`outgoing:${backlog}`,Date.now()+60000,Date.now());
 deletedTopics.add(v.topic_id);
 // Strict ordering waits for the earlier retry rather than overtaking it.
 db.prepare("UPDATE jobs SET available_at=0 WHERE kind='outgoing' AND json_extract(payload,'$.messageId')=?").run(backlog);
 const count=calls.filter(c=>c.method==='createForumTopic').length;
 const sent=await Promise.all([submit(s.cookie,'deleted-text-one','删除后第一条'),submit(s.cookie,'deleted-text-two','删除后第二条'),submit(s.cookie,'deleted-original-file','删除后图片',png)]);
 await until(()=>[backlog,...sent.map(m=>m.id)].every(id=>db.prepare('SELECT status FROM messages WHERE id=?').get(id)?.status==='sent'));
 const current=db.prepare('SELECT * FROM visitors WHERE id=?').get(v.id);
 assert.notEqual(current.topic_id,v.topic_id);assert.equal(current.number,v.number);assert.equal(current.token_hash,v.token_hash);assert.equal(current.title,'人工客户名称');
 assert.equal(calls.filter(c=>c.method==='createForumTopic').length,count+1);
 assert.equal(calls.filter(c=>c.method==='createForumTopic').at(-1).body.name,'人工客户名称');
 assert.ok(sent.every(m=>db.prepare('SELECT tg_topic_id FROM messages WHERE id=?').get(m.id).tg_topic_id===current.topic_id));
 const upload=calls.find(c=>c.method==='sendPhoto'&&!c.failed&&c.body.caption==='删除后图片');assert.deepEqual(upload.body.photo.bytes,png);assert.equal(Number(upload.body.message_thread_id),current.topic_id);
 db.prepare("UPDATE jobs SET available_at=0 WHERE kind='read' AND json_extract(payload,'$.messageId')=?").run(oldReply.id);
 await until(()=>!db.prepare("SELECT id FROM jobs WHERE kind='read' AND json_extract(payload,'$.messageId')=?").get(oldReply.id));
 assert.ok(!calls.some(c=>c.method==='setMessageReaction'&&c.body.message_id===10002));
 assert.equal((await request('/api/session',{},s.cookie)).d.number,s.d.number);
 assert.equal(db.prepare('SELECT body FROM messages WHERE id=?').get(oldReply.id).body,'旧话题客服消息');
});

test('failed topic replacement preserves queued messages and recovers on retry without a new visitor',async()=>{
 const {s,v}=await freshVisitor();deletedTopics.add(v.topic_id);
 faults.push({method:'createForumTopic',remaining:1,code:403,description:'Forbidden: temporary topic management permission failure'});
 const m=await submit(s.cookie,'replacement-retry-file','创建失败后恢复的原图',png);
 await until(()=>db.prepare('SELECT status FROM messages WHERE id=?').get(m.id).status==='delayed');
 assert.equal(db.prepare('SELECT topic_id FROM visitors WHERE id=?').get(v.id).topic_id,null);
 db.prepare("UPDATE jobs SET available_at=0 WHERE kind='outgoing' AND json_extract(payload,'$.messageId')=?").run(m.id);
 await until(()=>db.prepare('SELECT status FROM messages WHERE id=?').get(m.id).status==='sent');
 const current=db.prepare('SELECT * FROM visitors WHERE id=?').get(v.id);assert.notEqual(current.topic_id,v.topic_id);assert.equal(current.token_hash,v.token_hash);assert.equal(current.number,v.number);
 assert.deepEqual(calls.find(c=>c.method==='sendPhoto'&&!c.failed&&c.body.caption==='创建失败后恢复的原图').body.photo.bytes,png);
});

test('closed topics reopen without replacing the visitor topic',async()=>{
 const {s,v}=await freshVisitor();const count=calls.filter(c=>c.method==='createForumTopic').length;
 closedTopics.add(v.topic_id);
 const m=await submit(s.cookie,'closed-topic-message','关闭话题后的消息');
 await until(()=>db.prepare('SELECT status FROM messages WHERE id=?').get(m.id).status==='sent');
 assert.equal(db.prepare('SELECT topic_id FROM visitors WHERE id=?').get(v.id).topic_id,v.topic_id);
 assert.equal(calls.filter(c=>c.method==='createForumTopic').length,count);
 assert.equal(calls.filter(c=>c.method==='reopenForumTopic'&&c.body.message_thread_id===v.topic_id).length,1);
});

test('permission errors and rate limits show delay and retry without creating duplicate topics',async()=>{
 const {s,v}=await freshVisitor();const count=calls.filter(c=>c.method==='createForumTopic').length;
 for(const [code,description,retry_after] of [[403,'Forbidden: bot is not a member of the supergroup',0],[429,'Too Many Requests',1]]){
  faults.push({method:'sendMessage',topic:v.topic_id,remaining:1,code,description,retry_after});
  const m=await submit(s.cookie,`failure-retry-${code}`,`错误恢复 ${code}`);
  await until(()=>db.prepare('SELECT status FROM messages WHERE id=?').get(m.id).status==='delayed');
  assert.equal(calls.filter(c=>c.method==='createForumTopic').length,count);
  db.prepare("UPDATE jobs SET available_at=0 WHERE kind='outgoing' AND json_extract(payload,'$.messageId')=?").run(m.id);
  await until(()=>db.prepare('SELECT status FROM messages WHERE id=?').get(m.id).status==='sent');
 }
 assert.equal(db.prepare('SELECT topic_id FROM visitors WHERE id=?').get(v.id).topic_id,v.topic_id);
});

test('thumbs-up receipts retry transient failures, deduplicate reads, and ignore deleted Telegram messages',async()=>{
 const {s,v}=await freshVisitor();await hook(staff(v.topic_id,10101,'已读重试测试'));
 const m=await until(()=>db.prepare('SELECT * FROM messages WHERE tg_message_id=10101').get());
 faults.push({method:'setMessageReaction',message:10101,remaining:1,code:429,description:'Too Many Requests',retry_after:1});
 await request('/api/read',{ids:[m.id]},s.cookie);
 await until(()=>calls.some(c=>c.method==='setMessageReaction'&&c.body.message_id===10101&&c.failed));
 assert.equal(db.prepare('SELECT read_notified FROM messages WHERE id=?').get(m.id).read_notified,0);
 await request('/api/read',{ids:[m.id]},s.cookie);
 await until(()=>db.prepare('SELECT read_notified FROM messages WHERE id=?').get(m.id).read_notified===1);
 assert.equal(calls.filter(c=>c.method==='setMessageReaction'&&c.body.message_id===10101&&!c.failed).length,1);
 await hook({...staff(v.topic_id,10101,'已读后编辑'),edit_date:Math.floor(Date.now()/1000)},true);
 await until(()=>db.prepare('SELECT body FROM messages WHERE id=?').get(m.id).body==='已读后编辑');
 await request('/api/read',{ids:[m.id]},s.cookie);await wait(400);
 assert.equal(calls.filter(c=>c.method==='setMessageReaction'&&c.body.message_id===10101&&!c.failed).length,1);
 await hook(staff(v.topic_id,10102,'已删除消息的已读'));
 const gone=await until(()=>db.prepare('SELECT * FROM messages WHERE tg_message_id=10102').get());
 faults.push({method:'setMessageReaction',message:10102,remaining:1,code:400,description:'Bad Request: MESSAGE_ID_INVALID'});
 await request('/api/read',{ids:[gone.id]},s.cookie);
 await until(()=>calls.some(c=>c.method==='setMessageReaction'&&c.body.message_id===10102));
 await until(()=>!db.prepare("SELECT id FROM jobs WHERE kind='read' AND json_extract(payload,'$.messageId')=?").get(gone.id));
 assert.ok(!calls.some(c=>c.body.text==='已读'));
});

test('Chinese revoke checks permissions and target topic, never forwards commands, and retains the legacy alias',async()=>{
 const {s,v}=await freshVisitor(),other=await freshVisitor();
 await hook(staff(v.topic_id,10201,'待撤回客服消息'));
 const m=await until(()=>db.prepare('SELECT * FROM messages WHERE tg_message_id=10201').get());
 await hook({...staff(v.topic_id,10202,'撤回',999),reply_to_message:{message_id:10201}});
 await hook({...staff(other.v.topic_id,10203,'撤回'),reply_to_message:{message_id:10201}});
 await hook(staff(v.topic_id,10204,'撤回'));
 await until(()=>calls.some(c=>c.body.reply_parameters?.message_id===10204));
 assert.equal(db.prepare('SELECT revoked FROM messages WHERE id=?').get(m.id).revoked,0);
 const event={...staff(v.topic_id,10205,' 撤回 '),reply_to_message:{message_id:10201}};const id=update++;await hook(event,false,id);await hook(event,false,id);
 await until(()=>db.prepare('SELECT revoked FROM messages WHERE id=?').get(m.id).revoked===1);
 await until(()=>calls.some(c=>c.body.text==='已撤回'&&c.body.reply_parameters?.message_id===10205));
 assert.equal(calls.filter(c=>c.body.text==='已撤回'&&c.body.reply_parameters?.message_id===10205).length,1);
 assert.equal(db.prepare("SELECT COUNT(*) AS n FROM messages WHERE visitor_id=? AND trim(body)='撤回'").get(v.id).n,0);
 await hook(staff(v.topic_id,10206,'请不要撤回这条说明'));
 await until(()=>db.prepare('SELECT id FROM messages WHERE tg_message_id=10206').get());
 await hook({...staff(v.topic_id,10207,'/ch'),reply_to_message:{message_id:10206}});
 await until(()=>db.prepare('SELECT revoked FROM messages WHERE tg_message_id=10206').get().revoked===1);
 assert.ok(!(await request('/api/messages',null,s.cookie)).d.messages.some(x=>x.id===m.id));
});

test('oversized Telegram photos are rejected and unauthorized photos are not forwarded',async()=>{
 const {v}=await freshVisitor();
 const oversized={...staff(v.topic_id,10301,undefined),photo:[{file_id:'oversized-photo',width:4000,height:4000,file_size:20*1024*1024+1}]};
 await hook(oversized);await until(()=>calls.some(c=>c.body.reply_parameters?.message_id===10301&&c.body.text.includes('超过')));
 assert.equal(db.prepare('SELECT id FROM messages WHERE tg_message_id=10301').get(),undefined);
 await hook({...oversized,message_id:10302,from:{id:999,is_bot:false}});await wait(400);
 assert.equal(db.prepare('SELECT id FROM messages WHERE tg_message_id=10302').get(),undefined);
 assert.ok(!calls.some(c=>c.method==='getFile'&&c.body.file_id==='oversized-photo'));
});

test('photo download retries never resend a successful Telegram photo and long captions are retained',async()=>{
 const {s,v}=await freshVisitor();
 faults.push({method:'getFile',remaining:1,code:503,description:'Service unavailable'});
 const caption='图片说明'.repeat(300),m=await submit(s.cookie,'photo-download-retry',caption,png);
 await until(()=>db.prepare('SELECT file_status FROM messages WHERE id=?').get(m.id).file_status==='delayed');
 const waiting=db.prepare('SELECT * FROM messages WHERE id=?').get(m.id);assert.ok(waiting.tg_file_id?.startsWith('telegram-largest-'));assert.ok(waiting.tg_message_id);
 const count=calls.filter(c=>c.method==='sendPhoto'&&Number(c.body.message_thread_id)===v.topic_id).length;
 db.prepare("UPDATE jobs SET available_at=0 WHERE kind='photo-store' AND json_extract(payload,'$.messageId')=?").run(m.id);
 await until(()=>{const m1=db.prepare('SELECT * FROM messages WHERE id=?').get(m.id);return m1.status==='sent' && m1.file_status==='ready';});
 await until(()=>calls.some(c=>c.method==='sendMessage'&&c.body.text===caption&&!c.failed));
 assert.equal(calls.filter(c=>c.method==='sendPhoto'&&Number(c.body.message_thread_id)===v.topic_id).length,count);
 assert.equal(calls.filter(c=>c.method==='sendMessage'&&c.body.text===caption&&!c.failed).length,1);
 const bytes=Buffer.from(await (await fetch(base+`/api/files/${m.id}`,{headers:{Cookie:s.cookie}})).arrayBuffer());assert.deepEqual(bytes,telegramPhoto);
});

test('staff original files, high-resolution photos and compressed photos all remain supported',async()=>{
 const {s,v}=await freshVisitor();
 await hook({...staff(v.topic_id,10401,undefined),document:{file_id:'doc-original',mime_type:'image/png',file_name:'原文件.png',file_size:png.length}});
 await hook({...staff(v.topic_id,10402,undefined),photo:[{file_id:'staff-hd-max',width:2560,height:1920},{file_id:'staff-hd-thumb',width:90,height:90}]});
 await hook({...staff(v.topic_id,10403,undefined),photo:[{file_id:'staff-compressed',width:640,height:480}]});
 await until(()=>db.prepare("SELECT COUNT(*) AS n FROM messages WHERE tg_message_id IN (10401,10402,10403) AND file_status='ready'").get().n===3);
 const original=db.prepare('SELECT * FROM messages WHERE tg_message_id=10401').get();assert.equal(original.is_photo,0);
 assert.deepEqual(Buffer.from(await (await fetch(base+`/api/files/${original.id}`,{headers:{Cookie:s.cookie}})).arrayBuffer()),png);
 for(const [id,fileId] of [[10402,'staff-hd-max'],[10403,'staff-compressed']]){const m=db.prepare('SELECT * FROM messages WHERE tg_message_id=?').get(id);assert.equal(m.is_photo,1);assert.equal(m.tg_file_id,fileId);assert.equal(m.kind,'image');}
});

test('ordinary attachments still send as files and invalid photo uploads do not enter the queue',async()=>{
 const {s,v}=await freshVisitor();const form=new FormData();form.append('clientId','ordinary-attachment');form.append('file',new Blob([png],{type:'application/octet-stream'}),'attachment.bin');
 let r=await fetch(base+'/api/messages',{method:'POST',headers:{Origin:origin,Cookie:s.cookie},body:form});assert.equal(r.status,201);const m=(await r.json()).message;
 await until(()=>db.prepare('SELECT status FROM messages WHERE id=?').get(m.id).status==='sent');
 assert.deepEqual(calls.find(c=>c.method==='sendDocument'&&Number(c.body.message_thread_id)===v.topic_id).body.document.bytes,png);
 const invalid=new FormData();invalid.append('clientId','invalid-photo-upload');invalid.append('file',new Blob(['not an image'],{type:'image/png'}),'invalid.png');
 r=await fetch(base+'/api/messages',{method:'POST',headers:{Origin:origin,Cookie:s.cookie},body:invalid});assert.equal(r.status,400);
 assert.equal(db.prepare("SELECT id FROM messages WHERE client_id='invalid-photo-upload'").get(),undefined);
});

function messageRow(id){return db.prepare('SELECT * FROM messages WHERE id=?').get(id);}
function staffMessage(id){return db.prepare("SELECT * FROM messages WHERE tg_message_id=? AND direction='staff'").get(id);}
async function wake(kind,id){db.prepare("UPDATE jobs SET available_at=0 WHERE kind=? AND json_extract(payload,'$.messageId')=? AND state='pending'").run(kind,id);}
async function arbitraryFile(s,clientId,body,bytes,name,type){
 const form=new FormData();form.append('clientId',clientId);form.append('text',body);form.append('file',new Blob([bytes],{type}),name);
 return fetch(base+'/api/messages',{method:'POST',headers:{Origin:origin,Cookie:s.cookie},body:form});
}

test('initial session and durable submission return while Telegram topic creation is slow',async()=>{
 delays.set('createForumTopic',1200);
 try {
  const start=Date.now(),s=await request('/api/session',{});
  assert.equal(s.r.status,200);assert.ok(Date.now()-start<700,'session must not wait on Telegram');assert.equal(s.d.topicReady,false);
  const m=await submit(s.cookie,'asynchronous-first','首条排队消息');assert.equal(messageRow(m.id).status,'queued');
  await until(()=>messageRow(m.id).status==='sent');
  const v=db.prepare('SELECT * FROM visitors WHERE number=?').get(Number(s.d.number));assert.ok(v.topic_id);
  assert.equal(calls.filter(c=>c.method==='createForumTopic'&&c.body.name===`${Number(s.d.number)}-未知地区`).length,1);
 } finally {delays.delete('createForumTopic');}
});

test('a slow customer does not block a different customer text',async()=>{
 const a=await freshVisitor(),b=await freshVisitor();delays.set('sendMessage:slow-one',1200);
 try{
  const first=await submit(a.s.cookie,'slow-text-one','slow-one');await until(()=>calls.some(c=>c.body.text==='slow-one'));
  const second=await submit(b.s.cookie,'independent-text','independent-two');
  await until(()=>messageRow(second.id).status==='sent');assert.notEqual(messageRow(first.id).status,'sent');
  await until(()=>messageRow(first.id).status==='sent');
 }finally{delays.delete('sendMessage:slow-one');}
});

test('a backed-off message retains order ahead of later messages from the same visitor',async()=>{
 const {s,v}=await freshVisitor();faults.push({method:'sendMessage',text:'ordered-first',remaining:1,code:503,description:'Temporary error'});
 const a=await submit(s.cookie,'ordered-first-id','ordered-first');await until(()=>messageRow(a.id).status==='delayed');
 const b=await submit(s.cookie,'ordered-second-id','ordered-second');await wait(350);
 assert.equal(messageRow(b.id).status,'queued');assert.ok(!calls.some(c=>c.body.text==='ordered-second'));
 await wake('outgoing',a.id);await until(()=>messageRow(a.id).status==='sent'&&messageRow(b.id).status==='sent');
 assert.deepEqual(calls.filter(c=>c.method==='sendMessage'&&c.body.message_thread_id===v.topic_id&&/^ordered-/.test(c.body.text)&&!c.failed).map(c=>c.body.text),['ordered-first','ordered-second']);
});

test('editing a photo after a failed initial download replaces the placeholder and cancels obsolete retries',async()=>{
 const {v}=await freshVisitor();faults.push({method:'getFile',fileId:'placeholder-old',remaining:1,code:503,description:'Temporary download error'});
 const m={...staff(v.topic_id,11001,undefined),photo:[{file_id:'placeholder-old',width:100,height:100}],caption:'original'};
 await hook(m);await until(()=>staffMessage(11001)?.file_status==='delayed');
 const original=staffMessage(11001);assert.equal(original.body,'original');assert.equal(original.file_path,null);
 await hook({...m,caption:'latest',photo:[{file_id:'placeholder-new',width:200,height:200}],edit_date:m.date+1},true);
 await until(()=>staffMessage(11001)?.file_status==='ready');
 assert.equal(staffMessage(11001).body,'latest');assert.equal(staffMessage(11001).tg_file_id,'placeholder-new');
 assert.equal(db.prepare("SELECT count(*) n FROM jobs WHERE kind='incoming-file' AND json_extract(payload,'$.messageId')=?").get(original.id).n,0);
});

test('revoking a photo during its download prevents its late publication and survives an original replay',async()=>{
 const {s,v}=await freshVisitor();delays.set('file:revoke-slow',1100);
 try{
  const m={...staff(v.topic_id,11002,undefined),photo:[{file_id:'revoke-slow',width:100,height:100}],caption:'must-stay-revoked'};
  await hook(m);await until(()=>calls.some(c=>c.method==='getFile'&&c.body.file_id==='revoke-slow'));
  await hook({...staff(v.topic_id,11003,'撤回'),reply_to_message:m});await until(()=>staffMessage(11002)?.revoked===1);
  const id=staffMessage(11002).id;await wait(1300);await hook(m);await wait(350);
  assert.equal(messageRow(id).revoked,1);assert.equal(messageRow(id).file_path,null);
  assert.ok(!(await request('/api/messages',null,s.cookie)).d.messages.some(x=>x.id===id));
 }finally{delays.delete('file:revoke-slow');}
});

test('verified revoke before original webhook leaves a durable tombstone scoped to the customer',async()=>{
 const {s,v}=await freshVisitor();const original={...staff(v.topic_id,11004,undefined),photo:[{file_id:'never-load',width:100,height:100}],caption:'never-visible'};
 await hook({...staff(v.topic_id,11005,'撤回'),reply_to_message:original});await until(()=>calls.some(c=>c.body.reply_parameters?.message_id===11005&&c.body.text==='已撤回'));
 await hook(original);await wait(350);
 assert.equal(staffMessage(11004),undefined);assert.ok(!(await request('/api/messages',null,s.cookie)).d.messages.some(x=>x.body==='never-visible'));
 const other=await freshVisitor();await hook({...staff(other.v.topic_id,11006,'撤回'),reply_to_message:original});await wait(350);
 assert.equal(db.prepare('SELECT 1 FROM tombstones WHERE visitor_id=? AND message_id=11004').get(other.v.id),undefined);
});

test('late stale edits and failed old downloads never overwrite a newer edit',async()=>{
 const {v}=await freshVisitor();const original={...staff(v.topic_id,11007,undefined),photo:[{file_id:'base-version',width:100,height:100}],caption:'base'};
 await hook(original);await until(()=>staffMessage(11007)?.file_status==='ready');
 delays.set('file:old-version',1200);
 try{
  const oldUpdate=update++,old={...original,caption:'older',photo:[{file_id:'old-version',width:100,height:100}],edit_date:original.date+1};
  await hook(old,true,oldUpdate);await until(()=>calls.some(c=>c.method==='getFile'&&c.body.file_id==='old-version'));
  await hook({...original,caption:'latest-version',photo:[{file_id:'latest-version',width:200,height:200}],edit_date:original.date+2},true);
  await until(()=>staffMessage(11007)?.file_status==='ready');assert.equal(staffMessage(11007).body,'latest-version');assert.equal(staffMessage(11007).tg_file_id,'latest-version');
  // An older source edit can arrive under a later delivery id: edit_date wins.
  await hook({...old,caption:'stale-replayed'},true);await wait(350);assert.equal(staffMessage(11007).body,'latest-version');
 }finally{delays.delete('file:old-version');}
});

test('file delivery checkpoint survives a failed long caption without resending the document',async()=>{
 const {s,v}=await freshVisitor(),text='长'.repeat(1025);faults.push({method:'sendMessage',text,remaining:1,code:503,description:'Temporary caption failure'});
 const r=await arbitraryFile(s,'long-document-id',text,Buffer.from('document'),'original.txt','text/plain');assert.equal(r.status,201);const m=(await r.json()).message;
 await until(()=>messageRow(m.id).status==='delayed');assert.ok(messageRow(m.id).tg_message_id);
 const count=calls.filter(c=>c.method==='sendDocument'&&Number(c.body.message_thread_id)===v.topic_id).length;assert.equal(count,1);
 child.kill('SIGTERM');await new Promise(r=>child.once('exit',r));
 child=spawn(process.execPath,['server.mjs'],{env:{...process.env,PORT:'15301',HOST:'127.0.0.1',PUBLIC_ORIGIN:origin,ALLOWED_ORIGINS:' https://alternate.example , ',BOT_TOKEN:'test-token',TG_CHAT_ID:'-100123',STAFF_IDS:'42,43',WEBHOOK_SECRET:'test-secret',DATA_DIR:data,TG_API_BASE:'http://127.0.0.1:15302',NODE_ENV:'test',GEO_ENABLED:'0'},stdio:['ignore','pipe','pipe']});
 child.stdout.on('data',d=>logs+=d);child.stderr.on('data',d=>logs+=d);
 await until(async()=>{try{return(await fetch(base+'/healthz')).ok;}catch{return false;}});

 await wake('outgoing',m.id);await until(()=>messageRow(m.id).status==='sent');assert.equal(messageRow(m.id).caption_sent,1);
 assert.equal(calls.filter(c=>c.method==='sendDocument'&&Number(c.body.message_thread_id)===v.topic_id).length,1);
});

test('photos report delivery while largest-size storage is independently retrying',async()=>{
 const {s,v}=await freshVisitor();faults.push({method:'getFile',remaining:1,code:503,description:'Temporary storage failure'});
 const m=await submit(s.cookie,'independent-photo-storage','',png);
 await until(()=>messageRow(m.id).file_status==='delayed');assert.equal(messageRow(m.id).status,'sent');assert.ok(messageRow(m.id).tg_message_id);
 const next=await submit(s.cookie,'after-photo-text','after-photo-storage-failure');await until(()=>messageRow(next.id).status==='sent');
 await wake('photo-store',m.id);await until(()=>messageRow(m.id).file_status==='ready');
 assert.equal(calls.filter(c=>c.method==='sendPhoto'&&Number(c.body.message_thread_id)===v.topic_id).length,1);
});

test('permanent failures stop automatically and explicit authenticated retry preserves identity',async()=>{
 const {s,v}=await freshVisitor(),other=await freshVisitor();faults.push({method:'sendMessage',text:'terminal-text',remaining:1,code:400,description:'Bad Request: invalid data'});
 const m=await submit(s.cookie,'permanent-text-id','terminal-text');await until(()=>messageRow(m.id).status==='failed');
 const job=db.prepare("SELECT * FROM jobs WHERE kind='outgoing' AND json_extract(payload,'$.messageId')=?").get(m.id);assert.equal(job.state,'failed');assert.equal(job.attempts,1);
 assert.equal((await request('/api/messages/'+m.id+'/retry',{},other.s.cookie)).r.status,404);
 await wait(350);assert.equal(calls.filter(c=>c.body.text==='terminal-text').length,1);
 const retry=await request('/api/messages/'+m.id+'/retry',{},s.cookie);assert.equal(retry.r.status,200);assert.equal(retry.d.message.id,m.id);
 await until(()=>messageRow(m.id).status==='sent');assert.equal(calls.filter(c=>c.body.text==='terminal-text'&&!c.failed).length,1);
 assert.equal(messageRow(m.id).visitor_id,v.id);
});

test('transient retry budget ends in visible failure instead of an endless loop',async()=>{
 const {s}=await freshVisitor();faults.push({method:'sendMessage',text:'bounded-retry-text',remaining:20,code:503,description:'Still unavailable'});
 const m=await submit(s.cookie,'bounded-retry-id','bounded-retry-text');
 for(let i=1;i<=8;i++){
  await until(()=>db.prepare("SELECT attempts FROM jobs WHERE kind='outgoing' AND json_extract(payload,'$.messageId')=?").get(m.id)?.attempts===i);
  if(i<8)await wake('outgoing',m.id);
 }
 assert.equal(messageRow(m.id).status,'failed');assert.ok(messageRow(m.id).failure_reason);
 assert.equal(db.prepare("SELECT state FROM jobs WHERE kind='outgoing' AND json_extract(payload,'$.messageId')=?").get(m.id).state,'failed');
});

test('expired waiting tasks stop before delivery and no longer block a fresh message',async()=>{
 const {s,v}=await freshVisitor(),id=`expired-${Date.now()}`,old=Date.now()-25*3600000;
 db.transaction(()=>{
  db.prepare("INSERT INTO messages(id,visitor_id,client_id,direction,kind,body,sent_at,status) VALUES(?,?,?,'visitor','text',?,?,'queued')").run(id,v.id,id,'expired-must-not-deliver',old);
  db.prepare("INSERT INTO jobs(kind,payload,dedup,attempts,available_at,created_at,state,lane,category,retry_after_until,rate_limited_since) VALUES('outgoing',?,?,0,?,?,'pending',?,'send',?,?)").run(JSON.stringify({messageId:id}),`outgoing:${id}`,Date.now()+3600000,old,`send:${v.id}`,Date.now()+3600000,old);
 })();
 await until(()=>messageRow(id).status==='failed');
 const job=db.prepare('SELECT * FROM jobs WHERE dedup=?').get(`outgoing:${id}`);
 assert.equal(job.attempts,0);assert.ok(job.failed_at);assert.ok(!calls.some(c=>c.body.text==='expired-must-not-deliver'));
 const next=await submit(s.cookie,`fresh-after-expiry-${Date.now()}`,'fresh-after-expiry');await until(()=>messageRow(next.id).status==='sent');
});

test('a deadline crossed while creating a topic prevents the following send',async()=>{
 const {v}=await freshVisitor(),id=`expires-during-topic-${Date.now()}`;
 db.prepare('UPDATE visitors SET topic_id=NULL WHERE id=?').run(v.id);
 delays.set('createForumTopic',1400);
 try{
 db.transaction(()=>{
  db.prepare("INSERT INTO messages(id,visitor_id,direction,kind,body,sent_at,status) VALUES(?,?,'visitor','text',?,?,'queued')").run(id,v.id,'must-not-send-after-topic-wait',Date.now());
  db.prepare("INSERT INTO jobs(kind,payload,dedup,available_at,created_at,state,lane,category) VALUES('outgoing',?,?,0,?,'pending',?,'send')").run(JSON.stringify({messageId:id}),`outgoing:${id}`,Date.now()-86400000+1100,`send:${v.id}`);
 })();
 await until(()=>messageRow(id).status==='failed');assert.ok(!calls.some(c=>c.body.text==='must-not-send-after-topic-wait'));
 assert.match(messageRow(id).failure_reason,/期限/);
 }finally{delays.delete('createForumTopic');}
});

test('expiring a remaining caption preserves the successful remote file checkpoint',async()=>{
 const {v}=await freshVisitor(),id=`expired-caption-${Date.now()}`,body='expired-long-caption-'.repeat(80),old=Date.now()-25*3600000;
 db.transaction(()=>{
  db.prepare("INSERT INTO messages(id,visitor_id,direction,kind,body,sent_at,status,tg_message_id,tg_topic_id) VALUES(?,?,'visitor','file',?,?,'delayed',77777,?)").run(id,v.id,body,old,v.topic_id);
  db.prepare("INSERT INTO jobs(kind,payload,dedup,available_at,created_at,state,lane,category) VALUES('photo-caption',?,?,0,?,'pending',?,'send')").run(JSON.stringify({messageId:id}),`caption:${id}`,old,`send:${v.id}`);
 })();
 await until(()=>messageRow(id).status==='failed');assert.equal(messageRow(id).tg_message_id,77777);
 assert.match(messageRow(id).failure_reason,/附件已送达/);assert.ok(!calls.some(c=>c.body.text===body));
});

test('old durable incoming metadata is reconciled rather than dropped as an expired send',async()=>{
 const {v}=await freshVisitor(),payload={update_id:update++,message:staff(v.topic_id,11991,'late-durable-metadata')};
 db.prepare("INSERT INTO jobs(kind,payload,dedup,available_at,created_at,state,lane,category) VALUES('update',?,?,0,?,'pending','metadata','metadata')").run(JSON.stringify(payload),`update:${payload.update_id}`,Date.now()-25*3600000);
 await until(()=>staffMessage(11991)?.body==='late-durable-metadata');
});

test('parallel photo retries return one persisted message rather than a unique-key error',async()=>{
 const {s,v}=await freshVisitor(),bytes=await sharp(png).webp().toBuffer();
 const rs=await Promise.all([1,2].map(()=>arbitraryFile(s,'same-concurrent-photo','',bytes,'same.webp','image/webp')));
 assert.deepEqual(rs.map(r=>r.status).sort(),[200,201]);const messages=await Promise.all(rs.map(r=>r.json()));assert.equal(messages[0].message.id,messages[1].message.id);
 await until(()=>{const m=messageRow(messages[0].message.id);return m.status==='sent' && m.file_status==='ready';});assert.equal(calls.filter(c=>c.method==='sendPhoto'&&Number(c.body.message_thread_id)===v.topic_id).length,1);
});

test('failed incoming attachments stay unread until an owner retry successfully loads them',async()=>{
 const {s,v}=await freshVisitor(),other=await freshVisitor();faults.push({method:'getFile',fileId:'terminal-incoming',remaining:1,code:400,description:'Bad Request: file temporarily invalid'});
 await hook({...staff(v.topic_id,11009,undefined),photo:[{file_id:'terminal-incoming',width:100,height:100}]});
 await until(()=>staffMessage(11009)?.file_status==='failed');const m=staffMessage(11009);
 await request('/api/read',{ids:[m.id]},s.cookie);assert.equal(messageRow(m.id).read_at,null);
 assert.equal((await request('/api/messages/'+m.id+'/retry',{},other.s.cookie)).r.status,404);
 assert.equal((await request('/api/messages/'+m.id+'/retry',{},s.cookie)).r.status,200);
 await until(()=>messageRow(m.id).file_status==='ready');await request('/api/read',{ids:[m.id]},s.cookie);
 await until(()=>messageRow(m.id).read_notified===1);
 assert.equal(calls.filter(c=>c.method==='setMessageReaction'&&c.body.message_id===11009).length,1);
});

test('staff HEIC originals retain their bytes and expose only an authenticated JPEG preview',async()=>{
 const {s,v}=await freshVisitor(),other=await freshVisitor();const bytes=readFileSync(new URL('./fixtures/solid.heic',import.meta.url));
 await hook({...staff(v.topic_id,11008,undefined),document:{file_id:'heic-original',file_name:'iphone.heic',mime_type:'image/heic',file_size:bytes.length}});
 await until(()=>staffMessage(11008)?.file_status==='ready');const m=staffMessage(11008);assert.equal(m.mime,'image/heic');assert.equal(m.is_photo,0);assert.equal(m.preview_mime,'image/jpeg');
 const original=await fetch(base+'/api/files/'+m.id,{headers:{Cookie:s.cookie}});assert.deepEqual(Buffer.from(await original.arrayBuffer()),bytes);
 const preview=await fetch(base+'/api/files/'+m.id+'?preview=1',{headers:{Cookie:s.cookie}});assert.equal(preview.headers.get('content-type'),'image/jpeg');assert.equal((await sharp(Buffer.from(await preview.arrayBuffer())).metadata()).width,96);
 assert.equal((await fetch(base+'/api/files/'+m.id+'?preview=1',{headers:{Cookie:other.s.cookie}})).status,404);
 assert.equal((await fetch(base+'/api/files/'+m.id+'?preview=1')).status,401);
});

test('legacy database migrates without losing identity and 7-day cleanup preserves topic mappings',async()=>{
 const file=db.prepare('SELECT * FROM messages WHERE file_path IS NOT NULL LIMIT 1').get();assert.ok(file);
 const original=db.prepare('SELECT * FROM visitors WHERE id=?').get(file.visitor_id);
 db.prepare('UPDATE messages SET sent_at=? WHERE id=?').run(Date.now()-8*86400000,file.id);
 child.kill('SIGTERM');await new Promise(r=>child.once('exit',r));
 db.exec('DROP TRIGGER message_state_insert; DROP TRIGGER message_state_update; DROP TRIGGER message_state_delete; ALTER TABLE messages DROP COLUMN tg_topic_id; ALTER TABLE messages DROP COLUMN is_photo; ALTER TABLE visitors DROP COLUMN title_source_date; ALTER TABLE visitors DROP COLUMN title_source_update;');
 child=spawn(process.execPath,['server.mjs'],{env:{...process.env,PORT:'15301',HOST:'127.0.0.1',PUBLIC_ORIGIN:origin,ALLOWED_ORIGINS:' https://alternate.example , ',BOT_TOKEN:'test-token',TG_CHAT_ID:'-100123',STAFF_IDS:'42,43',WEBHOOK_SECRET:'test-secret',DATA_DIR:data,TG_API_BASE:'http://127.0.0.1:15302',NODE_ENV:'test',GEO_ENABLED:'0'},stdio:['ignore','pipe','pipe']});
 child.stdout.on('data',d=>logs+=d);child.stderr.on('data',d=>logs+=d);
 await until(async()=>{try{return(await fetch(base+'/healthz')).ok;}catch{return false;}});
 assert.equal(db.prepare('SELECT id FROM messages WHERE id=?').get(file.id),undefined);
 const {existsSync}=await import('node:fs');assert.equal(existsSync(file.file_path),false);
 const migrated=db.prepare('SELECT * FROM visitors WHERE id=?').get(original.id);
 for(const key of ['id','number','token_hash','topic_id','title','auto_title'])assert.equal(migrated[key],original[key]);
 assert.equal(migrated.title_source_date,0);assert.equal(migrated.title_source_update,0);
 const columns=db.prepare('PRAGMA table_info(messages)').all().map(c=>c.name);assert.ok(columns.includes('tg_topic_id'));assert.ok(columns.includes('is_photo'));
 const retained=db.prepare('SELECT * FROM messages WHERE tg_message_id=10101').get();assert.ok(retained);assert.equal(retained.tg_topic_id,db.prepare('SELECT topic_id FROM visitors WHERE id=?').get(retained.visitor_id).topic_id);
});


test('missing Origin with a trusted Referer permits legacy browser sessions and WebSockets',async()=>{
 const r=await fetch(base+'/api/session',{method:'POST',headers:{'Content-Type':'application/json',Referer:origin+'/'},body:'{}'});
 assert.equal(r.status,200);const cookie=r.headers.get('set-cookie').split(';')[0];
 const ws=new WebSocket(base.replace('http','ws')+'/ws',{headers:{Cookie:cookie,Referer:origin+'/'}});await new Promise((resolve,reject)=>{ws.once('open',resolve);ws.once('error',reject);});ws.close();
 for(const headers of [{},{Referer:'https://evil.example/'},{Origin:'null',Referer:origin+'/'}]){
  const denied=await fetch(base+'/api/session',{method:'POST',headers:{'Content-Type':'application/json',...headers},body:'{}'});assert.equal(denied.status,403);
 }
});

test('additional configured origins allow sessions and WebSockets while unknown origins stay blocked', async () => {
 const alternate='https://alternate.example';
 const session=await request('/api/session',{},null,{Origin:alternate});
 assert.equal(session.r.status,200);
 assert.ok(session.cookie);
 const reopened=await request('/api/session',{},session.cookie);
 assert.equal(reopened.r.status,200);
 assert.equal(reopened.d.number,session.d.number);
 const socketStatus=source=>new Promise((resolve,reject)=>{
  const ws=new WebSocket(base.replace('http','ws')+'/ws',{headers:{Cookie:session.cookie,...(source===undefined?{}:{Origin:source})},handshakeTimeout:3000});
  ws.once('open',()=>{ws.close();resolve(101);});
  ws.once('unexpected-response',(req,res)=>{const status=res.statusCode;res.resume();ws.on('error',()=>{});ws.terminate();resolve(status);});
  ws.once('error',reject);
 });
 assert.equal(await socketStatus(alternate),101);
 assert.equal(await socketStatus(origin),101);
 for(const source of ['https://evil.example','https://alternate.example.evil.example','null','']) {
  assert.equal((await request('/api/session',{},session.cookie,{Origin:source})).r.status,403);
  assert.equal(await socketStatus(source),403);
 }
 assert.equal((await fetch(base+'/api/session',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status,403);
 assert.equal(await socketStatus(undefined),403);
});
