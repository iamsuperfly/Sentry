export function createInFlightGuard() {
  let inFlight = false;

  return async function runIfIdle(
    task: () => Promise<void>,
  ): Promise<boolean> {
    if (inFlight) return false;
    inFlight = true;
    try {
      await task();
      return true;
    } finally {
      inFlight = false;
    }
  };
}