import { randomBytes, randomUUID } from "node:crypto";
import { hash, verify, type Algorithm } from "@node-rs/argon2";
import type Database from "better-sqlite3";
import { generateDataKey, wrapDataKey } from "../crypto/envelope.js";
import { isUniqueConstraint } from "../db/constraint.js";
import { MailError } from "../errors.js";
import { parseEmail, requireUserPassword } from "./validate.js";

/** Library default is Argon2id. The numeric value avoids a const enum that is erased at runtime. */
const ARGON2ID = 2 as Algorithm;

const ARGON_OPTIONS = {
  algorithm: ARGON2ID,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

export interface UserRecord {
  id: string;
  email: string;
}

let dummyHash: Promise<string> | undefined;

function dummyPasswordHash(): Promise<string> {
  dummyHash ??= hash(randomBytes(32), ARGON_OPTIONS);
  return dummyHash;
}

async function consumeDummy(password: string): Promise<void> {
  try {
    await verify(await dummyPasswordHash(), password);
  } catch {
    // A rejected dummy compare must not reveal whether the user exists.
  }
}

export async function create(
  db: Database,
  masterKey: Buffer,
  input: { email: string; password: string },
): Promise<UserRecord> {
  const email = parseEmail(input.email);
  const password = requireUserPassword(input.password);
  const passwordHash = await hash(password, ARGON_OPTIONS);
  const id = randomUUID();
  const dataKey = generateDataKey();
  try {
    const wrapped = wrapDataKey(masterKey, id, dataKey);
    try {
      db.prepare(
        `INSERT INTO users (id, email, password_hash, wrapped_data_key, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(id, email, passwordHash, wrapped, new Date().toISOString());
    } catch (err) {
      if (isUniqueConstraint(err)) {
        throw new MailError("conflict", "An account with that email already exists");
      }
      throw err;
    }
    return { id, email };
  } finally {
    dataKey.fill(0);
  }
}

export async function verifyPassword(
  db: Database,
  input: { email: string; password: string },
): Promise<UserRecord | null> {
  const password = typeof input.password === "string" ? input.password : "";
  let email: string;
  try {
    email = parseEmail(input.email);
  } catch (err) {
    if (err instanceof MailError) {
      await consumeDummy(password);
      return null;
    }
    throw err;
  }
  const row = db.prepare("SELECT id, email, password_hash FROM users WHERE email = ?").get(email) as
    | { id: string; email: string; password_hash: string }
    | undefined;
  if (!row) {
    await consumeDummy(password);
    return null;
  }
  try {
    if (!(await verify(row.password_hash, password))) return null;
  } catch {
    return null;
  }
  return { id: row.id, email: row.email };
}
