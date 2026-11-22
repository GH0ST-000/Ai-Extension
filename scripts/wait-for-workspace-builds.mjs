#!/usr/bin/env node
/**
 * Dev-only: wait until the workspace packages the API imports have finished emitting.
 *
 * `pnpm dev` starts every package's `tsc --watch` and the API at the same time. A watcher
 * re-emits its whole `dist` on start, and a file that is being rewritten is briefly empty: if
 * the API compiles in that instant it fails with "dist/index.d.ts is not a module" and exits.
 *
 * This waits until every declaration file exists, is non-empty, and has not changed for a
 * short quiet period — after giving the watchers a moment to begin. Run alone (no watchers),
 * it adds about three seconds. It never fails the start: after a generous timeout it lets the
 * build run and report its own errors.
 */
import { statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FILES = ['types', 'shared', 'config'].map((name) =>
  resolve(root, 'packages', name, 'dist', 'index.d.ts'),
);
const POLL_MS = 200;
const MIN_WAIT_MS = 2_500; // let the watchers start their first emit
const QUIET_MS = 2_000; // no file may have changed for this long
const TIMEOUT_MS = 90_000;

const snapshot = () =>
  FILES.map((file) => {
    try {
      const stat = statSync(file);
      return `${stat.size}:${stat.mtimeMs}`;
    } catch {
      return 'missing';
    }
  });
const ready = (state) => state.every((entry) => entry !== 'missing' && !entry.startsWith('0:'));
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

const started = Date.now();
let previous = snapshot();
let lastChange = started;
for (;;) {
  await sleep(POLL_MS);
  const current = snapshot();
  const now = Date.now();
  if (current.join('|') !== previous.join('|')) {
    previous = current;
    lastChange = now;
  }
  if (ready(current) && now - started >= MIN_WAIT_MS && now - lastChange >= QUIET_MS) break;
  if (now - started >= TIMEOUT_MS) {
    console.warn('[dev] workspace packages did not settle in time; starting anyway.');
    break;
  }
}
