import type Database from "better-sqlite3";
import { apiKeys } from "../services/index.js";
import { readBearerToken } from "./auth.js";

/** Bearer token → SHA-256 → api_keys row that is not revoked → that key's user. */
export function authenticateDatabaseKey(
  db: Database,
  authorizationHeader: string | undefined,
): { userId: string; keyId: string } | null {
  const token = readBearerToken(authorizationHeader);
  if (!token) return null;
  return apiKeys.resolve(db, token);
}
