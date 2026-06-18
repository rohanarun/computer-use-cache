import http from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FALSE_VALUES = new Set(['0', 'false', 'no', 'off']);
const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on']);
const CACHE_CONTROL_KEYS = new Set(['stream', 'cache', 'cache_control']);
const DEFAULT_CACHE_IGNORE_KEYS = new Set(['metadata']);
const SENSITIVE_PATTERN = /(?:api[_-]?key|secret|password|passwd|access[_-]?token|refresh[_-]?token|private[_-]?key)\s*[:=]\s*['"]?[^'"\s]{8,}/i;

function boolFromValue(value, fallback = false) {
  if (typeof value === 'boolean') return value;
  if (value === undefined || value === null || value === '') return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (TRUE_VALUES.has(normalized)) return true;
  if (FALSE_VALUES.has(normalized)) return false;
  return fallback;
}

function intFromValue(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function floatFromValue(value, fallback) {
  const parsed = Number.parseFloat(String(value ?? ''));
  return Number.isFinite(parsed) ? parsed : fallback;
}

function listFromValue(value) {
  return String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function globToRegExp(glob) {
  const escaped = String(glob || '').replace(/[.+^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${escaped.replace(/\*/g, '.*').replace(/\?/g, '.')}$`);
}

function matchesAny(value, patterns) {
  if (!patterns.length) return false;
  return patterns.some((pattern) => globToRegExp(pattern).test(String(value || '').trim()));
}

function compactJson(value) {
  return JSON.stringify(value);
}

function stableNormalize(value, stringLimit) {
  if (value === null || ['boolean', 'number'].includes(typeof value)) return value;
  if (typeof value === 'string') return value.length > stringLimit ? value.slice(0, stringLimit) : value;
  if (Array.isArray(value)) return value.map((item) => stableNormalize(item, stringLimit));
  if (typeof value === 'object') {
    const output = {};
    for (const key of Object.keys(value).sort()) {
      output[String(key)] = stableNormalize(value[key], stringLimit);
    }
    return output;
  }
  return String(value);
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function safeHeaderValue(value) {
  return String(value || '').replace(/[\r\n]/g, ' ').slice(0, 1024);
}

function responseHeaders(extra = {}) {
  return {
    'access-control-allow-origin': process.env.CORS_ALLOW_ORIGIN || '*',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'Authorization, Content-Type, X-Cache-Bypass, X-Cache-Admin-Token',
    ...extra
  };
}

function sendJson(res, status, payload, headers = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, responseHeaders({
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    ...headers
  }));
  res.end(body);
}

function openAiError(message, status = 400, type = 'invalid_request_error', code = null) {
  return {
    status,
    body: {
      error: {
        message,
        type,
        param: null,
        code
      }
    }
  };
}

async function readRequestBody(req, maxBytes) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) {
      throw Object.assign(new Error('Request body is too large.'), { status: 413 });
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function bearerFromHeaders(headers) {
  const value = headers.authorization || headers.Authorization || '';
  const text = Array.isArray(value) ? value[0] : value;
  return String(text || '').toLowerCase().startsWith('bearer ') ? String(text).slice(7).trim() : '';
}

function upstreamHeaders(req, config) {
  const token = config.upstreamApiKey || bearerFromHeaders(req.headers);
  const headers = {
    accept: 'application/json',
    'content-type': 'application/json'
  };
  if (token) headers.authorization = `Bearer ${token}`;
  const referer = process.env.OPENROUTER_HTTP_REFERER || req.headers['http-referer'];
  const title = process.env.OPENROUTER_X_TITLE || req.headers['x-title'];
  if (referer) headers['HTTP-Referer'] = String(referer);
  if (title) headers['X-Title'] = String(title);
  return headers;
}

function requestCacheEnabled(data, fallback) {
  if (Object.prototype.hasOwnProperty.call(data, 'cache')) return boolFromValue(data.cache, fallback);
  if (data.cache_control && typeof data.cache_control === 'object' && Object.prototype.hasOwnProperty.call(data.cache_control, 'enabled')) {
    return boolFromValue(data.cache_control.enabled, fallback);
  }
  if (data.metadata && typeof data.metadata === 'object') {
    if (Object.prototype.hasOwnProperty.call(data.metadata, 'cache')) return boolFromValue(data.metadata.cache, fallback);
    if (Object.prototype.hasOwnProperty.call(data.metadata, 'cache_enabled')) return boolFromValue(data.metadata.cache_enabled, fallback);
  }
  return fallback;
}

function normalizedCacheInput(data, mode, config) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return { reason: 'request body must be an object' };
  const model = String(data.model || '').trim();
  if (!model) return { reason: 'model is required' };
  if (matchesAny(model, config.modelDenylist)) return { reason: `model is not cacheable: ${model}` };
  if (config.modelAllowlist.length && !matchesAny(model, config.modelAllowlist)) return { reason: `model is not cacheable: ${model}` };

  const ignored = new Set([...CACHE_CONTROL_KEYS, ...config.cacheIgnoreKeys]);
  const payload = { mode };
  for (const key of Object.keys(data).sort()) {
    if (ignored.has(String(key))) continue;
    payload[String(key)] = stableNormalize(data[key], config.maxInputChars);
  }
  const json = compactJson(payload);
  if (json.length > config.maxInputChars) return { reason: 'request is too large for cache' };
  if (SENSITIVE_PATTERN.test(json)) return { reason: 'request appears to contain credentials or secrets' };
  const cacheKey = createHash('sha256').update(json).digest('hex');
  return { cacheKey, requestPayload: { ...payload, cache_key: cacheKey } };
}

function completionText(payload) {
  const choices = Array.isArray(payload?.choices) ? payload.choices : [];
  const first = choices[0] && typeof choices[0] === 'object' ? choices[0] : {};
  if (typeof first.text === 'string') return first.text;
  const message = first.message && typeof first.message === 'object' ? first.message : {};
  const content = message.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (part && typeof part === 'object') return part.text || part.content || '';
      return '';
    }).join('');
  }
  return '';
}

function withCacheMetadata(payload, config, cacheHit, cacheKey, storeStatus = '', bypassReason = '') {
  const cloned = cloneJson(payload);
  if (config.includeCacheMetadata && cloned && typeof cloned === 'object') {
    cloned.computer_use_cache = {
      cache_hit: Boolean(cacheHit),
      cache_key: cacheKey || null,
      store_status: storeStatus || null,
      bypass_reason: bypassReason || null
    };
  }
  return cloned;
}

function cacheHeaders(status, cacheKey, storeStatus = '', reason = '') {
  return {
    'x-computer-use-cache': status,
    'x-computer-use-cache-key': cacheKey || '',
    'x-computer-use-cache-store': storeStatus || '',
    'x-computer-use-cache-reason': reason || '',
    'x-code-model-cache': status,
    'x-code-model-cache-key': cacheKey || '',
    'x-code-model-cache-store': storeStatus || ''
  };
}

function sse(payload) {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function cachedStreamChunks(payload, mode) {
  const id = String(payload.id || `chatcmpl-cache-${randomUUID().replace(/-/g, '').slice(0, 16)}`);
  const created = Number(payload.created || Math.floor(Date.now() / 1000));
  const model = String(payload.model || '');
  const text = completionText(payload);
  const first = Array.isArray(payload.choices) && payload.choices[0] && typeof payload.choices[0] === 'object' ? payload.choices[0] : {};
  const finishReason = first.finish_reason || 'stop';
  if (mode === 'completion') {
    return [
      sse({ id, object: 'text_completion', created, model, choices: [{ index: 0, text, finish_reason: null }] }),
      sse({ id, object: 'text_completion', created, model, choices: [{ index: 0, text: '', finish_reason: finishReason }] }),
      'data: [DONE]\n\n'
    ];
  }
  return [
    sse({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }] }),
    sse({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: {}, finish_reason: finishReason }] }),
    'data: [DONE]\n\n'
  ];
}

class FileCompletionCache {
  constructor(config) {
    this.config = config;
    this.entriesDir = path.join(config.cacheDir, 'entries');
  }

  async ensure() {
    await mkdir(this.entriesDir, { recursive: true });
  }

  entryPath(cacheKey) {
    return path.join(this.entriesDir, `${cacheKey}.json`);
  }

  async lookup(cacheKey) {
    if (!cacheKey) return null;
    await this.ensure();
    const target = this.entryPath(cacheKey);
    try {
      const raw = await readFile(target, 'utf8');
      const entry = JSON.parse(raw);
      const now = Date.now() / 1000;
      if (this.config.ttlSeconds > 0 && now - Number(entry.created_at || 0) > this.config.ttlSeconds) {
        await rm(target, { force: true });
        return null;
      }
      entry.hits = Number(entry.hits || 0) + 1;
      entry.last_hit_at = now;
      await writeFile(target, JSON.stringify(entry), 'utf8');
      return entry;
    } catch {
      return null;
    }
  }

  async store(cacheKey, mode, requestPayload, responsePayload) {
    if (!responsePayload || typeof responsePayload !== 'object' || Array.isArray(responsePayload)) return 'skipped: response is not a JSON object';
    const cloned = cloneJson(responsePayload);
    delete cloned.computer_use_cache;
    delete cloned.code_model_cache;
    const responseJson = compactJson(cloned);
    if (responseJson.length > this.config.maxResponseChars) return 'skipped: response is too large for cache';
    await this.ensure();
    const now = Date.now() / 1000;
    const target = this.entryPath(cacheKey);
    let previous = {};
    try {
      previous = JSON.parse(await readFile(target, 'utf8'));
    } catch {
      previous = {};
    }
    const entry = {
      cache_key: cacheKey,
      mode,
      model: String(requestPayload.model || cloned.model || ''),
      request: requestPayload,
      response: cloned,
      created_at: Number(previous.created_at || now),
      updated_at: now,
      last_hit_at: previous.last_hit_at || null,
      hits: Number(previous.hits || 0)
    };
    await writeFile(target, JSON.stringify(entry), 'utf8');
    return previous.cache_key ? 'updated' : 'stored';
  }

  async stats() {
    await this.ensure();
    const files = await readdir(this.entriesDir).catch(() => []);
    let hits = 0;
    let lastUpdated = null;
    let bytes = 0;
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      const target = path.join(this.entriesDir, file);
      try {
        const info = await stat(target);
        bytes += info.size;
        const entry = JSON.parse(await readFile(target, 'utf8'));
        hits += Number(entry.hits || 0);
        const updated = Number(entry.updated_at || 0);
        if (updated && (!lastUpdated || updated > lastUpdated)) lastUpdated = updated;
      } catch {
        // Ignore corrupt cache entries. They can be deleted with cache clear.
      }
    }
    return {
      entries: files.filter((file) => file.endsWith('.json')).length,
      hits,
      last_updated_at: lastUpdated,
      cache_dir: this.config.cacheDir,
      ttl_seconds: this.config.ttlSeconds,
      bytes
    };
  }

  async clear() {
    await this.ensure();
    const files = await readdir(this.entriesDir).catch(() => []);
    let deleted = 0;
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      await rm(path.join(this.entriesDir, file), { force: true });
      deleted += 1;
    }
    return deleted;
  }
}

function defaultCacheDir() {
  return path.join(process.cwd(), '.computer-use-cache');
}

export function configFromEnv(overrides = {}) {
  const ignoreKeys = new Set(DEFAULT_CACHE_IGNORE_KEYS);
  for (const key of listFromValue(overrides.cacheIgnoreKeys ?? process.env.CACHE_IGNORE_KEYS)) ignoreKeys.add(key);
  return {
    host: String(overrides.host ?? process.env.HOST ?? '127.0.0.1'),
    port: intFromValue(overrides.port ?? process.env.PORT, 8000),
    upstreamBaseUrl: String(overrides.upstreamBaseUrl ?? process.env.UPSTREAM_BASE_URL ?? process.env.OPENAI_BASE_URL ?? 'https://openrouter.ai/api/v1').replace(/\/+$/, ''),
    upstreamApiKey: String(overrides.upstreamApiKey ?? process.env.UPSTREAM_API_KEY ?? process.env.OPENROUTER_API_KEY ?? process.env.OPENAI_API_KEY ?? '').trim(),
    upstreamTimeoutMs: Math.max(1000, Math.floor(floatFromValue(overrides.upstreamTimeoutSeconds ?? process.env.UPSTREAM_TIMEOUT_SECONDS, 180) * 1000)),
    cacheDir: String(overrides.cacheDir ?? process.env.CACHE_DIR ?? process.env.COMPUTER_USE_CACHE_DIR ?? defaultCacheDir()),
    cacheEnabled: boolFromValue(overrides.cacheEnabled ?? process.env.CACHE_ENABLED, true),
    ttlSeconds: intFromValue(overrides.ttlSeconds ?? process.env.CACHE_TTL_SECONDS, 60 * 60 * 24 * 30),
    maxInputChars: intFromValue(overrides.maxInputChars ?? process.env.CACHE_MAX_INPUT_CHARS, 120000),
    maxResponseChars: intFromValue(overrides.maxResponseChars ?? process.env.CACHE_MAX_RESPONSE_CHARS, 240000),
    maxBodyBytes: intFromValue(overrides.maxBodyBytes ?? process.env.MAX_BODY_BYTES, 2 * 1024 * 1024),
    modelAllowlist: listFromValue(overrides.modelAllowlist ?? process.env.CACHE_MODEL_ALLOWLIST),
    modelDenylist: listFromValue(overrides.modelDenylist ?? process.env.CACHE_MODEL_DENYLIST),
    cacheIgnoreKeys: ignoreKeys,
    includeCacheMetadata: boolFromValue(overrides.includeCacheMetadata ?? process.env.INCLUDE_CACHE_METADATA, false),
    adminToken: String(overrides.adminToken ?? process.env.CACHE_ADMIN_TOKEN ?? '').trim()
  };
}

async function proxyJson(req, res, config, cache, routePath, mode) {
  let data;
  try {
    const body = await readRequestBody(req, config.maxBodyBytes);
    data = body ? JSON.parse(body) : {};
  } catch (error) {
    const status = error.status || 400;
    const payload = openAiError(error.message || 'Invalid JSON request body.', status).body;
    sendJson(res, status, payload);
    return;
  }

  const wantsStream = Boolean(data.stream);
  const bypassHeader = boolFromValue(req.headers['x-cache-bypass'], false);
  const cacheEnabled = config.cacheEnabled && requestCacheEnabled(data, true) && !bypassHeader;
  let cacheKey = '';
  let requestPayload = null;
  let bypassReason = '';

  if (cacheEnabled) {
    const normalized = normalizedCacheInput(data, mode, config);
    if (normalized.cacheKey) {
      cacheKey = normalized.cacheKey;
      requestPayload = normalized.requestPayload;
      const hit = await cache.lookup(cacheKey);
      if (hit?.response) {
        if (wantsStream) {
          res.writeHead(200, responseHeaders({
            'content-type': 'text/event-stream; charset=utf-8',
            'cache-control': 'no-cache',
            ...cacheHeaders('HIT', cacheKey)
          }));
          for (const chunk of cachedStreamChunks(hit.response, mode)) res.write(chunk);
          res.end();
          return;
        }
        sendJson(res, 200, withCacheMetadata(hit.response, config, true, cacheKey), cacheHeaders('HIT', cacheKey));
        return;
      }
    } else {
      bypassReason = normalized.reason || 'not cacheable';
    }
  } else {
    bypassReason = bypassHeader ? 'X-Cache-Bypass' : 'cache disabled';
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.upstreamTimeoutMs);
  let upstream;
  try {
    upstream = await fetch(`${config.upstreamBaseUrl}${routePath}`, {
      method: 'POST',
      headers: upstreamHeaders(req, config),
      body: JSON.stringify(data),
      signal: controller.signal
    });
  } catch (error) {
    clearTimeout(timer);
    sendJson(res, 502, openAiError(`Upstream request failed: ${error.message}`, 502, 'upstream_error', 'upstream_failed').body, cacheHeaders('BYPASS', cacheKey, '', bypassReason));
    return;
  }
  clearTimeout(timer);

  if (wantsStream) {
    res.writeHead(upstream.status, responseHeaders({
      'content-type': upstream.headers.get('content-type') || 'text/event-stream; charset=utf-8',
      ...cacheHeaders(cacheKey ? 'MISS' : 'BYPASS', cacheKey, 'stream-not-stored', bypassReason)
    }));
    if (upstream.body) {
      for await (const chunk of upstream.body) res.write(Buffer.from(chunk));
    }
    res.end();
    return;
  }

  const text = await upstream.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    res.writeHead(upstream.status, responseHeaders({
      'content-type': upstream.headers.get('content-type') || 'text/plain; charset=utf-8',
      ...cacheHeaders('BYPASS', cacheKey, '', 'upstream returned non-json')
    }));
    res.end(text);
    return;
  }

  let storeStatus = '';
  if (upstream.ok && cacheKey && requestPayload && payload && typeof payload === 'object' && !Array.isArray(payload)) {
    storeStatus = await cache.store(cacheKey, mode, requestPayload, payload);
  }
  const status = cacheKey ? 'MISS' : 'BYPASS';
  sendJson(res, upstream.status, withCacheMetadata(payload, config, false, cacheKey, storeStatus, bypassReason), cacheHeaders(status, cacheKey, storeStatus, bypassReason));
}

async function proxyModels(req, res, config) {
  try {
    const upstream = await fetch(`${config.upstreamBaseUrl}/models`, {
      method: 'GET',
      headers: upstreamHeaders(req, config)
    });
    const contentType = upstream.headers.get('content-type') || 'application/json; charset=utf-8';
    const text = await upstream.text();
    res.writeHead(upstream.status, responseHeaders({ 'content-type': contentType }));
    res.end(text);
  } catch (error) {
    sendJson(res, 502, openAiError(`Upstream models request failed: ${error.message}`, 502, 'upstream_error', 'upstream_failed').body);
  }
}

function requireAdmin(req, res, config) {
  if (!config.adminToken) return true;
  const provided = String(req.headers['x-cache-admin-token'] || '').trim() || bearerFromHeaders(req.headers);
  if (provided === config.adminToken) return true;
  sendJson(res, 401, openAiError('Invalid cache admin token.', 401, 'authentication_error', 'invalid_api_key').body);
  return false;
}

export function createComputerUseCacheServer(overrides = {}) {
  const config = configFromEnv(overrides);
  const cache = overrides.cache || new FileCompletionCache(config);
  const server = http.createServer(async (req, res) => {
    try {
      const parsed = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
      const pathname = parsed.pathname.replace(/\/+$/, '') || '/';
      if (req.method === 'OPTIONS') {
        res.writeHead(204, responseHeaders());
        res.end();
        return;
      }
      if (req.method === 'GET' && pathname === '/') {
        sendJson(res, 200, {
          name: 'computer-use-cache',
          status: 'ok',
          upstream_base_url: config.upstreamBaseUrl,
          endpoints: ['/v1/chat/completions', '/chat/completions', '/v1/completions', '/v1/models', '/cache/stats']
        });
        return;
      }
      if (req.method === 'GET' && pathname === '/healthz') {
        sendJson(res, 200, { ok: true, cache: await cache.stats(), upstream_base_url: config.upstreamBaseUrl });
        return;
      }
      if (req.method === 'GET' && (pathname === '/cache/stats' || pathname === '/stats')) {
        sendJson(res, 200, await cache.stats());
        return;
      }
      if (req.method === 'POST' && pathname === '/cache/clear') {
        if (!requireAdmin(req, res, config)) return;
        sendJson(res, 200, { ok: true, deleted: await cache.clear() });
        return;
      }
      if (req.method === 'GET' && (pathname === '/v1/models' || pathname === '/models')) {
        await proxyModels(req, res, config);
        return;
      }
      const chatRoutes = new Set(['/v1/chat/completions', '/chat/completions', '/api/v1/chat/completions', '/api/chat/completions']);
      const completionRoutes = new Set(['/v1/completions', '/completions', '/api/v1/completions', '/api/completions']);
      if (req.method === 'POST' && chatRoutes.has(pathname)) {
        await proxyJson(req, res, config, cache, '/chat/completions', 'chat');
        return;
      }
      if (req.method === 'POST' && completionRoutes.has(pathname)) {
        await proxyJson(req, res, config, cache, '/completions', 'completion');
        return;
      }
      sendJson(res, 404, { error: 'not_found', message: `No route for ${req.method} ${pathname}` });
    } catch (error) {
      sendJson(res, 500, openAiError(error.message || 'Internal server error.', 500, 'server_error', 'internal_error').body);
    }
  });
  server.computerUseCache = { config, cache };
  return server;
}

export async function listen(overrides = {}) {
  const server = createComputerUseCacheServer(overrides);
  const config = server.computerUseCache.config;
  await new Promise((resolve) => server.listen(config.port, config.host, resolve));
  return server;
}

export function packageRoot() {
  return path.dirname(path.dirname(fileURLToPath(import.meta.url)));
}
