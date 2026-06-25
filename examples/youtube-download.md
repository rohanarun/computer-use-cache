# YouTube Download Workflow

Use this when an agent repeatedly solves the same "download this YouTube video" workflow with shell tools such as `yt-dlp`.

## Install

```bash
npx -y computer-use-cache install codex
export UPSTREAM_BASE_URL=https://openrouter.ai/api/v1
export UPSTREAM_API_KEY=sk-or-v1-your-key
npx -y computer-use-cache start
```

## Agent prompt

```text
Download this YouTube video with yt-dlp, save the output file, and return the local file path plus a short summary of what happened.

URL: https://www.youtube.com/watch?v=dQw4w9WgXcQ
```

## Cache notes

Keep the same URL, model, messages, tools, temperature, and response format for replay tests. The first successful run should be a miss. The exact same request should then be a hit.

