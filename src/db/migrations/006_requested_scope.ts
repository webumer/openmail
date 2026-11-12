export const version = 6;

/**
 * Scope the client asked for, kept next to the scope the user granted. The
 * consent page can grant more than was asked (the user may tick "Also allow
 * sending" when a client asked for read only). Refresh uses this to tell a
 * client re-sending its original scope apart from one asking for less, so a
 * user-granted mail.send is not dropped silently. NULL on older rows: treated
 * as equal to the granted scope (previous behaviour).
 */
export const sql = `
ALTER TABLE oauth_codes ADD COLUMN requested_scope TEXT;
ALTER TABLE oauth_grants ADD COLUMN requested_scope TEXT;
`;
