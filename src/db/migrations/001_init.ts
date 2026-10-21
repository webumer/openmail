export const version = 1;

export const sql = `
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT COLLATE NOCASE NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  wrapped_data_key BLOB NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf_secret TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE INDEX sessions_user_id ON sessions(user_id);

CREATE TABLE api_keys (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  prefix TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at TEXT
);

CREATE INDEX api_keys_user_id ON api_keys(user_id);

CREATE TABLE mail_accounts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  username TEXT NOT NULL,
  preset TEXT NOT NULL,
  imap_host TEXT NOT NULL,
  imap_port INTEGER NOT NULL,
  imap_secure INTEGER NOT NULL CHECK (imap_secure IN (0, 1)),
  smtp_host TEXT NOT NULL,
  smtp_port INTEGER NOT NULL,
  smtp_secure INTEGER NOT NULL CHECK (smtp_secure IN (0, 1)),
  smtp_starttls INTEGER NOT NULL CHECK (smtp_starttls IN (0, 1)),
  password_ciphertext BLOB NOT NULL,
  password_iv BLOB NOT NULL CHECK (length(password_iv) = 12),
  password_tag BLOB NOT NULL CHECK (length(password_tag) = 16),
  created_at TEXT NOT NULL,
  UNIQUE (user_id, name)
);

CREATE INDEX mail_accounts_user_id ON mail_accounts(user_id);
`;
