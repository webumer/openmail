declare module "better-sqlite3" {
  type SqlValue = string | number | bigint | Buffer | null;

  interface Statement<T = unknown> {
    get(...params: SqlValue[]): T | undefined;
    all(...params: SqlValue[]): T[];
    run(...params: SqlValue[]): { changes: number; lastInsertRowid: number | bigint };
  }

  class Database {
    constructor(filename: string);
    prepare<T = unknown>(sql: string): Statement<T>;
    exec(sql: string): this;
    transaction<T>(fn: () => T): () => T;
    pragma(source: string, options?: { simple?: boolean }): unknown;
    close(): this;
  }

  export default Database;
}
