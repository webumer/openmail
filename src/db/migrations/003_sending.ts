export const version = 3;

/**
 * Opt-in sending. Existing rows stay read-only: send_enabled and can_send
 * default to 0. The send log stores metadata only — no bodies, subjects,
 * or addresses.
 */
export const sql = `
ALTER TABLE mail_accounts ADD COLUMN send_enabled INTEGER NOT NULL DEFAULT 0 CHECK (send_enabled IN (0, 1));
ALTER TABLE mail_accounts ADD COLUMN smtp_username TEXT;
ALTER TABLE mail_accounts ADD COLUMN smtp_password_ciphertext BLOB;
ALTER TABLE mail_accounts ADD COLUMN smtp_password_iv BLOB;
ALTER TABLE mail_accounts ADD COLUMN smtp_password_tag BLOB;

ALTER TABLE api_keys ADD COLUMN can_send INTEGER NOT NULL DEFAULT 0 CHECK (can_send IN (0, 1));

CREATE TABLE send_log (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL,
  account_label TEXT NOT NULL,
  created_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('sent', 'failed')),
  recipients INTEGER NOT NULL,
  message_id TEXT,
  error_code TEXT,
  via TEXT NOT NULL
);

CREATE INDEX send_log_user_created ON send_log (user_id, created_at);
CREATE INDEX send_log_account_created ON send_log (account_id, created_at);

-- Scope actually issued on this access or refresh token. NULL on tokens
-- created before the column existed; those still authorize from the grant.
ALTER TABLE oauth_tokens ADD COLUMN scope TEXT;
`;
