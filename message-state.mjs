// SQLite owns the sequence so restarts and every durable message mutation use
// the same ordering as HTTP snapshots and realtime events.
export function initializeMessageState(db) {
  db.transaction(() => {
    const visitorColumns = new Set(db.prepare('PRAGMA table_info(visitors)').all().map(c => c.name));
    const messageColumns = db.prepare('PRAGMA table_info(messages)').all().map(c => c.name);
    if (!visitorColumns.has('state_version')) db.exec('ALTER TABLE visitors ADD COLUMN state_version INTEGER NOT NULL DEFAULT 0');
    if (!messageColumns.includes('revision')) {
      db.exec('ALTER TABLE messages ADD COLUMN revision INTEGER NOT NULL DEFAULT 0');
      db.exec(`UPDATE visitors SET state_version=state_version+1 WHERE EXISTS (SELECT 1 FROM messages WHERE visitor_id=visitors.id);
        UPDATE messages SET revision=(SELECT state_version FROM visitors WHERE id=messages.visitor_id);`);
    }
    const changes = messageColumns.filter(c => c !== 'revision').map(c => `"${c}"`).join(',');
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS message_state_insert AFTER INSERT ON messages BEGIN
        UPDATE visitors SET state_version=state_version+1 WHERE id=NEW.visitor_id;
        UPDATE messages SET revision=(SELECT state_version FROM visitors WHERE id=NEW.visitor_id) WHERE id=NEW.id;
      END;
      CREATE TRIGGER IF NOT EXISTS message_state_update AFTER UPDATE OF ${changes} ON messages BEGIN
        UPDATE visitors SET state_version=state_version+1 WHERE id=NEW.visitor_id;
        UPDATE messages SET revision=(SELECT state_version FROM visitors WHERE id=NEW.visitor_id) WHERE id=NEW.id;
      END;
      CREATE TRIGGER IF NOT EXISTS message_state_delete AFTER DELETE ON messages BEGIN
        UPDATE visitors SET state_version=state_version+1 WHERE id=OLD.visitor_id;
      END;
    `);
  })();
}

export function messageSnapshot(db, visitorId, cutoff, serialize) {
  return db.transaction(() => ({
    messages: db.prepare('SELECT * FROM messages WHERE visitor_id=? AND revoked=0 AND sent_at>? ORDER BY sent_at,id').all(visitorId, cutoff).map(serialize),
    stateVersion: db.prepare('SELECT state_version FROM visitors WHERE id=?').get(visitorId).state_version
  }))();
}
