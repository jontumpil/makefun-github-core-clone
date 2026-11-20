// Entry lifecycle for the core-clone forge.
//
// The harness owns this process's lifetime, and the contract is small:
//   - MAKEFUN_ENV_URL points at the env service. If it is missing there is
//     nothing to register with, so we exit 1 immediately.
//   - We start the forge on an ephemeral port (listen(0)) and POST that port
//     to the env's /register. The first registration wins: a 409 means some
//     other process registered first and is not ours to fix, while 400/405
//     are contract errors and fatal. Anything else (env still starting,
//     network hiccup) is retried with backoff.
//   - Then we poll GET /done until the env answers {"done": true}, close
//     the server and exit 0. We never exit early: the env writes the export
//     the scorer reads only after this process finishes cleanly.
//
// All of the actual forge behaviour lives behind createApp() in app.ts;
// this file is only the handshake around it.

import { createApp } from './app.ts';

const envUrl = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
if (envUrl === '') {
  process.stderr.write('[entry] MAKEFUN_ENV_URL is not set; nowhere to register\n');
  process.exit(1);
}

const REQUEST_TIMEOUT_MS = 30_000; // one env call may hang at most this long
const BACKOFF_START_MS = 250;
const BACKOFF_CAP_MS = 2_000;

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Exponential backoff: 250ms, 500ms, 1s, then capped at 2s. */
function backoffMs(attempt: number): number {
  return Math.min(BACKOFF_CAP_MS, BACKOFF_START_MS * 2 ** Math.min(attempt, 8));
}

/** Tell the env which port we bound; retry transient failures forever. */
async function announce(port: number): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const res = await fetch(`${envUrl}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (res.status === 200 || res.status === 409) return;
      if (res.status === 400 || res.status === 405) {
        throw new Error(`register refused with HTTP ${res.status}: ${await res.text()}`);
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('register refused')) throw err;
      // Network error or unexpected status: the env may still be booting.
    }
    await pause(backoffMs(attempt));
  }
}

/** Poll the env until it reports the trial is over. */
async function awaitDone(): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const res = await fetch(`${envUrl}/done`, {
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (res.ok) {
        const body = (await res.json()) as { done?: unknown };
        if (body.done === true) return;
      }
    } catch {
      // Not answering yet means not done; keep polling.
    }
    await pause(backoffMs(attempt));
  }
}

const server = createApp();
await new Promise<void>((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, () => resolve());
});
const bound = server.address();
if (bound === null || typeof bound === 'string') {
  process.stderr.write('[entry] server did not bind an ephemeral TCP port\n');
  process.exit(1);
}
process.stdout.write(`[entry] listening on port ${bound.port}\n`);

try {
  await announce(bound.port);
  process.stdout.write('[entry] registered; waiting for done\n');
  await awaitDone();
  server.close();
  process.stdout.write('[entry] done\n');
  process.exit(0);
} catch (err) {
  process.stderr.write(`[entry] ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
