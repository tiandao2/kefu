import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

test('topic migration handles rate limits, custom edits, deleted topics and permission failures without changing bindings', async () => {
  const data=mkdtempSync(path.join(tmpdir(),'kf-rename-'));
  const db=new Database(path.join(data,'chat.sqlite'));
  db.exec('CREATE TABLE visitors(number INTEGER PRIMARY KEY,topic_id INTEGER,title TEXT)');
  const rows=[
    [6,106,'上海市上海市-000006'], [12,112,'河北省石家庄市-000012'],
    [13,113,'人工备注'], [14,114,'14-广东中山'],
    [15,115,'河北省石家庄市-000012'], [16,116,'广东省中山市-000016'],
    [17,117,'云南省昆明市-000017'], [18,118,'天津市天津市-000018']
  ];
  for(const row of rows)db.prepare('INSERT INTO visitors VALUES(?,?,?)').run(...row);
  const calls=[];let limited=false;
  const mock=createServer(async(req,res)=>{
    const chunks=[];for await(const chunk of req)chunks.push(chunk);
    const body=JSON.parse(Buffer.concat(chunks));calls.push(body);
    res.setHeader('Content-Type','application/json');
    if(body.message_thread_id===112&&!limited){limited=true;res.end(JSON.stringify({ok:false,error_code:429,description:'Too Many Requests',parameters:{retry_after:1}}));return;}
    if(body.message_thread_id===106){res.end(JSON.stringify({ok:false,error_code:400,description:'Bad Request: TOPIC_NOT_MODIFIED'}));return;}
    if(body.message_thread_id===116){res.end(JSON.stringify({ok:false,error_code:400,description:'Bad Request: message thread not found'}));return;}
    if(body.message_thread_id===118){res.end(JSON.stringify({ok:false,error_code:403,description:'Forbidden: not enough rights'}));return;}
    if(body.message_thread_id===117&&body.name==='17-云南昆明')db.prepare('UPDATE visitors SET title=? WHERE number=17').run('刚添加的人工备注');
    res.end(JSON.stringify({ok:true,result:true}));
  });
  await new Promise(resolve=>mock.listen(0,'127.0.0.1',resolve));
  async function run(args){
    const child=spawn(process.execPath,[new URL('../scripts/rename-topics.mjs',import.meta.url).pathname,...args],{
      env:{...process.env,DATA_DIR:data,BOT_TOKEN:'test-token',TG_CHAT_ID:'-100123',TG_API_BASE:`http://127.0.0.1:${mock.address().port}`},stdio:['ignore','pipe','pipe']
    });
    let output='';child.stdout.on('data',chunk=>output+=chunk);child.stderr.on('data',chunk=>output+=chunk);
    const code=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('exit',resolve);});return {code,output};
  }
  try{
    const preview=await run([]);assert.equal(preview.code,0,preview.output);assert.equal(calls.length,0);
    assert.deepEqual(db.prepare('SELECT number,topic_id,title FROM visitors ORDER BY number').all().map(x=>Object.values(x)),rows);
    const reportFile=path.join(data,'rename-report.json');
    const applied=await run(['--apply',`--report=${reportFile}`]);assert.equal(applied.code,1,applied.output);
    const result=JSON.parse(readFileSync(reportFile,'utf8'));
    assert.equal(result.plan.length,5);assert.equal(result.results.filter(x=>x.state==='renamed').length,2);
    assert.equal(result.results.filter(x=>x.state==='failed').length,1);assert.equal(result.results.filter(x=>x.state==='skipped-changed').length,1);
    assert.equal(result.results.filter(x=>x.state==='missing-topic').length,1);
    assert.equal(db.prepare('SELECT title FROM visitors WHERE number=12').get().title,'12-河北石家庄');
    assert.equal(db.prepare('SELECT title FROM visitors WHERE number=6').get().title,'6-上海');
    assert.equal(db.prepare('SELECT title FROM visitors WHERE number=17').get().title,'刚添加的人工备注');
    for(const number of [13,14,15,18]){
      const row=rows.find(r=>r[0]===number);assert.deepEqual(Object.values(db.prepare('SELECT number,topic_id,title FROM visitors WHERE number=?').get(number)),row);
    }
    assert.deepEqual(db.prepare('SELECT topic_id,title FROM visitors WHERE number=16').get(),{topic_id:116,title:'16-广东中山'});
    assert.equal(calls.filter(x=>x.message_thread_id===112).length,2);
    assert.equal(calls.filter(x=>x.message_thread_id===117).at(-1).name,'刚添加的人工备注');
    assert.ok(!calls.some(x=>[113,114,115].includes(x.message_thread_id)));
    assert.ok(calls.every(x=>Object.keys(x).sort().join(',')==='chat_id,message_thread_id,name'));
    assert.ok(!JSON.stringify(result).includes('test-token'));
  }finally{
    await new Promise(resolve=>mock.close(resolve));db.close();rmSync(data,{recursive:true,force:true});
  }
});
