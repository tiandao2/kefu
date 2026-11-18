import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,rmSync,existsSync} from 'node:fs';
import {spawn} from 'node:child_process';
import {tmpdir} from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
test('monitor notifies new failures once, reports real recovery and retries failed notifications',async()=>{
 const dir=mkdtempSync(path.join(tmpdir(),'kf-monitor-test-')),calls=path.join(dir,'notifications.jsonl'),state=path.join(dir,'monitor-state.json');
 const db=new Database(path.join(dir,'chat.sqlite'));
 db.exec('CREATE TABLE jobs(id INTEGER PRIMARY KEY,kind TEXT,state TEXT,attempts INTEGER,created_at INTEGER,available_at INTEGER,last_attempt_at INTEGER DEFAULT 0,failed_at INTEGER,retry_after_until INTEGER DEFAULT 0,rate_limited_since INTEGER DEFAULT 0)');
 const loader=path.join(dir,'fetch-fixture.mjs');
 writeFileSync(loader,`import {appendFileSync} from 'node:fs';globalThis.fetch=async(url,options={})=>{if(String(url).includes('/healthz'))return Response.json({ok:true});if(!String(url).startsWith('https://api.telegram.org/botmonitor-test/'))throw new Error('Unexpected network');appendFileSync(process.env.KF_CALLS,options.body+'\\n');return Response.json({ok:process.env.KF_NOTIFY_FAIL!=='1'},{status:process.env.KF_NOTIFY_FAIL==='1'?500:200});};`);
 async function run(fail=false){
  const child=spawn(process.execPath,['--import',loader,'scripts/monitor.mjs'],{env:{...process.env,DATA_DIR:dir,BOT_TOKEN:'monitor-test',TG_CHAT_ID:'-100123',KF_CALLS:calls,KF_NOTIFY_FAIL:fail?'1':'0'},stdio:['ignore','pipe','pipe']});
  let log='';child.stdout.on('data',d=>log+=d);child.stderr.on('data',d=>log+=d);const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);});return {code,log};
 }
 const notifications=()=>existsSync(calls)?readFileSync(calls,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse):[];
 try{
 const now=Date.now();db.prepare("INSERT INTO jobs(id,kind,state,attempts,created_at,available_at,failed_at) VALUES(1,'outgoing','failed',8,?,?,?)").run(now,now,now);
 assert.equal((await run()).code,0);assert.equal(notifications().length,1);assert.match(notifications()[0].text,/新增 1/);
 assert.equal((await run()).code,0);assert.equal(notifications().length,1,'old failure must not repeatedly notify or report false recovery');
 db.prepare("INSERT INTO jobs VALUES(2,'outgoing','pending',0,?,?,0,NULL,?,?)").run(now-20*60000,now+600000,now+600000,now-20*60000);
 assert.equal((await run()).code,0);assert.match(notifications().at(-1).text,/持续限流/);
 const before=notifications().length;assert.equal((await run()).code,0);assert.equal(notifications().length,before);
 db.prepare('DELETE FROM jobs WHERE id=2').run();assert.equal((await run()).code,0);assert.match(notifications().at(-1).text,/持续异常已解除/);
 db.prepare('UPDATE jobs SET failed_at=? WHERE id=1').run(now+1);
 const saved=readFileSync(state,'utf8');const failed=await run(true);assert.equal(failed.code,1);assert.equal(readFileSync(state,'utf8'),saved);
 assert.equal((await run()).code,0);assert.match(notifications().at(-1).text,/新增 1/);
 }finally{db.close();rmSync(dir,{recursive:true,force:true});}
});
