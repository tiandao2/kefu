import {test} from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {initializeMessageState,messageSnapshot} from '../message-state.mjs';

test('legacy messages gain atomic versions that survive rollback, expiry cleanup and restart',()=>{
 const dir=mkdtempSync(path.join(tmpdir(),'kf-state-')),filename=path.join(dir,'state.sqlite');let db;
 try{
  db=new Database(filename);
  db.exec(`CREATE TABLE visitors(id TEXT PRIMARY KEY);
   CREATE TABLE messages(id TEXT PRIMARY KEY,visitor_id TEXT,body TEXT,status TEXT,revoked INTEGER DEFAULT 0,sent_at INTEGER);
   INSERT INTO visitors VALUES('a'),('b');
   INSERT INTO messages(id,visitor_id,body,status,sent_at) VALUES('old','a','legacy','queued',100);`);
  initializeMessageState(db);
  const snapshot=id=>messageSnapshot(db,id,0,m=>({id:m.id,body:m.body,version:m.revision}));
  const first=snapshot('a');assert.equal(first.messages[0].body,'legacy');assert.ok(first.messages[0].version>0);
  assert.equal(snapshot('b').stateVersion,0);
  db.prepare("UPDATE messages SET body='edited',status='sent' WHERE id='old'").run();
  const edited=snapshot('a');assert.ok(edited.stateVersion>first.stateVersion);assert.equal(edited.messages[0].version,edited.stateVersion);
  assert.throws(()=>db.transaction(()=>{db.prepare("UPDATE messages SET body='rolled back' WHERE id='old'").run();throw Error('rollback');})());
  assert.deepEqual(snapshot('a'),edited);
  db.prepare("UPDATE messages SET revoked=1 WHERE id='old'").run();
  const revoked=snapshot('a');assert.equal(revoked.messages.length,0);assert.ok(revoked.stateVersion>edited.stateVersion);
  db.prepare("DELETE FROM messages WHERE id='old'").run();const deleted=snapshot('a').stateVersion;assert.ok(deleted>revoked.stateVersion);
  db.close();db=new Database(filename);initializeMessageState(db);
  assert.equal(snapshot('a').stateVersion,deleted);
  db.prepare("INSERT INTO messages(id,visitor_id,body,status,sent_at) VALUES('new','a','after restart','queued',200)").run();
  const restarted=snapshot('a');assert.ok(restarted.stateVersion>deleted);assert.equal(restarted.messages[0].version,restarted.stateVersion);
  assert.equal(snapshot('b').stateVersion,0);
 }finally{db?.close();rmSync(dir,{recursive:true,force:true});}
});
