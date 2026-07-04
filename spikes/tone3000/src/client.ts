/**
 * ============================================================================
 * TONE3000 SPIKE — API client (Bearer)
 * ----------------------------------------------------------------------------
 * PLAIN LANGUAGE: once we have an access_token, this is a thin wrapper over the
 * TONE3000 endpoints we actually need for the NAM A2 flow: look up a tone, list
 * its models, and download a model file. Modelled on the reference client
 * github.com/tone-3000/t3k-api (src/tone3000-client.ts).
 *
 * GROUNDED IN: TONE3000 API docs, verified 2026-07-01:
 *   GET /tones/{id}?architecture=      → tone (a1/a2/custom_models_count, ...)
 *   GET /models?tone_id=&architecture= → list models
 *   GET /models/{id}                   → a model (has model_url, architecture_version)
 *   model_url = pre-built download URL; fetching it needs the Bearer token.
 *   architecture=2 ⇒ A2. Omit ⇒ legacy A1 + Custom (EXCLUDES A2).
 *   Rate limit: 100 req/min.
 *
 * OFF-RIG SAFETY: every method hits the real API, so needs a real token — see
 * README "to run for real". Shapes are typed loosely (Record) where the exact
 * JSON is not needed for the spike's goal (fetch one A2 model).
 * ============================================================================
 */

import { TONE3000 } from './oauth.ts';

export const ARCHITECTURE_A2 = 2 as const;

export interface T3KModel {
  id: number;
  /** pre-built download URL; GET it with the Bearer token to get the file. */
  model_url?: string;
  architecture_version?: number;
  name?: string;
  [k: string]: unknown;
}

export interface T3KTone {
  id: number;
  name?: string;
  a1_models_count?: number;
  a2_models_count?: number;
  custom_models_count?: number;
  [k: string]: unknown;
}

export class T3KClient {
  private readonly accessToken: string;
  private readonly base: string;

  constructor(accessToken: string, base: string = TONE3000.base) {
    this.accessToken = accessToken;
    this.base = base;
  }

  private headers(): Record<string, string> {
    return { authorization: `Bearer ${this.accessToken}`, accept: 'application/json' };
  }

  /** GET /tones/{id}?architecture=2 — tone metadata for the A2 view. */
  async getTone(id: number, architecture: number = ARCHITECTURE_A2): Promise<T3KTone> {
    const url = `${this.base}/tones/${id}?architecture=${architecture}`;
    const res = await fetch(url, { headers: this.headers() });
    if (!res.ok) throw new Error(`getTone ${id} failed: ${res.status}`);
    return (await res.json()) as T3KTone;
  }

  /** GET /models?tone_id=&architecture=2 — the A2 models under a tone. */
  async listModels(toneId: number, architecture: number = ARCHITECTURE_A2): Promise<T3KModel[]> {
    const url = `${this.base}/models?tone_id=${toneId}&architecture=${architecture}`;
    const res = await fetch(url, { headers: this.headers() });
    if (!res.ok) throw new Error(`listModels tone=${toneId} failed: ${res.status}`);
    const json = (await res.json()) as unknown;
    // Docs return either an array or a {data:[...]} envelope depending on endpoint;
    // handle both so the spike is robust.
    if (Array.isArray(json)) return json as T3KModel[];
    const data = (json as { data?: unknown }).data;
    return Array.isArray(data) ? (data as T3KModel[]) : [];
  }

  /** GET /models/{id} — single model (to get a fresh model_url). */
  async getModel(id: number): Promise<T3KModel> {
    const res = await fetch(`${this.base}/models/${id}`, { headers: this.headers() });
    if (!res.ok) throw new Error(`getModel ${id} failed: ${res.status}`);
    return (await res.json()) as T3KModel;
  }

  /**
   * Download a model's file bytes from its model_url (Bearer-protected).
   * Returns the raw bytes so the caller can save a .nam/.aidax/etc. The A2 file
   * is what the amp device loads on the rig.
   */
  async downloadModel(model: T3KModel): Promise<Uint8Array> {
    if (!model.model_url) throw new Error(`model ${model.id} has no model_url`);
    const res = await fetch(model.model_url, { headers: this.headers() });
    if (!res.ok) throw new Error(`downloadModel ${model.id} failed: ${res.status}`);
    const buf = await res.arrayBuffer();
    return new Uint8Array(buf);
  }
}
