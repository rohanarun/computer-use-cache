# Generated Website Workflow

Use this when an agent generates the same landing page, microsite, or static artifact more than once.

## Install

```bash
npx -y github:rohanarun/computer-use-cache install codex
export UPSTREAM_BASE_URL=https://openrouter.ai/api/v1
export UPSTREAM_API_KEY=sk-or-v1-your-key
npx -y github:rohanarun/computer-use-cache start
```

## Agent prompt

```text
Generate a polished single-file HTML landing page for a local dog walking service. Include responsive CSS, a hero section, services, testimonials, pricing, and a call to action.
```

## Cache notes

Computer-Use Cache is most useful when your agent repeats a deterministic generation request or retry loop. If the prompt changes, the cache key changes too.

