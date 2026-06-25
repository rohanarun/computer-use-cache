# Browserbase Replay Workflow

Use this when an agent repeatedly opens the same browser task and performs the same sequence of planning calls around a Browserbase session.

## Install

```bash
npx -y github:rohanarun/computer-use-cache install all
export UPSTREAM_BASE_URL=https://openrouter.ai/api/v1
export UPSTREAM_API_KEY=sk-or-v1-your-key
npx -y github:rohanarun/computer-use-cache start
```

## Agent prompt

```text
Open a Browserbase session, navigate to the target page, summarize the visible page, capture a screenshot, and return the screenshot URL plus a two-sentence summary.

Target: https://example.com
```

## Cache notes

Do not cache credentials, cookies, private account state, or one-off user secrets. Cache only repeatable planning and analysis calls that are safe to replay.

