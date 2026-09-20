import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createComputerUseCacheServer, configFromEnv } from '../src/server.mjs';

const dir = await mkdtemp(path.join(tmpdir(), 'jev-test-'));
let judgeCalls = 0, generationCalls = 0;
let decision = { type: 'choice', choice: 'candidate_0', confidence: 1 };
let fail = false;
const upstream = http.createServer(async (req, res) => {
  let raw = ''; for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw);
  res.setHeader('content-type', 'application/json');
  if (req.url === '/systemone') {
    judgeCalls++;
    assert.equal(req.headers.authorization, 'Bearer judge-secret');
    assert.equal(body.model, 'jev-latest');
    assert.ok(body.questions.reuse.criteria.none);
    assert.ok(!raw.includes('generation-secret'));
    if (fail) { res.writeHead(503); res.end('{}'); return; }
    res.end(JSON.stringify({ answers: { reuse: decision } }));
  } else {
    generationCalls++;
    assert.notEqual(req.headers.authorization, 'Bearer judge-secret');
    assert.equal(body.credential_scope, undefined);
    res.end(JSON.stringify({ model: body.model, choices: [{ message: { content: `result-${generationCalls}` } }] }));
  }
});
await new Promise(r => upstream.listen(0, '127.0.0.1', r));
const provider = `http://127.0.0.1:${upstream.address().port}`;
const server = createComputerUseCacheServer({ cacheDir: dir, upstreamBaseUrl: provider,
  upstreamApiKey: '', typesafeBaseUrl: provider, typesafeApiKey: 'judge-secret' });
await new Promise(r => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/v1/chat/completions`;
async function ask(text, extra = {}, key = 'generation-secret') {
  const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({ model: 'test-model', messages: [{ role: 'user', content: text }], ...extra }) });
  return { response, body: await response.json() };
}
try {
  assert.equal(configFromEnv({ typesafeApiKey: 'custom' }).typesafeApiKey, 'custom');
  assert.equal((await ask('first')).response.headers.get('x-computer-use-cache'), 'MISS');
  assert.equal((await ask('first')).response.headers.get('x-computer-use-cache-match'), 'exact');
  assert.equal(judgeCalls, 0);
  const hit = await ask('paraphrase');
  assert.equal(hit.response.headers.get('x-computer-use-cache-match'), 'jev');
  assert.equal(hit.body.choices[0].message.content, 'result-1');
  assert.equal(generationCalls, 1);
  for (const value of [
    { type: 'choice', choice: 'none', confidence: 1 },
    { type: 'choice', choice: 'candidate_0', confidence: 0.2 },
    { type: 'choice', choice: 'candidate_900', confidence: 1 },
    { type: 'choice', choice: 'candidate_0', confidence: '1' },
  ]) {
    decision = value;
    assert.equal((await ask(JSON.stringify(value))).response.headers.get('x-computer-use-cache'), 'MISS');
  }
  fail = true;
  assert.equal((await ask('provider failed')).response.headers.get('x-computer-use-cache'), 'MISS');
  fail = false;
  decision = { type: 'choice', choice: 'candidate_0', confidence: 1 };
  const count = judgeCalls;
  assert.equal((await ask('bypass', { cache: false })).response.headers.get('x-computer-use-cache'), 'BYPASS');
  assert.equal((await ask('other tenant', {}, 'other-key')).response.headers.get('x-computer-use-cache'), 'MISS');
  assert.equal(judgeCalls, count);
  for (const filename of await readdir(path.join(dir, 'entries'))) {
    const raw = await readFile(path.join(dir, 'entries', filename), 'utf8');
    assert.ok(!raw.includes('judge-secret') && !raw.includes('generation-secret'));
  }
  console.log('JEV integration: reuse, exact, rejection, malformed answer, outage, bypass, credential isolation passed');
} finally {
  await new Promise(r => server.close(r));
  await new Promise(r => upstream.close(r));
  await rm(dir, { recursive: true, force: true });
}
