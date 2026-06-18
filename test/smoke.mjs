import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createComputerUseCacheServer } from '../src/server.mjs';
import {
  computerUseCacheBaseURL,
  createComputerUseCacheClient,
  openAIConfig
} from '../src/client.mjs';

const cacheDir = await mkdtemp(path.join(tmpdir(), 'computer-use-cache-'));
const server = createComputerUseCacheServer({
  host: '127.0.0.1',
  port: 0,
  cacheDir,
  adminToken: 'test-admin-token'
});

try {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const baseURL = `http://127.0.0.1:${port}`;

  assert.equal(computerUseCacheBaseURL({ port }), `${baseURL}/v1`);
  assert.deepEqual(openAIConfig({ port, apiKey: 'test-key' }), {
    baseURL: `${baseURL}/v1`,
    apiKey: 'test-key'
  });

  const root = await fetch(`${baseURL}/`).then((response) => response.json());
  assert.equal(root.name, 'computer-use-cache');
  assert.equal(root.status, 'ok');
  assert.ok(root.endpoints.includes('/v1/chat/completions'));

  const health = await fetch(`${baseURL}/healthz`).then((response) => response.json());
  assert.equal(health.ok, true);
  assert.equal(health.cache.entries, 0);

  const stats = await fetch(`${baseURL}/cache/stats`).then((response) => response.json());
  assert.equal(stats.entries, 0);
  assert.equal(stats.cache_dir, cacheDir);

  const unauthorizedClear = await fetch(`${baseURL}/cache/clear`, { method: 'POST' });
  assert.equal(unauthorizedClear.status, 401);

  const clear = await fetch(`${baseURL}/cache/clear`, {
    method: 'POST',
    headers: { 'x-cache-admin-token': 'test-admin-token' }
  }).then((response) => response.json());
  assert.equal(clear.ok, true);
  assert.equal(clear.deleted, 0);

  const client = createComputerUseCacheClient({ baseURL: `${baseURL}/v1`, apiKey: 'test-key' });
  assert.equal(client.baseURL, `${baseURL}/v1`);
} finally {
  await new Promise((resolve) => server.close(resolve));
  await rm(cacheDir, { recursive: true, force: true });
}
