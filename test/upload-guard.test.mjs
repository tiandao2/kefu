import {test} from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {createUploadGuard,UPLOAD_DEFAULTS,uploadLimits} from '../upload-guard.mjs';
function fixture(overrides={}){
 const db=new Database(':memory:');let time=100000,used=0,free=10000;
 const options={db,directory:'/unused',secret:'isolated-test-secret',limits:{...UPLOAD_DEFAULTS,visitorDailyBytes:100,ipDailyBytes:150,totalBytes:1000,minFreeBytes:10,maxConcurrent:4,maxPerVisitor:3,maxPerIp:4,...overrides},now:()=>time,usage:()=>used,freeBytes:()=>free};
 return {db,guard:createUploadGuard(options),restart:()=>createUploadGuard(options),advance:n=>time+=n,setUsed:n=>used=n,setFree:n=>free=n};
}
const limited=fn=>assert.throws(fn,e=>e.code==='UPLOAD_LIMIT');
test('reservations prevent concurrent overspend and completion charges actual bytes',()=>{
 const f=fixture();try{
  const a=f.guard.begin('a','8.8.8.8');a.startFile(70);const b=f.guard.begin('a','8.8.8.8');limited(()=>b.startFile(40));b.finish();
  a.record(25);a.finish();a.finish();assert.equal(f.db.prepare('SELECT sum(bytes) AS n FROM upload_usage').get().n,25);
  const c=f.guard.begin('a','8.8.8.8');c.startFile(75);c.record(75);c.finish();
  const d=f.guard.begin('a','8.8.8.8');limited(()=>d.startFile(1));d.finish();
 }finally{f.db.close();}
});
test('IP allowance aggregates different identities and canonical address forms',()=>{
 const f=fixture();try{
  for(const [id,ip]of [['a','8.8.8.8'],['b','::ffff:808:808']]){const p=f.guard.begin(id,ip);p.startFile(70);p.record(70);p.finish();}
  const next=f.guard.begin('c','::ffff:8.8.8.8');limited(()=>next.startFile(11));next.finish();
  const elsewhere=f.guard.begin('c','1.1.1.1');elsewhere.startFile(70);elsewhere.record(70);elsewhere.finish();
  assert.equal(f.db.prepare('SELECT count(DISTINCT ip_key) AS n FROM upload_usage').get().n,2);
  assert.ok(!JSON.stringify(f.db.prepare('SELECT * FROM upload_usage').all()).includes('8.8.8.8'));
 }finally{f.db.close();}
});
test('spent and interrupted allowances survive restart and expire after the rolling day',()=>{
 const f=fixture();try{
  const p=f.guard.begin('a','8.8.8.8');p.startFile(100);p.record(20); // crash before settlement keeps the whole reservation
  const restarted=f.restart(),blocked=restarted.begin('a','8.8.8.8');limited(()=>blocked.startFile(1));blocked.finish();
  f.advance(86400000);const fresh=restarted.begin('a','8.8.8.8');fresh.startFile(100);fresh.record(30);fresh.finish();
  assert.equal(f.db.prepare('SELECT sum(bytes) AS n FROM upload_usage').get().n,30);
 }finally{f.db.close();}
});
test('global, visitor and IP concurrency limits reject excess work and release permits',()=>{
 for(const [overrides,first,next]of [[{maxConcurrent:1},['a','8.8.8.8'],['b','1.1.1.1']],[{maxPerVisitor:1},['a','8.8.8.8'],['a','1.1.1.1']],[{maxPerIp:1},['a','8.8.8.8'],['b','8.8.8.8']]]){
  const f=fixture(overrides);try{const p=f.guard.begin(...first);limited(()=>f.guard.begin(...next));p.finish();f.guard.begin(...next).finish();}finally{f.db.close();}
 }
});
test('global storage and free space include outstanding reservations and recover after deletion',()=>{
 const f=fixture();try{
  f.setUsed(900);const first=f.guard.reserveStorage(70);limited(()=>f.guard.reserveStorage(31));first(70);
  limited(()=>f.guard.reserveStorage(31));f.setUsed(100);f.advance(5001);const later=f.guard.reserveStorage(100);later(0);
  f.setFree(40);limited(()=>f.guard.reserveStorage(31));const exact=f.guard.reserveStorage(30);exact(0);
 }finally{f.db.close();}
});
test('quota refusals do not consume storage or leave concurrency slots occupied',()=>{
 const f=fixture({visitorDailyBytes:10,totalBytes:100});try{
  for(let i=0;i<10;i++){const p=f.guard.begin('a','8.8.8.8');limited(()=>p.startFile(11));p.finish();}
  const p=f.guard.begin('a','8.8.8.8');p.startFile(10);p.record(10);p.finish();assert.equal(f.db.prepare('SELECT count(*) AS n FROM upload_usage').get().n,1);
 }finally{f.db.close();}
});
test('invalid upload limit configuration fails closed',()=>{
 assert.deepEqual(uploadLimits({}),UPLOAD_DEFAULTS);
 for(const value of ['-1','NaN','1.2','0','9007199254740992'])assert.throws(()=>uploadLimits({UPLOAD_TOTAL_BYTES:value}));
 assert.equal(uploadLimits({UPLOAD_MIN_FREE_BYTES:'0'}).minFreeBytes,0);
});

test('empty and tiny files cannot bypass daily file-count quotas',()=>{
 const f=fixture({visitorDailyFiles:1,ipDailyFiles:2});try{
  const a=f.guard.begin('a','8.8.8.8');a.startFile(1);a.finish();
  const blocked=f.guard.begin('a','8.8.8.8');limited(()=>blocked.startFile(1));blocked.finish();
  const b=f.guard.begin('b','8.8.8.8');b.startFile(1);b.finish();
  const c=f.guard.begin('c','8.8.8.8');limited(()=>c.startFile(1));c.finish();
 }finally{f.db.close();}
});
