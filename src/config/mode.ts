import type { OpenMailMode } from "./schema.js";

/**
 * `OPENMAIL_MODE` wins when it is set. Otherwise the config file's mode is used.
 * Both absent means multi-user.
 */
export function resolveOpenMailMode(
  env: { OPENMAIL_MODE?: string },
  configMode?: OpenMailMode,
): OpenMailMode {
  const raw = env.OPENMAIL_MODE;
  if (raw === undefined || raw.trim() === "") return configMode ?? "multi";
  const mode = raw.trim().toLowerCase();
  if (mode === "single" || mode === "multi") return mode;
  throw new Error('OPENMAIL_MODE must be "single" or "multi"');
}
