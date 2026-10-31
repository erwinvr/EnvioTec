const DEFAULT_TIMEOUT_MS = 10000;

// Runs `handler` once on SIGTERM or SIGINT, then exits. If the handler takes
// longer than the timeout, the process exits with an error.
export function onShutdownSignal(logger, handler, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  let shuttingDown = false;

  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down');
    const timer = setTimeout(() => {
      logger.error('shutdown timed out');
      process.exit(1);
    }, timeoutMs);
    timer.unref();
    try {
      await handler();
      logger.info('shutdown complete');
      process.exit(0);
    } catch (error) {
      logger.error({ err: error }, 'shutdown failed');
      process.exit(1);
    }
  };

  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}
