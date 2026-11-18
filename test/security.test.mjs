import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {createServer,request as httpRequest} from 'node:http';
import {spawn} from 'node:child_process';
import {mkdtempSync,rmSync,writeFileSync,readFileSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import {chromium} from 'playwright';
const data=mkdtempSync(path.join(tmpdir(),'kf-security-test-')),calls=[];
let child,db,mock,base,logs='',topic=500,seq=10000,browser,nginx;
const wait=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,timeout=8000){const end=Date.now()+timeout;while(Date.now()<end){const v=await fn();if(v)return v;await wait(25);}throw Error('Timed out '+logs.slice(-500));}
async function port(){const s=createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const p=s.address().port;await new Promise(r=>s.close(r));return p;}
async function stop(p=child){if(p?.exitCode===null){const done=new Promise(r=>p.once('exit',r));p.kill('SIGTERM');await done;}}
async function start(overrides={}){child=spawn(process.execPath,['server.mjs'],{env:{...process.env,HOST:'127.0.0.1',PORT:new URL(base).port,PUBLIC_ORIGIN:base,ALLOWED_ORIGINS:'',DATA_DIR:data,BOT_TOKEN:'123:security-fixture',TG_CHAT_ID:'-100123',STAFF_IDS:'42',WEBHOOK_SECRET:'security-fixture-secret',GEO_ENABLED:'0',TG_API_BASE:`http://127.0.0.1:${mock.address().port}`,UPLOAD_VISITOR_DAILY_BYTES:'8192',UPLOAD_IP_DAILY_BYTES:'12288',UPLOAD_TOTAL_BYTES:String(64*1024*1024),UPLOAD_MIN_FREE_BYTES:'0',UPLOAD_CONCURRENT:'2',UPLOAD_CONCURRENT_VISITOR:'2',UPLOAD_CONCURRENT_IP:'2',NODE_ENV:'test',...overrides},stdio:['ignore','pipe','pipe']});child.stdout.on('data',b=>logs+=b);child.stderr.on('data',b=>logs+=b);await until(async()=>{try{return(await fetch(base+'/healthz')).ok;}catch{return false;}});}
async function session(ip='127.0.0.1'){const r=await fetch(base+'/api/session',{method:'POST',headers:{Origin:base,'Content-Type':'application/json','X-Forwarded-For':ip},body:'{}'});assert.equal(r.status,200);return {cookie:r.headers.get('set-cookie').split(';')[0],body:await r.json(),ip};}
async function submit(s,id,{route='/api/messages',origin=base,file,headers={}}={}){const form=new FormData();form.set('clientId',id);form.set('text',id);if(file)form.set('file',new Blob([file],{type:'application/octet-stream'}),'security.txt');const r=await fetch(base+route,{method:'POST',headers:{Cookie:s.cookie,Origin:origin,'X-Forwarded-For':s.ip,...headers},body:form});return {status:r.status,body:await r.json(),headers:r.headers};}
before(async()=>{
 mock=createServer(async(req,res)=>{try{const parts=[];for await(const p of req)parts.push(p);const raw=Buffer.concat(parts);let body={};if(req.headers['content-type']?.startsWith('multipart/')){const form=await new Response(raw,{headers:{'Content-Type':req.headers['content-type']}}).formData();body=Object.fromEntries([...form].filter(([,v])=>typeof v==='string'));}else if(raw.length)body=JSON.parse(raw);const method=req.url.split('/').pop();calls.push({method,body});res.setHeader('Content-Type','application/json');res.end(JSON.stringify({ok:true,result:method==='createForumTopic'?{message_thread_id:++topic,name:body.name}:{message_id:++seq}}));}catch{res.writeHead(500);res.end('{}');}});
 await new Promise(r=>mock.listen(0,'127.0.0.1',r));base=`http://127.0.0.1:${await port()}`;await start();db=new Database(path.join(data,'chat.sqlite'));db.pragma('busy_timeout=5000');
});
after(async()=>{await browser?.close();await stop(nginx);await stop();db?.close();mock.closeAllConnections();await new Promise(r=>mock.close(r));rmSync(data,{recursive:true,force:true});});

test('API path variants cannot bypass source checks or expose cacheable private responses',async()=>{
 const s=await session();
 for(const route of ['/api/messages','/API/messages','/api/MESSAGES','/api/messages/']){
  const bad=await submit(s,'foreign-origin-'+seq++,{route,origin:'https://foreign.invalid'});assert.equal(bad.status,403);assert.match(bad.headers.get('cache-control'),/no-store/);
  const r=await fetch(base+route,{headers:{Cookie:s.cookie}});assert.equal(r.status,route==='/api/messages'?200:404);assert.match(r.headers.get('cache-control'),/no-store/);
 }
 const ok=await submit(s,'canonical-valid-message');assert.equal(ok.status,201);
 for(const route of ['/API/session','/api/session/']){
  const r=await fetch(base+route,{method:'POST',headers:{Origin:base,'Content-Type':'application/json'},body:'{}'});assert.equal(r.status,404);
 }
 const legacy=await fetch(base+'/api/session',{method:'POST',headers:{Referer:base+'/','Content-Type':'application/json'},body:'{}'});assert.equal(legacy.status,200);
});

