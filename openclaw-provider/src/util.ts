/**
 * Internal utilities for @llm402/openclaw-provider — not exported from the
 * package barrel. Helpers consolidated from catalog.ts and proxy.ts during
 * v0.4.0. Pure I/O plumbing — no security decisions are made here.
 */

/**
 * Response-prefix literal union (closed set). `prefix` is typed as a
 * literal union so callers can't pass attacker-controlled strings into
 * the `throw new Error(...)` message. Every site that needs a new
 * prefix must extend this union explicitly; opens review on the
 * extension, not on every call.
 */
export type ResponsePrefix = 'Catalog response' | 'Response body';

/**
 * Read a fetch Response body with a streaming byte cap. Throws if the cap
 * is exceeded. `prefix` labels the error and MUST be one of the literals
 * in {@link ResponsePrefix}.
 *
 * DoS-protection invariant: body reads MUST honor the cap to avoid
 * unbounded memory on hostile upstream responses. Callers supply
 * `maxBytes` appropriate to their expected payload size.
 *
 * Behavior-equivalent to the prior `readCatalogResponse`
 * (`Catalog response`-prefixed) in catalog.ts and the prior
 * `readResponseCapped` (`Response body`-prefixed) in proxy.ts.
 */
export async function readResponseCapped(
  res: Response,
  maxBytes: number,
  prefix: ResponsePrefix,
): Promise<string> {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > maxBytes) {
        reader.cancel();
        throw new Error(`${prefix} exceeds ${maxBytes} byte limit`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const decoder = new TextDecoder();
  return chunks.map((c) => decoder.decode(c, { stream: true })).join('') + decoder.decode();
}
