import { readFileSync } from "node:fs";
import { parse } from "smol-toml";
import { MailError, errorText } from "../errors.js";
import { parseConfig, type AppConfig } from "./schema.js";

export function loadConfig(filePath: string): AppConfig {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch (err) {
    throw new MailError("config_error", `Cannot read config file: ${errorText(err)}`);
  }
  let parsed: unknown;
  try {
    parsed = parse(raw);
  } catch (err) {
    throw new MailError("config_error", `Invalid TOML: ${errorText(err)}`);
  }
  try {
    return parseConfig(parsed);
  } catch (err) {
    if (err instanceof MailError) throw err;
    throw new MailError("config_error", errorText(err));
  }
}
