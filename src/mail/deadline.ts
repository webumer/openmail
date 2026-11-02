import { imapTimeoutFromEnv } from "../config/runtime.js";

export interface Deadline {
  expired(): boolean;
  warning: string;
}

export interface DeadlineOptions { timeoutMs?: number; now?: () => number }

export function createDeadline(options: DeadlineOptions = {}): Deadline {
  const timeoutMs = options.timeoutMs ?? imapTimeoutFromEnv();
  const now = options.now ?? (() => performance.now());
  const end = now() + timeoutMs;
  return {
    expired: () => now() >= end,
    warning: `The mail server was slow; results stopped after ${timeoutMs / 1_000} seconds. Narrow the search with since/before, a folder, or a sender.`,
  };
}