test('Chromium same-site cross-origin requests cannot submit via uppercase routes',async()=>{
 const evil=createServer((req,res)=>{res.setHeader('Content-Type','text/html');res.end('<!doctype html><title>Isolated origin fixture</title>');});await new Promise(r=>evil.listen(0,'127.0.0.1',r));
 browser=await chromium.launch({args:['--no-sandbox']});const context=await browser.newContext(),page=await context.newPage();
 try{await page.goto(base);await page.waitForFunction(()=>!document.getElementById('message-input').disabled);const c=(await context.cookies()).find(c=>c.name==='kf_session');assert.ok(c.httpOnly);assert.equal(c.sameSite,'Lax');
  await page.goto(`http://127.0.0.1:${evil.address().port}/`);
  for(const route of ['/api/messages','/API/messages'])await page.evaluate(async({base,route})=>{const form=new FormData();form.set('clientId','csrf-must-not-be-stored');form.set('text','csrf-must-not-be-stored');await fetch(base+route,{method:'POST',credentials:'include',mode:'no-cors',body:form});},{base,route});
  assert.equal(db.prepare("SELECT count(*) AS n FROM messages WHERE client_id='csrf-must-not-be-stored'").get().n,0);
 }finally{await context.close();evil.closeAllConnections();await new Promise(r=>evil.close(r));}
});

test('nginx callback path variants stay outside the source allowlist and valid requests still require the secret',async()=>{
 const deniedPort=await port(),trustedPort=await port(),conf=path.join(data,'nginx.conf');
 const reject=readFileSync(new URL('../deploy/nginx.conf',import.meta.url),'utf8').split('\n').find(x=>x.includes('location ~* ^/telegram'));
 assert.ok(reject);
 const server=(p,access)=>`server { listen 127.0.0.1:${p}; location = /telegram/webhook { ${access} proxy_pass ${base}; } ${reject} location / { proxy_pass ${base}; } }`;
 writeFileSync(conf,`pid ${data}/nginx.pid; error_log ${data}/nginx-error.log; events {worker_connections 64;} http {access_log off; client_body_temp_path ${data}/nginx-body; ${server(deniedPort,'deny all;')} ${server(trustedPort,'allow 127.0.0.1; deny all;')} }`);
 nginx=spawn('/usr/sbin/nginx',['-p',data+'/', '-c',conf,'-g','daemon off;'],{stdio:['ignore','pipe','pipe']});nginx.stderr.on('data',x=>logs+=x);await until(async()=>{try{return(await fetch(`http://127.0.0.1:${deniedPort}/healthz`)).ok;}catch{return false;}});
 for(const route of ['/telegram/webhook','/telegram/webhook/','/Telegram/webhook','/telegram/Webhook']){
  for(const [p,secret,expected]of [[deniedPort,'security-fixture-secret',403],[trustedPort,'security-fixture-secret',200],[trustedPort,'bad-secret',403]]){
   const r=await fetch(`http://127.0.0.1:${p}`+route,{method:'POST',headers:{'Content-Type':'application/json','X-Telegram-Bot-Api-Secret-Token':secret},body:JSON.stringify({update_id:seq++})});assert.equal(r.status,route==='/telegram/webhook'?expected:404);await r.text();
  }
 }
 for(const route of ['/telegram/webhook/','/Telegram/webhook']){const r=await fetch(base+route,{method:'POST',headers:{'Content-Type':'application/json','X-Telegram-Bot-Api-Secret-Token':'security-fixture-secret'},body:JSON.stringify({update_id:seq++})});assert.equal(r.status,404);}
 await stop(nginx);
});

test('expired idempotency replies reveal no old content and never redeliver',async()=>{
 const s=await session('8.8.4.1'),first=await submit(s,'retention-security-id');assert.equal(first.status,201);const id=first.body.message.id;
 await until(()=>db.prepare('SELECT status FROM messages WHERE id=?').get(id)?.status==='sent');const sends=calls.filter(c=>c.body.text==='retention-security-id').length;
 const duplicate=await submit(s,'retention-security-id');assert.equal(duplicate.status,200);assert.equal(duplicate.body.message.id,id);
 db.prepare('UPDATE messages SET sent_at=? WHERE id=?').run(Date.now()-86400000,id);
 const responses=await Promise.all([submit(s,'retention-security-id'),submit(s,'retention-security-id')]);
 for(const r of responses){assert.equal(r.status,410);assert.equal(r.body.message,undefined);assert.ok(!JSON.stringify(r.body).includes('retention-security-id'));}
 assert.equal(db.prepare('SELECT count(*) AS n FROM messages WHERE id=?').get(id).n,1);assert.equal(calls.filter(c=>c.body.text==='retention-security-id').length,sends);
});

