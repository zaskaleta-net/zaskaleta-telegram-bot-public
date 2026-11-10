export async function retryHealthProbe({
  requestJson,
  url,
  expectedVersionId = null,
  headers = undefined,
  attempts = 12,
  delayMs = 1000,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  if (typeof requestJson !== 'function') throw new TypeError('requestJson must be a function');
  if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > 60) throw new RangeError('attempts out of range');
  if (!Number.isFinite(delayMs) || delayMs < 0 || delayMs > 30000) throw new RangeError('delayMs out of range');

  let health = null;
  let lastError = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      health = await requestJson(url, headers ? { headers } : {});
      lastError = null;
      if (
        health?.status === 200 &&
        health?.body?.ok === true &&
        health?.body?.delivery === true &&
        (expectedVersionId === null || health?.body?.versionId === expectedVersionId)
      ) {
        return { health, lastError:null, attempt };
      }
    } catch (error) {
      lastError = error;
    }

    if (attempt < attempts) await sleep(delayMs);
  }

  return { health, lastError, attempt:attempts };
}
