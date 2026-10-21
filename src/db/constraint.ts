export function isUniqueConstraint(err: unknown): boolean {
  return err instanceof Error && "code" in err && err.code === "SQLITE_CONSTRAINT_UNIQUE";
}
