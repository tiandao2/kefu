import express from 'express';
import multer from 'multer';
import Database from 'better-sqlite3';
import { WebSocketServer, WebSocket } from 'ws';
import { createServer } from 'node:http';
import { setDefaultAutoSelectFamilyAttemptTimeout } from 'node:net';
import { randomBytes, randomUUID, createHash, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AsyncLocalStorage } from 'node:async_hooks';
import { IP2Region } from 'ip2region/node';
import { largestPhoto, prepareTelegramPhoto, createImagePreview } from './images.mjs';
import { topicTitle, upgradeLegacyTopicTitle } from './topic-names.mjs';

// The overseas Telegram route can take longer than Node's 250 ms default
// before IPv4 connects. Keep dual-stack fallback without abandoning it early.
setDefaultAutoSelectFamilyAttemptTimeout(1500);

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_VERSION=JSON.parse(fs.readFileSync(path.join(HERE,'package.json'),'utf8')).version;
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '127.0.0.1';
const ORIGIN = process.env.PUBLIC_ORIGIN || 'http://localhost:3000';
const ALLOWED_ORIGINS = new Set([ORIGIN, ...(process.env.ALLOWED_ORIGINS || '').split(',').map(x => x.trim()).filter(Boolean)]);
const BOT_TOKEN = process.env.BOT_TOKEN || '';
const CHAT_ID = String(process.env.TG_CHAT_ID || '');
const STAFF_IDS = new Set((process.env.STAFF_IDS || '').split(',').map(x => x.trim()).filter(Boolean));
const SECRET = process.env.WEBHOOK_SECRET || '';
const SITE_NAME = process.env.SITE_NAME || '在线客服';
const DATA = path.resolve(process.env.DATA_DIR || path.join(HERE, 'data'));
const FILES = path.join(DATA, 'files');
const MB20 = 20 * 1024 * 1024;
const DAY = 86400000;
const WELCOME = '您好，欢迎来访本交易所，在线客服为您服务，请提供交易所账户，并发送您需要咨询的问题，谢谢！';
const TG_BASE = process.env.TG_API_BASE || 'https://api.telegram.org';
const jobContext=new AsyncLocalStorage();
if (!BOT_TOKEN || !CHAT_ID || !SECRET || !STAFF_IDS.size) throw new Error('Missing bot, chat, staff or webhook configuration');
fs.mkdirSync(FILES, { recursive: true, mode: 0o700 });
const db = new Database(path.join(DATA, 'chat.sqlite'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');
db.exec(`
 CREATE TABLE IF NOT EXISTS visitors (
   number INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL,
   token_hash TEXT UNIQUE NOT NULL, topic_id INTEGER UNIQUE, title TEXT,
   created_at INTEGER NOT NULL, last_seen INTEGER NOT NULL
 );
 CREATE TABLE IF NOT EXISTS messages (
   id TEXT PRIMARY KEY, visitor_id TEXT NOT NULL REFERENCES visitors(id),
   client_id TEXT, direction TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'text',
   body TEXT NOT NULL DEFAULT '', filename TEXT, mime TEXT, size INTEGER,
   file_path TEXT, tg_message_id INTEGER, tg_sender_id TEXT, tg_file_id TEXT,
   sent_at INTEGER NOT NULL, edited_at INTEGER, revoked INTEGER NOT NULL DEFAULT 0,
   read_at INTEGER, read_notified INTEGER NOT NULL DEFAULT 0,
   status TEXT NOT NULL DEFAULT 'queued', UNIQUE(visitor_id, client_id)
 );
 CREATE INDEX IF NOT EXISTS msg_visitor_time ON messages(visitor_id, sent_at);
 CREATE INDEX IF NOT EXISTS msg_telegram ON messages(tg_message_id);
 CREATE TABLE IF NOT EXISTS updates (id INTEGER PRIMARY KEY, created_at INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS jobs (
   id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, payload TEXT NOT NULL,
   dedup TEXT UNIQUE, attempts INTEGER NOT NULL DEFAULT 0, available_at INTEGER NOT NULL,
   created_at INTEGER NOT NULL, last_error TEXT
 );
 CREATE TABLE IF NOT EXISTS processed_updates (id INTEGER PRIMARY KEY, created_at INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS operations (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS tombstones (
   visitor_id TEXT NOT NULL, topic_id INTEGER NOT NULL, message_id INTEGER NOT NULL,
   created_at INTEGER NOT NULL, PRIMARY KEY(visitor_id,topic_id,message_id)
 );
`);
// Keep the original topic on each Telegram message so deleted-topic receipts
// never target a different customer's message after a topic is replaced.
const messageColumns = new Set(db.prepare('PRAGMA table_info(messages)').all().map(c => c.name));
db.transaction(() => {
  if (!messageColumns.has('tg_topic_id')) db.exec('ALTER TABLE messages ADD COLUMN tg_topic_id INTEGER');
  if (!messageColumns.has('is_photo')) db.exec('ALTER TABLE messages ADD COLUMN is_photo INTEGER NOT NULL DEFAULT 0');
  for (const [name, definition] of Object.entries({
    source_date: 'INTEGER NOT NULL DEFAULT 0', source_update: 'INTEGER NOT NULL DEFAULT 0',
    media_json: 'TEXT', preview_path: 'TEXT', preview_mime: 'TEXT',
    file_status: "TEXT NOT NULL DEFAULT 'ready'", file_error: 'TEXT', failure_reason: 'TEXT',
    caption_sent: 'INTEGER NOT NULL DEFAULT 0', caption_message_id: 'INTEGER'
  })) if (!messageColumns.has(name)) db.exec(`ALTER TABLE messages ADD COLUMN ${name} ${definition}`);
  const jobColumns = new Set(db.prepare('PRAGMA table_info(jobs)').all().map(c => c.name));
  for (const [name, definition] of Object.entries({state: "TEXT NOT NULL DEFAULT 'pending'", lane: 'TEXT', category: 'TEXT',last_attempt_at:'INTEGER NOT NULL DEFAULT 0',failed_at:'INTEGER',retry_after_until:'INTEGER NOT NULL DEFAULT 0',rate_limited_since:'INTEGER NOT NULL DEFAULT 0'})) {
    if (!jobColumns.has(name)) db.exec(`ALTER TABLE jobs ADD COLUMN ${name} ${definition}`);
  }
  db.exec('UPDATE messages SET tg_topic_id=(SELECT topic_id FROM visitors WHERE visitors.id=messages.visitor_id) WHERE tg_message_id IS NOT NULL AND tg_topic_id IS NULL');
})();

const now = () => Date.now();
const hash = x => createHash('sha256').update(x).digest('hex');
const sql = (s, ...args) => db.prepare(s).get(...args);
const run = (s, ...args) => db.prepare(s).run(...args);
const locks = new Map();
const geo = process.env.GEO_ENABLED === '1' ? await IP2Region.open({ mappedIPv6: 'ipv4' }) : null;
async function locked(key, fn) {
  const before = locks.get(key) || Promise.resolve();
  let release; const current = new Promise(r => { release = r; });
  locks.set(key, current);
  await before.catch(() => {});
  try { return await fn(); } finally { release(); if (locks.get(key) === current) locks.delete(key); }
}
function queue(kind, payload, dedup = null) {
  const {lane, category} = jobScope(kind, payload);
  run('INSERT OR IGNORE INTO jobs(kind,payload,dedup,available_at,created_at,lane,category) VALUES(?,?,?,?,?,?,?)', kind, JSON.stringify(payload), dedup, now(), now(), lane, category);
}
function jobScope(kind, p) {
  const visitorId = p.visitorId || (p.messageId && sql('SELECT visitor_id FROM messages WHERE id=?', p.messageId)?.visitor_id);
  if (kind === 'update') return {lane:'metadata',category:'metadata'};
  if (['incoming-file','photo-store'].includes(kind)) return {lane:`file:${p.messageId}`,category:'download'};
  if (['topic','welcome','outgoing','photo-caption'].includes(kind)) return {lane:`send:${visitorId || p.messageId}`,category:'send'};
  return {lane:`aux:${p.topicId || visitorId || p.messageId}`,category:'aux'};
}
// Old jobs and manually restored jobs acquire their scheduling scope once.
function migrateJobScopes() {
  for (const job of db.prepare('SELECT id,kind,payload FROM jobs WHERE lane IS NULL OR category IS NULL').all()) {
    const scope=jobScope(job.kind,JSON.parse(job.payload));
    run('UPDATE jobs SET lane=?,category=? WHERE id=?',scope.lane,scope.category,job.id);
  }
}
migrateJobScopes();
if (!messageColumns.has('file_status')) {
  for (const m of db.prepare("SELECT id FROM messages WHERE direction='visitor' AND kind='image' AND tg_file_id IS NOT NULL AND status!='sent'").all()) {
    run("UPDATE messages SET file_status='pending' WHERE id=?",m.id);
    queue('photo-store',{messageId:m.id},`photo-store:${m.id}`);
  }
}
db.exec('CREATE INDEX IF NOT EXISTS job_lane_state ON jobs(lane,state,id); CREATE INDEX IF NOT EXISTS job_schedule ON jobs(state,category,available_at,id)');
function safeEqual(a, b) {
  const aa = Buffer.from(a || ''), bb = Buffer.from(b || '');
  return aa.length === bb.length && timingSafeEqual(aa, bb);
}
function visitorFrom(req) {
  const cookie = (req.headers.cookie || '').split(';').map(x => x.trim()).find(x => x.startsWith('kf_session='));
  const token = cookie?.slice(11);
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
  return sql('SELECT * FROM visitors WHERE token_hash=?', hash(token));
}
function requireVisitor(req, res, next) {
  req.visitor = visitorFrom(req);
  if (!req.visitor) return res.status(401).json({ error: '会话已失效，请刷新页面' });
  next();
}
const buckets = new Map();
function allowed(key, limit, window = 60000) {
  const t = now(); let bucket = buckets.get(key);
  if (!bucket || bucket.start + window < t) { bucket = { start: t, count: 0 }; buckets.set(key, bucket); }
  return ++bucket.count <= limit;
}
const sockets = new Map();
let telegramPauseUntil = 0;
function broadcast(visitorId, data) {
  for (const ws of sockets.get(visitorId) || []) if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
}
function publicMessage(m) {
  return { id: m.id, clientId: m.client_id, direction: m.direction, kind: m.kind,
    body: m.body, filename: m.filename, mime: m.mime, size: m.size, sentAt: m.sent_at,
    editedAt: m.edited_at, readAt: m.read_at, status: m.status, originalFile: !m.is_photo,
    failureReason: m.failure_reason, fileStatus: m.file_status, fileError: m.file_error,
    previewUrl: m.preview_path ? `/api/files/${m.id}?preview=1` : null,
    previewMime: m.preview_mime,
    fileUrl: m.file_path ? `/api/files/${m.id}` : null };
}
function publishMessage(id) {
  const m = sql('SELECT * FROM messages WHERE id=?', id);
  if (m && !m.revoked && m.sent_at > now() - DAY) broadcast(m.visitor_id, { type: 'message', message: publicMessage(m) });
}
async function telegram(method, body = {}, file) {
  assertJobCurrent();
  if(now()<telegramPauseUntil){const e=new Error('Telegram 限流，等待恢复');e.retryAfter=Math.ceil((telegramPauseUntil-now())/1000);throw e;}
  let payload = body, headers = { 'Content-Type': 'application/json' };
  if (file) {
    payload = new FormData();
    for (const [k,v] of Object.entries(body)) payload.append(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
    const { openAsBlob } = await import('node:fs');
    payload.append(method === 'sendPhoto' ? 'photo' : 'document', await openAsBlob(file.path, { type: file.mime || 'application/octet-stream' }), file.filename || '附件');
    headers = {};
  } else payload = JSON.stringify(body);
  assertJobCurrent();
  const res = await fetch(`${TG_BASE}/bot${BOT_TOKEN}/${method}`, { method: 'POST', headers, body: payload, signal: AbortSignal.timeout(90000) });
  const data = await res.json();
  if (!data.ok) {
    const err = new Error(data.description || 'Telegram 请求失败');
    err.code = Number(data.error_code || res.status);
    err.retryAfter = Number(data.parameters?.retry_after || 0);
    if(err.retryAfter)telegramPauseUntil=Math.max(telegramPauseUntil,now()+err.retryAfter*1000);
    throw err;
  }
  return data.result;
}
async function notice(topicId, text, replyId, dedup) {
  queue('notice', { topicId, text, replyId }, dedup);
}
async function region(ip) {
  if (!geo || !ip || /^(127\.|10\.|192\.168\.|::1$)/.test(ip)) return '未知地区';
  try {
    const d = geo.lookup(ip);
    if (!d) return '未知地区';
    const province = d.subdivisions?.map(x=>x.name||'').join('') || '';
    const text = d.country?.code === 'CN' ? `${province}${d.city?.name||''}` : `${d.country?.name||''}${province}${d.city?.name||''}`;
    return text.replace(/[\u0000-\u001f]/g, '').slice(0, 64) || '未知地区';
  } catch { return '未知地区'; }
}
function missingTopic(e) {
  return e.code === 400 && /message[ _]thread[ _]not[ _]found|topic[ _]id[ _]invalid|topic[ _]deleted/i.test(e.message);
}
function missingMessage(e) {
  return e.code === 400 && /message[ _]id[ _]invalid|message (?:to (?:react|reply|be replied).* )?not found|message to react to not found/i.test(e.message);
}
async function ensureTopic(v, ip, obsoleteTopic = null) {
  return locked(`topic:${v.id}`, async () => {
    let fresh = sql('SELECT * FROM visitors WHERE id=?', v.id);
    if (obsoleteTopic !== null && fresh.topic_id === obsoleteTopic) {
      run('UPDATE visitors SET topic_id=NULL WHERE id=? AND topic_id=?', v.id, obsoleteTopic);
      fresh.topic_id = null;
    }
    if (fresh.topic_id) return fresh;
    const title = fresh.title ? upgradeLegacyTopicTitle(fresh.number, fresh.title) : topicTitle(fresh.number, await region(ip));
    const topic = await telegram('createForumTopic', { chat_id: CHAT_ID, name: title });
    db.transaction(() => {
      run('UPDATE visitors SET topic_id=?,title=? WHERE id=?', topic.message_thread_id, title, v.id);
      // Wake messages that were already waiting on this visitor's old topic.
      run("UPDATE jobs SET available_at=? WHERE kind IN ('outgoing','welcome') AND json_extract(payload,'$.messageId') IN (SELECT id FROM messages WHERE visitor_id=?)", now(), v.id);
    })();
    fresh = sql('SELECT * FROM visitors WHERE id=?', v.id);
    return fresh;
  });
}
async function sendToVisitor(visitorId, method, body, file) {
  let v = sql('SELECT * FROM visitors WHERE id=?', visitorId);
  for (let attempt = 0; attempt < 2; attempt++) {
    v = await ensureTopic(v);
    try {
      const result = await telegram(method, { ...body, chat_id: CHAT_ID, message_thread_id: v.topic_id }, file);
      return { ...result, topicId: v.topic_id };
    } catch (e) {
      if (attempt || (!missingTopic(e) && !(e.code === 400 && /topic[ _]closed/i.test(e.message)))) throw e;
      if (missingTopic(e)) v = await ensureTopic(v, undefined, v.topic_id);
      else await telegram('reopenForumTopic', { chat_id: CHAT_ID, message_thread_id: v.topic_id });
    }
  }
}
function ensureWelcome(v) {
  return db.transaction(() => {
    const exists = sql("SELECT id FROM messages WHERE visitor_id=? AND direction IN ('staff','welcome') AND revoked=0 AND sent_at>? LIMIT 1", v.id, now() - DAY);
    if (exists) return;
    const id = randomUUID();
    run("INSERT INTO messages(id,visitor_id,direction,kind,body,sent_at,status) VALUES(?,?,'welcome','text',?,?,'sent')", id, v.id, WELCOME, now());
    queue('welcome', { messageId: id }, `welcome:${id}`);
    publishMessage(id);
  })();
}

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 'loopback');
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob: data:; media-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
  if (req.path.startsWith('/api/') || req.path.startsWith('/telegram/')) res.setHeader('Cache-Control', 'private, no-store, max-age=0');
  if (['POST','PUT','PATCH','DELETE'].includes(req.method) && req.path.startsWith('/api/') && !ALLOWED_ORIGINS.has(req.headers.origin)) return res.status(403).json({ error: '请求来源不正确' });
  next();
});
app.get('/healthz', (req,res) => res.json({ ok: true, version:APP_VERSION }));
app.use(express.json({ limit: '1mb' }));
app.post('/telegram/webhook', (req, res) => {
  if (!safeEqual(req.headers['x-telegram-bot-api-secret-token'], SECRET)) return res.sendStatus(403);
  const update = req.body;
  if (!Number.isSafeInteger(update?.update_id)) return res.sendStatus(400);
  db.transaction(() => {
    const r = run('INSERT OR IGNORE INTO updates(id,created_at) VALUES(?,?)', update.update_id, now());
    if (r.changes) queue('update', update, `update:${update.update_id}`);
  })();
  res.json({ ok: true });
});
app.post('/api/session', async (req, res, next) => {
  try {
    let v = visitorFrom(req);
    if (!v) {
      if (!allowed(`new:${req.ip}`, 60, 3600000)) return res.status(429).json({ error: '访问过于频繁，请稍后再试' });
      const token = randomBytes(32).toString('hex'), id = randomUUID();
      run('INSERT INTO visitors(id,token_hash,created_at,last_seen) VALUES(?,?,?,?)', id, hash(token), now(), now());
      v = sql('SELECT * FROM visitors WHERE id=?', id);
      res.cookie('kf_session', token, { httpOnly: true, secure: ORIGIN.startsWith('https:'), sameSite: 'lax', maxAge: 365 * DAY, path: '/' });
    } else {
      run('UPDATE visitors SET last_seen=? WHERE id=?', now(), v.id);
      const token = (req.headers.cookie || '').split(';').map(x => x.trim()).find(x => x.startsWith('kf_session='))?.slice(11);
      res.cookie('kf_session', token, { httpOnly: true, secure: ORIGIN.startsWith('https:'), sameSite: 'lax', maxAge: 365 * DAY, path: '/' });
    }
    if (!v.topic_id) {
      queue('topic', { visitorId: v.id, ip: req.ip }, `topic:${v.id}`);
    }
    ensureWelcome(v);
    const messages = db.prepare('SELECT * FROM messages WHERE visitor_id=? AND revoked=0 AND sent_at>? ORDER BY sent_at,id').all(v.id, now() - DAY).map(publicMessage);
    res.json({ name: SITE_NAME, number: String(v.number).padStart(6,'0'), messages, maxFileSize: MB20, serverTime: now(), topicReady: !!v.topic_id });
  } catch(e) { next(e); }
});
app.get('/api/messages', requireVisitor, (req,res) => {
  ensureWelcome(req.visitor);
  res.json({ messages: db.prepare('SELECT * FROM messages WHERE visitor_id=? AND revoked=0 AND sent_at>? ORDER BY sent_at,id').all(req.visitor.id, now() - DAY).map(publicMessage), serverTime: now() });
});
const upload = multer({ storage: multer.diskStorage({ destination: FILES, filename: (req,file,cb) => cb(null, randomUUID()) }), limits: { fileSize: MB20, files: 1, fields: 3, fieldSize: 20000 } });
app.post('/api/messages', requireVisitor, (req,res,next) => {
  if (!allowed(`send:${req.visitor.id}`, 40)) return res.status(429).json({ error: '消息发送过快，请稍后再试' });
  next();
}, upload.single('file'), async (req,res,next) => {
  const discard = () => { if(req.file) fs.rmSync(req.file.path, { force: true }); };
  try {
    const clientId = String(req.body.clientId || '');
    const text = String(req.body.text || '').trim();
    if (!/^[a-zA-Z0-9_-]{8,100}$/.test(clientId)) { discard(); return res.status(400).json({ error: '消息标识无效' }); }
    if (text.length > 4000) { discard(); return res.status(400).json({ error: '文字最多 4000 字' }); }
    if (!text && !req.file) return res.status(400).json({ error: '请输入消息或选择附件' });
    await locked(`submit:${req.visitor.id}:${clientId}`, async () => {
    const existing = sql('SELECT * FROM messages WHERE visitor_id=? AND client_id=?', req.visitor.id, clientId);
    if (existing) { discard(); return res.json({ message: publicMessage(existing) }); }
    if (req.file && (/^image\/(?:jpeg|png|gif|webp|avif|heic|heif)$/.test(req.file.mimetype) || /\.(?:jpe?g|png|gif|webp|avif|heic|heif)$/i.test(req.file.originalname))) {
      const original = req.file.path;
      req.file = await locked('photo-conversion', () => prepareTelegramPhoto(req.file));
      if (req.file.path !== original) fs.rmSync(original, { force: true });
    }
    let filename = req.file?.originalname;
    if (filename) { try { filename = Buffer.from(filename,'latin1').toString('utf8'); } catch {} filename = path.basename(filename).replace(/[\u0000-\u001f]/g,'').slice(0,200); }
    const mime = req.file?.mimetype || '';
    const image = ['image/jpeg','image/png','image/gif','image/webp','image/avif','image/heic','image/heif'].includes(mime);
    const kind = req.file ? image ? 'image' : mime.startsWith('video/') ? 'video' : 'file' : 'text';
    const id = randomUUID();
    db.transaction(() => {
      run('INSERT INTO messages(id,visitor_id,client_id,direction,kind,body,filename,mime,size,file_path,sent_at,status) VALUES(?,?,?,\'visitor\',?,?,?,?,?,?,?,\'queued\')', id,req.visitor.id,clientId,kind,text,filename||null,mime||null,req.file?.size||null,req.file?.path||null,now());
      queue('outgoing', { messageId: id }, `outgoing:${id}`);
    })();
    publishMessage(id);
    res.status(201).json({ message: publicMessage(sql('SELECT * FROM messages WHERE id=?', id)) });
    });
  } catch(e) { discard(); next(e); }
});
app.post('/api/messages/:id/retry', requireVisitor, (req,res) => {
  if (!allowed(`retry:${req.visitor.id}`,10)) return res.status(429).json({error:'重试过于频繁，请稍后再试'});
  const m=sql('SELECT * FROM messages WHERE id=? AND visitor_id=? AND revoked=0 AND sent_at>?',req.params.id,req.visitor.id,now()-DAY);
  if (!m) return res.status(404).json({error:'消息不存在或已过期'});
  db.transaction(() => {
    // A retry never resets successful delivery steps or creates another message.
    for (const job of db.prepare("SELECT id,kind FROM jobs WHERE state='failed' AND json_extract(payload,'$.messageId')=?").all(m.id)) {
      run("UPDATE jobs SET state='pending',attempts=0,last_error=NULL,failed_at=NULL,last_attempt_at=0,retry_after_until=0,rate_limited_since=0,available_at=? WHERE id=?",now(),job.id);
      if (job.kind==='outgoing' || job.kind==='photo-caption') run("UPDATE messages SET status='queued',failure_reason=NULL WHERE id=?",m.id);
      if (job.kind==='incoming-file' || job.kind==='photo-store') run("UPDATE messages SET file_status='pending',file_error=NULL WHERE id=?",m.id);
    }
  })();
  publishMessage(m.id);
  res.json({message:publicMessage(sql('SELECT * FROM messages WHERE id=?',m.id))});
});
app.post('/api/read', requireVisitor, (req,res) => {
  const ids = Array.isArray(req.body.ids) ? req.body.ids.slice(0,200) : [];
  db.transaction(() => {
    for (const id of ids) {
      if (typeof id !== 'string') continue;
      const m = sql("SELECT * FROM messages WHERE id=? AND visitor_id=? AND direction='staff' AND revoked=0 AND sent_at>?", id, req.visitor.id, now()-DAY);
      if (!m || m.read_at || (m.kind!=='text' && m.file_status!=='ready')) continue;
      run('UPDATE messages SET read_at=? WHERE id=?', now(), id);
      queue('read', { messageId: id }, `read:${id}`);
    }
  })();
  res.json({ ok:true });
});
app.get('/api/files/:id', requireVisitor, (req,res) => {
  const m = sql('SELECT * FROM messages WHERE id=? AND visitor_id=? AND revoked=0 AND sent_at>?', req.params.id, req.visitor.id, now()-DAY);
  if (!m?.file_path || !fs.existsSync(m.file_path)) return res.status(404).json({ error: '附件不存在或已过期' });
  const preview = req.query.preview === '1' && m.preview_path;
  const mime=preview ? m.preview_mime : m.mime, file=preview ? m.preview_path : m.file_path;
  if (!fs.existsSync(file)) return res.status(404).json({error:'附件不存在或已过期'});
  const inline = req.query.preview === '1' && (['image/jpeg','image/png','image/gif','image/webp','image/avif'].includes(mime) || ['video/mp4','video/webm','video/quicktime'].includes(mime));
  res.type(inline ? mime : 'application/octet-stream');
  res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(m.filename || '附件')}`);
  res.setHeader('Cache-Control','private, no-store, max-age=0');
  res.sendFile(file);
});
app.use(express.static(path.join(HERE, 'public'), { maxAge: '1h', etag: true, setHeaders(res, file) { if(file.endsWith('.html')) res.setHeader('Cache-Control','no-cache'); } }));
app.use((err,req,res,next) => {
  if (res.headersSent) return next(err);
  if (err instanceof multer.MulterError) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? '单个附件不能超过 20 MB' : '附件上传失败，请重新选择' });
  if (err.code === 'INVALID_PHOTO') return res.status(400).json({ error: err.message });
  console.error('Request error:', err.name, err.code || 'internal');
  res.status(500).json({ error: '服务暂时繁忙，请稍后重试' });
});

async function fetchFile(file) {
  if ((file.file_size || 0) > MB20) throw Object.assign(new Error('附件超过 20 MB，请发送较小的文件'),{permanent:true});
  const d = await telegram('getFile', { file_id: file.file_id });
  assertJobCurrent();
  const res = await fetch(`${TG_BASE}/file/bot${BOT_TOKEN}/${d.file_path}`, { signal: AbortSignal.timeout(90000) });
  if (!res.ok) { await res.body?.cancel(); throw Object.assign(new Error('附件下载失败'),{code:res.status}); }
  const dest = path.join(FILES, randomUUID());
  const { Readable, Transform } = await import('node:stream');
  const { pipeline } = await import('node:stream/promises');
  let size = 0;
  try {
    await pipeline(Readable.fromWeb(res.body), new Transform({ transform(chunk,enc,cb) { size += chunk.length; cb(size > MB20 ? Object.assign(new Error('附件超过 20 MB'),{permanent:true}) : null, chunk); } }), fs.createWriteStream(dest, { mode:0o600 }));
    return { path:dest,size };
  } catch(e) { fs.rmSync(dest,{force:true}); throw e; }
}
function processUpdate(update) {
  if(sql('SELECT id FROM processed_updates WHERE id=?',update.update_id)) return;
  const m=update.message || update.edited_message;
  if(!m || String(m.chat?.id)!==CHAT_ID) return;
  const v=sql('SELECT * FROM visitors WHERE topic_id=?',m.message_thread_id || -1);
  if(!v) return;
  if(m.forum_topic_edited?.name) { run('UPDATE visitors SET title=? WHERE id=?',m.forum_topic_edited.name,v.id); return; }
  if(m.from?.is_bot || !STAFF_IDS.has(String(m.from?.id))) return;
  const command=(m.text || '').trim()==='撤回' || /^\/ch(?:@[a-zA-Z0-9_]+)?(?:\s|$)/i.test(m.text || '');
  if(command) {
    if(update.edited_message) return;
    const reply=m.reply_to_message,target=reply?.message_id;
    const found=target && sql("SELECT * FROM messages WHERE visitor_id=? AND tg_topic_id=? AND tg_message_id=? AND direction='staff'",v.id,v.topic_id,target);
    // Telegram includes the replied-to author. Keep a tombstone even if the
    // original webhook has not arrived, but never accept arbitrary message ids.
    const verifiedReply=reply && Number.isSafeInteger(target) && reply.from && !reply.from.is_bot && STAFF_IDS.has(String(reply.from.id)) &&
      (!reply.chat || String(reply.chat.id)===CHAT_ID) && (!reply.message_thread_id || reply.message_thread_id===v.topic_id) &&
      Number(reply.date)*1000>now()-7*DAY && Number(reply.date)*1000<=now()+60000;
    db.transaction(() => {
      const op=run('INSERT OR IGNORE INTO operations(id,created_at) VALUES(?,?)',`revoke:${m.message_id}`,now());
      if(!op.changes) return;
      if(found || verifiedReply) {
        run('INSERT OR IGNORE INTO tombstones(visitor_id,topic_id,message_id,created_at) VALUES(?,?,?,?)',v.id,v.topic_id,target,now());
        if(found) {
          run('UPDATE messages SET revoked=1 WHERE id=?',found.id);
          broadcast(v.id,{type:'remove',id:found.id});
        }
        queue('notice',{topicId:v.topic_id,text:'已撤回',replyId:m.message_id},`revoke-notice:${m.message_id}`);
      } else queue('notice',{topicId:v.topic_id,text:'请回复一条最近 7 天内由客服发送的客户消息，再发送“撤回”。',replyId:m.message_id},`revoke-notice:${m.message_id}`);
      run('INSERT OR IGNORE INTO processed_updates(id,created_at) VALUES(?,?)',update.update_id,now());
    })();
    return;
  }
  if((m.text || '').startsWith('/')) return;
  if(sql('SELECT 1 FROM tombstones WHERE visitor_id=? AND topic_id=? AND message_id=?',v.id,v.topic_id,m.message_id)) return;
  const existing=sql("SELECT * FROM messages WHERE visitor_id=? AND tg_message_id=? AND direction='staff'",v.id,m.message_id);
  const edit=!!update.edited_message, sourceDate=Number(m.edit_date || m.date || 0);
  if(existing?.revoked || (edit && Number(existing?.sent_at || Number(m.date)*1000)<=now()-DAY)) return;
  if(!edit && existing) return;
  if(existing && (sourceDate<existing.source_date || (sourceDate===existing.source_date && update.update_id<=existing.source_update))) return;
  const photo=largestPhoto(m.photo);
  const media=m.document || m.video || (photo ? {...photo,mime_type:'image/jpeg',file_name:`图片-${m.message_id}.jpg`} : null);
  const body=m.text || m.caption || '';
  if(!media && !body) return;
  if(media?.file_size>MB20) {
    queue('notice',{topicId:v.topic_id,text:'附件超过 20 MB，请发送较小的文件',replyId:m.message_id},`file-error:${update.update_id}`);
    return;
  }
  const mime=media?.mime_type || (m.video ? 'video/mp4' : 'application/octet-stream');
  const kind=media ? (/^image\/(jpeg|png|gif|webp|avif|heic|heif)$/.test(mime) || /\.(heic|heif)$/i.test(media.file_name || '') ? 'image' : mime.startsWith('video/') ? 'video' : 'file') : 'text';
  const reuse=!!(media && existing?.tg_file_id===media.file_id && existing.file_path && existing.file_status==='ready' && fs.existsSync(existing.file_path));
  const id=existing?.id || randomUUID(), fileStatus=media && !reuse ? 'pending' : 'ready';
  db.transaction(() => {
    if(existing) {
      run(`UPDATE messages SET body=?,kind=?,filename=?,mime=?,size=?,file_path=?,preview_path=?,preview_mime=?,tg_file_id=?,edited_at=?,tg_topic_id=?,is_photo=?,source_date=?,source_update=?,media_json=?,file_status=?,file_error=NULL,status='sent',failure_reason=NULL WHERE id=?`,
        body,kind,media?.file_name || (media?`视频-${m.message_id}.mp4`:null),media?mime:null,reuse?existing.size:null,reuse?existing.file_path:null,reuse?existing.preview_path:null,reuse?existing.preview_mime:null,media?.file_id || null,now(),v.topic_id,photo?1:0,sourceDate,update.update_id,media?JSON.stringify(media):null,fileStatus,id);
      queue('notice',{topicId:v.topic_id,text:'已更新',replyId:m.message_id},`edit-notice:${update.update_id}`);
    } else {
      run(`INSERT INTO messages(id,visitor_id,direction,kind,body,filename,mime,tg_message_id,tg_sender_id,tg_file_id,sent_at,status,tg_topic_id,is_photo,source_date,source_update,media_json,file_status) VALUES(?,?,'staff',?,?,?,?,?,?,?,?,'sent',?,?,?,?,?,?)`,
        id,v.id,kind,body,media?.file_name || (media?`视频-${m.message_id}.mp4`:null),media?mime:null,m.message_id,String(m.from.id),media?.file_id || null,Number(m.date)*1000,v.topic_id,photo?1:0,sourceDate,update.update_id,media?JSON.stringify(media):null,fileStatus);
    }
    // Metadata supersedes old retries; running downloads also verify the version
    // after every await, and discard their output if superseded or revoked.
    run("DELETE FROM jobs WHERE kind='incoming-file' AND json_extract(payload,'$.messageId')=?",id);
    if(fileStatus==='pending') queue('incoming-file',{messageId:id,version:update.update_id},`incoming-file:${id}:${update.update_id}`);
    run('INSERT OR IGNORE INTO processed_updates(id,created_at) VALUES(?,?)',update.update_id,now());
  })();
  if(existing && !reuse) for(const f of [existing.file_path,existing.preview_path]) if(f) fs.rmSync(f,{force:true});
  publishMessage(id);
}
function currentVersion(m,p) {
  const fresh=sql('SELECT * FROM messages WHERE id=?',m.id);
  return fresh && !fresh.revoked && fresh.source_update===p.version ? fresh : null;
}
async function hydrateIncoming(m,p) {
  if(!currentVersion(m,p) || !m.media_json) return;
  let file,preview;
  try {
    file=await fetchFile(JSON.parse(m.media_json));
    if(!currentVersion(m,p)) return;
    if(m.kind==='image') preview=await locked('photo-conversion',() => createImagePreview({path:file.path,size:file.size,mimetype:m.mime,originalname:m.filename || '图片'}));
    if(!currentVersion(m,p)) return;
    run("UPDATE messages SET file_path=?,size=?,preview_path=?,preview_mime=?,file_status='ready',file_error=NULL WHERE id=? AND source_update=? AND revoked=0",file.path,file.size,preview?.path || null,preview?.mimetype || null,m.id,p.version);
    file=null;preview=null;
    publishMessage(m.id);
  } finally {
    if(file) fs.rmSync(file.path,{force:true});
    if(preview) fs.rmSync(preview.path,{force:true});
  }
}
async function storePhoto(m) {
  if(!m.tg_file_id || m.revoked || m.file_status==='ready') return;
  const file=await fetchFile({file_id:m.tg_file_id});
  const fresh=sql('SELECT * FROM messages WHERE id=?',m.id);
  if(!fresh || fresh.revoked || fresh.tg_file_id!==m.tg_file_id) { fs.rmSync(file.path,{force:true}); return; }
  run("UPDATE messages SET file_path=?,size=?,mime='image/jpeg',filename=?,file_status='ready',file_error=NULL WHERE id=?",file.path,file.size,`${path.parse(m.filename || '图片').name}.jpg`,m.id);
  if(fresh.file_path && fresh.file_path!==file.path) fs.rmSync(fresh.file_path,{force:true});
  publishMessage(m.id);
}
async function processJob(job) {
  const p=JSON.parse(job.payload);
  if(job.kind==='update') return processUpdate(p);
  if(job.kind==='topic') {
    const v=sql('SELECT * FROM visitors WHERE id=?',p.visitorId);
    if(v) await ensureTopic(v,p.ip);
    return;
  }
  if(job.kind==='notice') {
    try { return await telegram('sendMessage',{chat_id:CHAT_ID,message_thread_id:p.topicId,text:p.text,...(p.replyId?{reply_parameters:{message_id:p.replyId,allow_sending_without_reply:true}}:{})}); }
    catch(e) { if(!missingTopic(e) && !missingMessage(e)) throw e; }
    return;
  }
  const m=sql('SELECT * FROM messages WHERE id=?',p.messageId);
  if(!m || m.revoked) return;
  const v=sql('SELECT * FROM visitors WHERE id=?',m.visitor_id);
  if(!v) return;
  if(job.kind==='incoming-file') return hydrateIncoming(m,p);
  if(job.kind==='photo-store') return storePhoto(m);
  if(job.kind==='read') {
    if(m.read_notified || !m.tg_message_id || m.tg_topic_id!==v.topic_id) return;
    try { await telegram('setMessageReaction',{chat_id:CHAT_ID,message_id:m.tg_message_id,reaction:[{type:'emoji',emoji:'👍'}],is_big:false}); }
    catch(e) { if(missingTopic(e) || missingMessage(e)) return; throw e; }
    run('UPDATE messages SET read_notified=1 WHERE id=?',m.id);
    return;
  }
  if(job.kind==='welcome') {
    if(m.tg_message_id) return;
    const r=await sendToVisitor(v.id,'sendMessage',{text:`【系统欢迎语，已显示在客户网页】\n${m.body}`});
    run('UPDATE messages SET tg_message_id=?,tg_topic_id=? WHERE id=?',r.message_id,r.topicId,m.id);
    return;
  }
  if(job.kind==='photo-caption') {
    if(m.caption_sent || m.body.length<=1024) return;
    const r=await sendToVisitor(v.id,'sendMessage',{text:m.body});
    run("UPDATE messages SET caption_sent=1,caption_message_id=?,status='sent',failure_reason=NULL WHERE id=?",r.message_id,m.id);
    publishMessage(m.id);
    return;
  }
  if(job.kind==='outgoing') {
    if(m.status==='sent') {
      // Migrate old successfully delivered photos that were waiting on a copy.
      if(m.kind==='image' && m.tg_file_id && m.file_status!=='ready') queue('photo-store',{messageId:m.id},`photo-store:${m.id}`);
      return;
    }
    let sent=m;
    if(!m.tg_message_id) {
      let r;
      if(m.file_path && m.kind==='image') {
        r=await sendToVisitor(v.id,'sendPhoto',{...(m.body && m.body.length<=1024?{caption:m.body}:{})},{path:m.file_path,mime:m.mime,filename:m.filename});
        const photo=largestPhoto(r.photo);
        if(!photo) throw new Error('Telegram 未返回照片尺寸');
        db.transaction(() => {
          run("UPDATE messages SET tg_message_id=?,tg_topic_id=?,tg_file_id=?,is_photo=1,file_status='pending',file_error=NULL WHERE id=?",r.message_id,r.topicId,photo.file_id,m.id);
          queue('photo-store',{messageId:m.id},`photo-store:${m.id}`);
        })();
      } else if(m.file_path) {
        r=await sendToVisitor(v.id,'sendDocument',{...(m.body && m.body.length<=1024?{caption:m.body}:{})},{path:m.file_path,mime:m.mime,filename:m.filename});
        run('UPDATE messages SET tg_message_id=?,tg_topic_id=? WHERE id=?',r.message_id,r.topicId,m.id);
      } else {
        r=await sendToVisitor(v.id,'sendMessage',{text:m.body});
        run('UPDATE messages SET tg_message_id=?,tg_topic_id=? WHERE id=?',r.message_id,r.topicId,m.id);
      }
      sent=sql('SELECT * FROM messages WHERE id=?',m.id);
    } else if(m.kind==='image' && m.tg_file_id && m.file_status==='ready' && m.status!=='sent' && !m.is_photo) {
      run("UPDATE messages SET file_status='pending',is_photo=1 WHERE id=?",m.id);
      queue('photo-store',{messageId:m.id},`photo-store:${m.id}`);
    }
    // The successful file step is durable before attempting separate text.
    if(sent.file_path && sent.body.length>1024 && !sent.caption_sent) {
      const r=await sendToVisitor(v.id,'sendMessage',{text:sent.body});
      run('UPDATE messages SET caption_sent=1,caption_message_id=? WHERE id=?',r.message_id,m.id);
    }
    run("UPDATE messages SET status='sent',failure_reason=NULL WHERE id=?",m.id);
    publishMessage(m.id);
  }
}
const activeJobs=new Map(), laneBusy=new Set();
let stopping=false,dispatching=false;
const CAPACITY={send:4,download:2,aux:2};
function expiredJob(job) { return job && job.kind!=='update' && job.created_at<=now()-DAY; }
function assertJobCurrent() {
  if(expiredJob(jobContext.getStore()))throw Object.assign(new Error('任务已超过 24 小时处理期限'),{code:'TASK_EXPIRED',permanent:true});
}
function retryableError(e) {
  if(e.permanent || ['ENOENT','EACCES','INVALID_PHOTO'].includes(e.code)) return false;
  if(Number(e.code)===400 || Number(e.code)===401 || Number(e.code)===404) return false;
  return true;
}
function failureText(e,job,m) {
  if(e.code==='TASK_EXPIRED')return m?.tg_message_id && !m.caption_sent && m.body.length>1024 ? '附件已送达，说明文字已超过投递期限' : '任务已超过 24 小时处理期限';
  if(Number(e.code)===403 || Number(e.code)===401) return '客服通道权限异常，请稍后重试或联系网站管理员';
  if(job.kind==='incoming-file' || job.kind==='photo-store') return e.code==='INVALID_PHOTO' ? '图片预览处理失败，请重试或改发 JPEG / PNG 图片' : '附件暂时无法加载，请点击重试';
  if(m?.tg_message_id && m.body.length>1024 && !m.caption_sent) return '附件已送达，说明文字发送失败，请点击重试';
  return Number(e.code)===400 ? '客服通道无法接收此消息，请检查附件格式后重试' : '消息发送失败，请点击重试';
}
function failJob(job,e) {
  // Superseded downloads must not change the latest message's error state.
  if(!sql('SELECT id FROM jobs WHERE id=?',job.id)) return;
  const p=JSON.parse(job.payload),m=p.messageId && sql('SELECT * FROM messages WHERE id=?',p.messageId);
  if(job.kind==='incoming-file' && (!m || !currentVersion(m,p))) { run('DELETE FROM jobs WHERE id=?',job.id); return; }
  const limited=!!e.retryAfter || Number(e.code)===429;
  const attempts=job.attempts+(limited||e.code==='TASK_EXPIRED'?0:1);
  const terminal=!retryableError(e) || attempts>=8 || job.created_at<now()-DAY;
  const delay=Math.max((e.retryAfter || (limited?1:0))*1000,Math.min(300000,1000*2**Math.min(attempts,8)));
  const error=String(e.message).replaceAll(BOT_TOKEN,'[redacted]').slice(0,200);
  run('UPDATE jobs SET attempts=?,available_at=?,last_error=?,state=?,failed_at=?,retry_after_until=?,rate_limited_since=? WHERE id=?',attempts,now()+delay,error,terminal?'failed':'pending',terminal?now():null,limited?now()+Math.max(1000,e.retryAfter*1000||1000):0,limited?(job.rate_limited_since||now()):0,job.id);
  if(m && !m.revoked) {
    const reason=failureText(e,job,m);
    if(job.kind==='outgoing' || job.kind==='photo-caption') run('UPDATE messages SET status=?,failure_reason=? WHERE id=?',terminal?'failed':'delayed',terminal?reason:null,m.id);
    if(job.kind==='incoming-file' || job.kind==='photo-store') run('UPDATE messages SET file_status=?,file_error=? WHERE id=?',terminal?'failed':'delayed',terminal?reason:null,m.id);
    publishMessage(m.id);
    if(terminal && job.kind==='incoming-file' && e.code!=='TASK_EXPIRED') queue('notice',{topicId:m.tg_topic_id,replyId:m.tg_message_id,text:`网页附件加载失败：${reason}`},`failed-file:${job.id}`);
  }
  if(terminal || attempts===1 || attempts%20===0) console.error(`Job ${job.id} (${job.kind}) ${terminal?'failed':'delayed'}:`,error.slice(0,160));
}
async function work() {
  if(stopping || dispatching) return;
  dispatching=true;
  try {
    migrateJobScopes();
    // Expire waiting work even during a long retry_after pause. Metadata remains
    // durable so late incoming updates can still be reconciled with retention.
    for(const job of db.prepare("SELECT * FROM jobs WHERE state='pending' AND kind!='update' AND created_at<=?").all(now()-DAY)) {
      if(!activeJobs.has(job.id))failJob(job,Object.assign(new Error('任务已超过 24 小时处理期限'),{code:'TASK_EXPIRED',permanent:true}));
    }
    // Accept metadata immediately, even while Telegram is slow or rate limited.
    for(const job of db.prepare("SELECT * FROM jobs WHERE state='pending' AND category='metadata' AND available_at<=? ORDER BY id LIMIT 100").all(now())) {
      try { processUpdate(JSON.parse(job.payload));run('DELETE FROM jobs WHERE id=?',job.id); }
      catch(e) { failJob(job,e); }
    }
    if(now()<telegramPauseUntil) return;
    for(const [category,limit] of Object.entries(CAPACITY)) {
      let count=[...activeJobs.values()].filter(j=>j.category===category).length;
      const jobs=db.prepare(`SELECT j.* FROM jobs j WHERE j.state='pending' AND j.category=? AND j.available_at<=? AND NOT EXISTS (
        SELECT 1 FROM jobs earlier WHERE earlier.state='pending' AND earlier.category=j.category AND earlier.lane=j.lane AND earlier.id<j.id
      ) ORDER BY j.id LIMIT 100`).all(category,now());
      for(const job of jobs) {
        if(count>=limit || now()<telegramPauseUntil) break;
        if(activeJobs.has(job.id) || laneBusy.has(job.lane)) continue;
        run('UPDATE jobs SET last_attempt_at=? WHERE id=?',now(),job.id);
        count++;activeJobs.set(job.id,job);laneBusy.add(job.lane);
        Promise.resolve().then(()=>jobContext.run(job,()=>{assertJobCurrent();return processJob(job);})).then(()=>run('DELETE FROM jobs WHERE id=?',job.id)).catch(e=>failJob(job,e)).finally(()=>{
          activeJobs.delete(job.id);laneBusy.delete(job.lane);
          if(!stopping) setImmediate(()=>work().catch(e=>console.error('Worker failure:',e.name)));
        });
      }
    }
  } finally { dispatching=false; }
}
function cleanup() {
  const cutoff = now()-7*DAY;
  const expired = db.prepare('SELECT file_path,preview_path FROM messages WHERE sent_at<? AND (file_path IS NOT NULL OR preview_path IS NOT NULL)').all(cutoff);
  for(const m of expired) for(const f of [m.file_path,m.preview_path]) if(f) fs.rmSync(f,{force:true});
  db.transaction(()=>{
    run('DELETE FROM messages WHERE sent_at<?',cutoff);
    run('DELETE FROM updates WHERE created_at<?',cutoff);
    run('DELETE FROM processed_updates WHERE created_at<?',cutoff);
    run('DELETE FROM operations WHERE created_at<?',cutoff);
    run('DELETE FROM tombstones WHERE created_at<?',cutoff);
    run('DELETE FROM jobs WHERE created_at<?',cutoff);
  })();
  const referenced = new Set(db.prepare('SELECT file_path,preview_path FROM messages').all().flatMap(x=>[x.file_path,x.preview_path]).filter(Boolean));
  for(const name of fs.readdirSync(FILES)) {
    const f = path.join(FILES,name);
    if(!referenced.has(f) && fs.statSync(f).mtimeMs<now()-3600000) fs.rmSync(f,{force:true,recursive:true});
  }
  for(const [k,v] of buckets) if(v.start<now()-3600000) buckets.delete(k);
}
const server = createServer(app);
const wss = new WebSocketServer({ noServer:true,maxPayload:4096 });
server.on('upgrade',(req,socket,head)=>{
  const v=visitorFrom(req);
  if(req.url!=='/ws' || !ALLOWED_ORIGINS.has(req.headers.origin) || !v) { socket.write('HTTP/1.1 403 Forbidden\r\n\r\n'); socket.destroy(); return; }
  if((sockets.get(v.id)?.size||0)>=8) {socket.destroy();return;}
  wss.handleUpgrade(req,socket,head,ws=>{
    if(!sockets.has(v.id)) sockets.set(v.id,new Set());
    sockets.get(v.id).add(ws);ws.isAlive=true;
    ws.on('pong',()=>{ws.isAlive=true;});
    ws.on('error',()=>{});
    ws.on('close',()=>{sockets.get(v.id)?.delete(ws);if(!sockets.get(v.id)?.size)sockets.delete(v.id);});
    ws.send(JSON.stringify({type:'connected'}));
  });
});
setInterval(()=>{for(const clients of sockets.values())for(const ws of clients){if(!ws.isAlive){ws.terminate();continue;}ws.isAlive=false;ws.ping();}},30000).unref();
setInterval(()=>work().catch(e=>console.error('Worker failure:',e.name)),300).unref();
setInterval(()=>{try{cleanup();}catch(e){console.error('Cleanup failure:',e.name);}},3600000).unref();
cleanup();
server.listen(PORT,HOST,()=>console.log(`Customer service listening on ${HOST}:${PORT}`));
function shutdown(){stopping=true;wss.close();for(const set of sockets.values())for(const ws of set)ws.close();server.close(()=>{const drain=setInterval(()=>{if(!activeJobs.size){clearInterval(drain);geo?.close();db.close();process.exit(0);}},50);});setTimeout(()=>process.exit(0),10000).unref();}
process.on('SIGTERM',shutdown);process.on('SIGINT',shutdown);
