import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
const dir=process.env.DATA_DIR||'/var/lib/kf-chat';
const out=path.join(dir,'identity-backups');fs.mkdirSync(out,{recursive:true,mode:0o700});
const db=new Database(path.join(dir,'chat.sqlite'),{readonly:true});
const visitors=db.prepare('SELECT * FROM visitors').all();db.close();
const date=new Date().toISOString().slice(0,10);
fs.writeFileSync(path.join(out,`${date}.json`),JSON.stringify({version:1,createdAt:Date.now(),visitors}),{mode:0o600});
for(const name of fs.readdirSync(out)){const p=path.join(out,name);if(fs.statSync(p).mtimeMs<Date.now()-7*86400000)fs.rmSync(p);}
console.log(`Identity backup complete: ${visitors.length} visitors; no messages or attachments included`);
