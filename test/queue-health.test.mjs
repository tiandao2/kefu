import {test} from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {queueHealth} from '../scripts/queue-health.mjs';
const now=1800000000000;
function fixture(){const db=new Database(':memory:');db.exec('CREATE TABLE jobs(id INTEGER PRIMARY KEY,kind TEXT,state TEXT,attempts INTEGER,created_at INTEGER,available_at INTEGER,last_attempt_at INTEGER DEFAULT 0,failed_at INTEGER,retry_after_until INTEGER DEFAULT 0,rate_limited_since INTEGER DEFAULT 0)');return db;}
function add(db,overrides={}){const j={kind:'outgoing',state:'pending',attempts:0,created_at:now-20*60000,available_at:now-60000,last_attempt_at:0,failed_at:null,retry_after_until:0,rate_limited_since:0,...overrides};return Number(db.prepare('INSERT INTO jobs(kind,state,attempts,created_at,available_at,last_attempt_at,failed_at,retry_after_until,rate_limited_since) VALUES(@kind,@state,@attempts,@created_at,@available_at,@last_attempt_at,@failed_at,@retry_after_until,@rate_limited_since)').run(j).lastInsertRowid);}
test('new terminal failures are notified once, but a later failure of the same job is new',()=>{
 const db=fixture();try{
 const id=add(db,{state:'failed',attempts:8,failed_at:now});
 const first=queueHealth(db,{now});assert.equal(first.newFailureCount,1);assert.match(first.newFailureSummary,/发送 1/);
 assert.equal(queueHealth(db,{now,notifiedFailures:first.failureKeys}).newFailureCount,0);
 db.prepare('UPDATE jobs SET failed_at=? WHERE id=?').run(now+1000,id);
 assert.equal(queueHealth(db,{now:now+1000,notifiedFailures:first.failureKeys}).newFailureCount,1);
 db.prepare('DELETE FROM jobs').run();assert.deepEqual(queueHealth(db,{now,notifiedFailures:first.failureKeys}).failureKeys,[]);
 }finally{db.close();}
});
test('short retry_after is quiet; sustained rate limit and unstarted old work are detected',()=>{
 const db=fixture();try{
 add(db,{retry_after_until:now+300000,rate_limited_since:now-60000});
 assert.equal(queueHealth(db,{now}).alerts.length,0);
 add(db,{retry_after_until:now+300000,rate_limited_since:now-20*60000});
 add(db);add(db,{attempts:5,last_attempt_at:now-1000});
 const h=queueHealth(db,{now});assert.equal(h.limited,1);assert.equal(h.stalled,1);assert.equal(h.retrying,1);assert.equal(h.alerts.length,3);
 }finally{db.close();}
});
test('legacy job schema is readable without weakening monitoring of existing failures',()=>{
 const db=new Database(':memory:');try{
 db.exec('CREATE TABLE jobs(id INTEGER,kind TEXT,state TEXT,attempts INTEGER,created_at INTEGER,available_at INTEGER)');
 db.prepare("INSERT INTO jobs VALUES(1,'incoming-file','failed',1,?,?)").run(now-1000,now);
 assert.equal(queueHealth(db,{now}).newFailureCount,1);
 }finally{db.close();}
});
