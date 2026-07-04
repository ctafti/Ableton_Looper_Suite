/**
 * ============================================================================
 * TONE3000 SPIKE — fetch ONE A2 model, end to end  (the deliverable-D goal)
 * ----------------------------------------------------------------------------
 * PLAIN LANGUAGE: prove the whole path works — authenticate, find an A2 tone,
 * list its A2 models, download one model file, save it to disk. If this runs
 * green with real creds, the `load_tone` tool (Contract 4) has a proven fetch
 * path; only "hand the file to the amp device" remains a rig step.
 *
 * FLOW:
 *   1) get an access token — either from env (T3K_ACCESS_TOKEN, e.g. captured
 *      by headless-lan-flow) or by running the headless flow if T3K_CLIENT_ID
 *      is set. Off-rig with no creds → STUB mode: prints the plan and exits 0.
 *   2) resolve a tone id — env T3K_TONE_ID, else a search (documented) — for the
 *      spike we take an explicit tone id to keep it deterministic.
 *   3) getTone(id, architecture=2) → listModels(tone_id, architecture=2).
 *   4) pick the first A2 model, downloadModel() → write ./out/<id>.model.
 *
 * GROUNDED IN: TONE3000 API docs (architecture=2 ⇒ A2; model_url needs Bearer).
 * See README "to run for real".
 * ============================================================================
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { T3KClient, ARCHITECTURE_A2, type T3KModel } from './client.ts';
import { runHeadlessFlow } from './headless-lan-flow.ts';

async function resolveAccessToken(): Promise<string | null> {
  if (process.env.T3K_ACCESS_TOKEN) return process.env.T3K_ACCESS_TOKEN;
  if (process.env.T3K_CLIENT_ID) {
    console.log('No T3K_ACCESS_TOKEN — running the headless flow to get one…');
    const r = await runHeadlessFlow({ clientId: process.env.T3K_CLIENT_ID, architecture: ARCHITECTURE_A2 });
    return r.tokens.access_token;
  }
  return null;
}

async function main(): Promise<void> {
  const token = await resolveAccessToken();
  const toneIdEnv = process.env.T3K_TONE_ID;

  if (!token || !toneIdEnv) {
    console.log('──────────────────────────────────────────────────────────────');
    console.log('[STUB] Missing creds — not calling the real API.');
    console.log('[STUB] This spike WOULD, with a real token + tone id:');
    console.log('[STUB]   1. GET /tones/<id>?architecture=2');
    console.log('[STUB]   2. GET /models?tone_id=<id>&architecture=2');
    console.log('[STUB]   3. pick the first A2 model, GET its model_url (Bearer)');
    console.log('[STUB]   4. save bytes to ./out/<modelId>.model');
    console.log('[STUB] To run for real, set:');
    console.log('[STUB]   T3K_ACCESS_TOKEN=<token>   (or T3K_CLIENT_ID to log in)');
    console.log('[STUB]   T3K_TONE_ID=<an A2 tone id>');
    console.log('──────────────────────────────────────────────────────────────');
    process.exit(0);
  }

  const toneId = Number(toneIdEnv);
  const client = new T3KClient(token);

  console.log(`getTone(${toneId}, architecture=2)…`);
  const tone = await client.getTone(toneId, ARCHITECTURE_A2);
  console.log(`  tone: ${tone.name ?? tone.id}  (a2_models_count=${tone.a2_models_count ?? '?'})`);

  console.log(`listModels(tone_id=${toneId}, architecture=2)…`);
  const models: T3KModel[] = await client.listModels(toneId, ARCHITECTURE_A2);
  const a2 = models.find((m) => (m.architecture_version ?? 2) === 2) ?? models[0];
  if (!a2) throw new Error('no A2 models found for this tone');
  console.log(`  picked model id=${a2.id} (${a2.name ?? 'unnamed'})`);

  // Refresh model_url if the list didn't include it.
  const full = a2.model_url ? a2 : await client.getModel(a2.id);
  console.log('downloading model file…');
  const bytes = await client.downloadModel(full);

  const outDir = join(process.cwd(), 'out');
  await mkdir(outDir, { recursive: true });
  const outPath = join(outDir, `${full.id}.model`);
  await writeFile(outPath, bytes);
  console.log(`✓ saved ${bytes.byteLength} bytes → ${outPath}`);
  console.log('✓ A2 fetch path proven end-to-end. load_tone (Contract 4) is grounded.');
}

main().catch((e) => {
  console.error('spike failed:', e);
  process.exit(1);
});
