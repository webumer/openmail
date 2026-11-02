export const version = 5;

export const sql = `
CREATE TABLE password_resets (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT
);
CREATE INDEX password_resets_user_id ON password_resets(user_id);
CREATE INDEX password_resets_expires_at ON password_resets(expires_at);
`;
