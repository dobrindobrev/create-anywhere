import { getLogger } from "./logger.js";

const log = getLogger("retry");

export interface RetryOptions {
  maxAttempts?: number;
  delayMs?: number;
  backoffMultiplier?: number;
  retryIf?: (err: unknown) => boolean;
}

/**
 * Retry a function with exponential backoff.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: RetryOptions = {}
): Promise<T> {
  const {
    maxAttempts = 3,
    delayMs = 1000,
    backoffMultiplier = 2,
    retryIf = () => true,
  } = opts;

  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt === maxAttempts || !retryIf(err)) {
        throw err;
      }
      const wait = delayMs * Math.pow(backoffMultiplier, attempt - 1);
      log.warn({ attempt, maxAttempts, wait, err }, "Retrying after error");
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw lastError;
}
