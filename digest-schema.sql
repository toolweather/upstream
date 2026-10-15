CREATE TABLE IF NOT EXISTS digests (date TEXT PRIMARY KEY, window_start TEXT, window_end TEXT, title TEXT, summary TEXT, markdown TEXT, data TEXT, created_at TEXT);
CREATE TABLE IF NOT EXISTS tw_events (id INTEGER PRIMARY KEY AUTOINCREMENT, url TEXT, name TEXT, kind TEXT, detail TEXT, at TEXT);
CREATE INDEX IF NOT EXISTS tw_events_at ON tw_events(at);
CREATE TABLE IF NOT EXISTS subscribers (email TEXT PRIMARY KEY, status TEXT, confirm_hash TEXT, unsub_hash TEXT, ip_hash TEXT, created_at TEXT, confirmed_at TEXT, unsubscribed_at TEXT, confirm_sent_at TEXT);
CREATE TABLE IF NOT EXISTS email_outbox (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT, kind TEXT, subject TEXT, body TEXT, created_at TEXT, state TEXT);