test('visitor and IP byte allowances aggregate real uploads and survive a process restart',async()=>{
 const a=await session('8.8.4.2'),b=await session('8.8.4.2'),bytes=Buffer.alloc(3500,1);
 for(const id of ['quota-file-one','quota-file-two'])assert.equal((await submit(a,id,{file:bytes})).status,201);
 assert.equal((await submit(a,'quota-visitor-block',{file:bytes})).status,429);
 assert.equal((await submit(b,'quota-file-three',{file:bytes})).status,201);
 const before=readdirSync(path.join(data,'files')).length;assert.equal((await submit(b,'quota-ip-block',{file:bytes})).status,429);assert.equal(readdirSync(path.join(data,'files')).length,before);
 await stop();await start();assert.equal((await submit(b,'quota-after-restart',{file:bytes})).status,429);
 assert.equal((await submit(b,'text-after-upload-quota')).status,201);
 const elsewhere=await session('8.8.4.3');assert.equal((await submit(elsewhere,'quota-other-address',{file:bytes})).status,201);
 assert.equal(db.prepare('SELECT sum(bytes) AS n FROM upload_usage').get().n,14000);
});

test('interrupted chunked uploads release slots, remove partial files and retain charged bytes',async()=>{
 const s=await session('8.8.4.4'),boundary='security-chunked-boundary';
 // Chunked uploads reserve the full 20 MiB and must be rejected with these
 // deliberately small integration quotas before any attachment is written.
 const before=readdirSync(path.join(data,'files')).length;
 const chunked=await new Promise((resolve,reject)=>{
  const req=httpRequest(base+'/api/messages',{method:'POST',headers:{Origin:base,Cookie:s.cookie,'X-Forwarded-For':s.ip,'Content-Type':'multipart/form-data; boundary='+boundary}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});req.on('error',reject);req.write(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="small.txt"\r\nContent-Type: application/octet-stream\r\n\r\nsmall\r\n`);req.end(`--${boundary}--\r\n`);
 });assert.equal(chunked,429);assert.equal(readdirSync(path.join(data,'files')).length,before);
 const open=()=>{
  const req=httpRequest(base+'/api/messages',{method:'POST',headers:{Origin:base,Cookie:s.cookie,'X-Forwarded-For':s.ip,'Content-Type':'multipart/form-data; boundary='+boundary,'Content-Length':'5000'}});req.on('error',()=>{});req.write(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="partial.txt"\r\nContent-Type: application/octet-stream\r\n\r\n${'x'.repeat(100)}`);return req;
 };
 const req=open();await until(()=>readdirSync(path.join(data,'files')).length>before);req.destroy();await until(()=>readdirSync(path.join(data,'files')).length===before);
 await until(()=>db.prepare('SELECT bytes FROM upload_usage WHERE visitor_id=(SELECT id FROM visitors WHERE number=?)').get(Number(s.body.number))?.bytes===100);
 assert.equal((await submit(s,'after-aborted-upload',{file:Buffer.alloc(100)})).status,201);
});

test('global file admission returns 503 without writing and still permits text',async()=>{
 await stop();await start({UPLOAD_TOTAL_BYTES:'1'});const s=await session('8.8.4.5');
 const before=readdirSync(path.join(data,'files')).length;
 const denied=await submit(s,'storage-threshold-file',{file:Buffer.from('small')});
 assert.equal(denied.status,503);assert.ok(denied.headers.get('retry-after'));assert.equal(readdirSync(path.join(data,'files')).length,before);
 assert.equal((await submit(s,'text-during-storage-pressure')).status,201);
});

test('multipart arrays and duplicate scalar fields are rejected without array materialization',async()=>{
 const s=await session('8.8.4.6');
 for(const entries of [[['clientId[1000000000]','large-index'],['text','ignored']],[['clientId','duplicate-field-id'],['clientId','another-field-id'],['text','ignored']],[['clientId','nested-text-field'],['text[value]','ignored']]]){
  const form=new FormData();for(const [name,value]of entries)form.append(name,value);
  const r=await fetch(base+'/api/messages',{method:'POST',headers:{Origin:base,Cookie:s.cookie},body:form});assert.equal(r.status,400);
 }
 assert.equal((await submit(s,'valid-after-malformed-fields')).status,201);
});
