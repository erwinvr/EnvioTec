const CHECK_TIMEOUT_MS = 2000;

// `checks` maps a dependency name to an async function that rejects when the
// dependency is unavailable.
export function createHealthService({ checks, logger, timeoutMs = CHECK_TIMEOUT_MS }) {
  return {
    async readiness() {
      const results = await Promise.all(
        Object.entries(checks).map(async ([name, check]) => {
          try {
            await withTimeout(check(), timeoutMs);
            return [name, true];
          } catch (error) {
            logger.warn({ dependency: name, errorMessage: error.message }, 'readiness check failed');
            return [name, false];
          }
        }),
      );
      return { ready: results.every(([, up]) => up) };
    },
  };
}

function withTimeout(promise, timeoutMs) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timeout after ${timeoutMs} ms`)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
