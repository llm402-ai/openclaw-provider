/**
 * Dynamic model catalog for OpenClaw.
 * Fetches from llm402.ai/v1/models with 5-minute cache.
 * Falls back to empty list on failure (non-fatal).
 */

import type { ModelsResponse, ModelEntry } from './lib/index.js';
import { USER_AGENT } from './version.js';
import { readResponseCapped } from './util.js';

// Snapshot fetch to prevent monkey-patching by co-resident plugins
const secureFetch = globalThis.fetch;

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const FETCH_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 1_048_576; // 1MB

// Streaming-capped reader consolidated into ./util.ts (v0.4.0).

interface CatalogModel {
  id: string;
  name: string;
  object: string;
  created: number;
  owned_by: string;
}

export class ModelCatalog {
  private baseUrl: string;
  private cache: CatalogModel[] | null = null;
  private cacheExpiry = 0;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  /** Fetch models, using cache if fresh. */
  async getModels(): Promise<CatalogModel[]> {
    if (this.cache && Date.now() < this.cacheExpiry) {
      return this.cache;
    }

    try {
      const models = await this.fetchModels();
      this.cache = models;
      this.cacheExpiry = Date.now() + CACHE_TTL_MS;
      return models;
    } catch (err) {
      console.error(`[llm402-catalog] Failed to fetch models: ${err instanceof Error ? err.message : err}`);
      // Return stale cache if available, empty list otherwise
      return this.cache ?? [];
    }
  }

  /** Force refresh the cache. */
  async refresh(): Promise<CatalogModel[]> {
    this.cache = null;
    this.cacheExpiry = 0;
    return this.getModels();
  }

  private async fetchModels(): Promise<CatalogModel[]> {
    const url = `${this.baseUrl}/v1/models`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    try {
      const res = await secureFetch(url, {
        method: 'GET',
        headers: { 'User-Agent': USER_AGENT },
        signal: controller.signal,
      });

      if (!res.ok) {
        const errText = await readResponseCapped(res, MAX_RESPONSE_BYTES, 'Catalog response');
        throw new Error(`${res.status}: ${errText.slice(0, 200)}`);
      }

      // Stream with 1MB cap to prevent memory exhaustion from malicious upstream
      const text = await readResponseCapped(res, 1_048_576, 'Catalog response');
      const data = JSON.parse(text) as ModelsResponse;
      return data.data.map((m: ModelEntry) => ({
        id: m.id,
        name: formatModelName(m.id),
        object: m.object,
        created: m.created,
        owned_by: m.owned_by,
      }));
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw new Error('Model catalog fetch timed out');
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Convert model ID to human-readable name. */
function formatModelName(id: string): string {
  // "meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP8" → "Llama 4 Maverick 17B 128E Instruct FP8"
  const name = id.includes('/') ? id.split('/').pop()! : id;
  return name.replace(/-/g, ' ');
}
