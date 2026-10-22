const tails = new Map<string, Promise<void>>();

/** One send at a time per user, so two calls cannot both pass the rate-limit check. */
export function withUserSendLock<T>(userId: string, fn: () => Promise<T>): Promise<T> {
  const previous = tails.get(userId) ?? Promise.resolve();
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => gate);
  tails.set(userId, tail);
  return previous.then(fn, fn).finally(() => {
    release();
    if (tails.get(userId) === tail) tails.delete(userId);
  });
}
