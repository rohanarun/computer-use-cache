# OpenClaw and Hermes Provider Setup

Computer-Use Cache behaves like an OpenAI-compatible provider. Any agent that supports a custom OpenAI base URL can route repeated tasks through it.

## Start the cache

```bash
export UPSTREAM_BASE_URL=https://openrouter.ai/api/v1
export UPSTREAM_API_KEY=sk-or-v1-your-key
npx -y github:rohanarun/computer-use-cache start
```

## Provider values

```text
Base URL: http://127.0.0.1:8000/v1
API key: $UPSTREAM_API_KEY
Chat completions: /v1/chat/completions
Models: /v1/models
```

## Agent instruction

```text
Use Computer-Use Cache for repeatable browser, shell, and computer-use workflows. Keep deterministic request fields stable to maximize cache hits. Bypass cache for private, credential-bearing, or one-off requests.
```

