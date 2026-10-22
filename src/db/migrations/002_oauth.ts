export const version = 2;

/**
 * OAuth 2.1 authorization server state. Every secret value (codes, access
 * tokens, refresh tokens, client secrets) is stored only as a SHA-256 hash.
 */
export const sql = `
CREATE TABLE oauth_clients (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('dcr', 'cimd')),
  client_name TEXT NOT NULL,
  client_uri TEXT,
  redirect_uris TEXT NOT NULL,
  token_endpoint_auth_method TEXT NOT NULL
    CHECK (token_endpoint_auth_method IN ('none', 'client_secret_post', 'client_secret_basic')),
  secret_hash TEXT,
  created_at TEXT NOT NULL,
  refreshed_at TEXT NOT NULL,
  cache_expires_at TEXT,
  last_used_at TEXT
);

CREATE INDEX oauth_clients_kind_created ON oauth_clients(kind, created_at);

CREATE TABLE oauth_grants (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_id TEXT NOT NULL,
  client_kind TEXT NOT NULL,
  client_name TEXT NOT NULL,
  redirect_host TEXT NOT NULL,
  scope TEXT NOT NULL,
  resource TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at TEXT
);

CREATE INDEX oauth_grants_user_id ON oauth_grants(user_id);
CREATE INDEX oauth_grants_client_id ON oauth_grants(client_id);

CREATE TABLE oauth_codes (
  code_hash TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  redirect_uri TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  scope TEXT NOT NULL,
  resource TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  grant_id TEXT
);

CREATE INDEX oauth_codes_expires_at ON oauth_codes(expires_at);

CREATE TABLE oauth_tokens (
  token_hash TEXT PRIMARY KEY,
  grant_id TEXT NOT NULL REFERENCES oauth_grants(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('access', 'refresh')),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  rotated_at TEXT,
  revoked_at TEXT
);

CREATE INDEX oauth_tokens_grant_id ON oauth_tokens(grant_id);
CREATE INDEX oauth_tokens_expires_at ON oauth_tokens(expires_at);
`;
