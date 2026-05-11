// Shared retry helper for the sync scripts.
//
// The IBB Open Data Portal is reliably flaky — TCP connections drop mid-
// response on the larger files (stop_times.zip, route shapes, GTFS CSVs).
// A single retry-with-exponential-backoff round saves ~one in every couple
// of deploys from failing.

export async function withRetry(
  fn,
  { attempts = 3, baseDelayMs = 2000, label = "fetch" } = {}
) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i === attempts - 1) break;
      const delay = baseDelayMs * 2 ** i;
      console.warn(
        `  ${label} failed (attempt ${i + 1}/${attempts}): ${err.message} — retrying in ${Math.round(delay / 1000)}s`
      );
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}
