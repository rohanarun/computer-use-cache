export function computerUseCacheBaseURL(options = {}) {
  const host = options.host || '127.0.0.1';
  const port = options.port || 8000;
  const protocol = options.protocol || 'http';
  return options.baseURL || `${protocol}://${host}:${port}/v1`;
}

export function openAIConfig(options = {}) {
  return {
    baseURL: computerUseCacheBaseURL(options),
    apiKey: options.apiKey || process.env.OPENAI_API_KEY || process.env.UPSTREAM_API_KEY || 'computer-use-cache'
  };
}

export function createComputerUseCacheClient(options = {}) {
  const baseURL = String(options.baseURL || computerUseCacheBaseURL(options)).replace(/\/+$/, '');
  const apiKey = options.apiKey || process.env.OPENAI_API_KEY || process.env.UPSTREAM_API_KEY || 'computer-use-cache';
  const fetchImpl = options.fetch || globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new Error('A fetch implementation is required.');
  }
  async function request(path, body) {
    const response = await fetchImpl(`${baseURL}${path}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify(body || {})
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message = data?.error?.message || data?.message || `Request failed with ${response.status}`;
      throw new Error(message);
    }
    return data;
  }
  return {
    baseURL,
    chat: {
      completions: {
        create: (body) => request('/chat/completions', body)
      }
    },
    completions: {
      create: (body) => request('/completions', body)
    }
  };
}
