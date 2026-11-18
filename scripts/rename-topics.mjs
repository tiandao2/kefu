// Preview by default. Apply only with --apply, after saving a database snapshot.
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { setDefaultAutoSelectFamilyAttemptTimeout } from 'node:net';
import { topicRenamePlan } from '../topic-names.mjs';

setDefaultAutoSelectFamilyAttemptTimeout(1500);
const apply = process.argv.includes('--apply');
const reportFile = process.argv.find(x => x.startsWith('--report='))?.slice(9);
const db = new Database(path.join(process.env.DATA_DIR || '/var/lib/kf-chat', 'chat.sqlite'), {readonly: !apply});
db.pragma('busy_timeout = 5000');
const plan = topicRenamePlan(db.prepare('SELECT number,topic_id,title FROM visitors ORDER BY number').all());
const result = {apply, startedAt: new Date().toISOString(), plan, results: []};
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
function save() {
  if (reportFile) {
    fs.writeFileSync(`${reportFile}.tmp`, JSON.stringify(result, null, 2), {mode: 0o600});
    fs.renameSync(`${reportFile}.tmp`, reportFile);
  }
}
async function rename(topicId, name) {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetch(`${process.env.TG_API_BASE || 'https://api.telegram.org'}/bot${process.env.BOT_TOKEN}/editForumTopic`, {
        method: 'POST', headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({chat_id: process.env.TG_CHAT_ID, message_thread_id: topicId, name}),
        signal: AbortSignal.timeout(30000)
      });
      const data = await res.json();
      if (data.ok || /TOPIC_NOT_MODIFIED/i.test(data.description || '')) return;
      const error = new Error(String(data.description || 'Telegram rename failed').replaceAll(process.env.BOT_TOKEN, '[redacted]'));
      error.code = data.error_code || res.status;
      if (Number(error.code) === 429 && attempt < 3) {
        await wait(Math.max(1000, Number(data.parameters?.retry_after || 1) * 1000) + 250); continue;
      }
      if (Number(error.code) >= 500 && attempt < 3) { await wait(1000 * 2 ** attempt); continue; }
      throw error;
    } catch (error) {
      if (!error.code && attempt < 3) { await wait(1000 * 2 ** attempt); continue; }
      throw error;
    }
  }
}
try {
  console.log(JSON.stringify({apply, candidates: plan.length, plan}));
  if (apply && (!process.env.BOT_TOKEN || !process.env.TG_CHAT_ID)) throw new Error('Missing Telegram configuration');
  save();
  if (apply) for (const item of plan) {
    const current = db.prepare('SELECT number,topic_id,title FROM visitors WHERE number=?').get(item.number);
    if (!current || current.topic_id !== item.topicId || current.title !== item.from) {
      result.results.push({...item, state: 'skipped-changed'}); save(); continue;
    }
    try {
      await rename(item.topicId, item.to);
      const update = db.prepare('UPDATE visitors SET title=? WHERE number=? AND topic_id=? AND title=?').run(item.to, item.number, item.topicId, item.from);
      const after = db.prepare('SELECT topic_id,title FROM visitors WHERE number=?').get(item.number);
      if (!update.changes && (after?.topic_id !== item.topicId || after?.title !== item.to)) {
        // A manual edit processed during the network request takes precedence.
        if (after?.topic_id === item.topicId && after.title) await rename(item.topicId, after.title);
        result.results.push({...item, state: 'skipped-changed'});
      } else result.results.push({...item, state: 'renamed'});
    } catch (error) {
      const message = String(error.message).replaceAll(process.env.BOT_TOKEN, '[redacted]').slice(0, 200);
      if (Number(error.code) === 400 && /TOPIC_ID_INVALID|TOPIC_DELETED|message[ _]thread[ _]not[ _]found/i.test(message)) {
        // Deleted topics cannot be renamed. Preserve their bindings and update
        // only the saved default so future normal recovery uses the new name.
        const update = db.prepare('UPDATE visitors SET title=? WHERE number=? AND topic_id=? AND title=?').run(item.to, item.number, item.topicId, item.from);
        result.results.push({...item, state: update.changes ? 'missing-topic' : 'skipped-changed', error: message});
      } else {
        result.results.push({...item, state: 'failed', error: message});
        console.error(JSON.stringify({number: item.number, state: 'failed', error: message}));
        process.exitCode = 1;
      }
    }
    save(); await wait(500);
  }
  result.finishedAt = new Date().toISOString(); save();
  console.log(JSON.stringify({candidates: plan.length, renamed: result.results.filter(x => x.state === 'renamed').length,
    missingTopicsUpdated: result.results.filter(x => x.state === 'missing-topic').length,
    skipped: result.results.filter(x => x.state === 'skipped-changed').length,
    failed: result.results.filter(x => x.state === 'failed').length}));
} finally { db.close(); }
