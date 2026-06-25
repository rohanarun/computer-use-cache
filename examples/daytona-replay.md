# Daytona Replay Workflow

Use this when an agent repeatedly solves a cloud-sandbox task in Daytona and generates similar code, shell commands, or artifact summaries.

## Install

```bash
npx -y github:rohanarun/computer-use-cache install codex
export UPSTREAM_BASE_URL=https://openrouter.ai/api/v1
export UPSTREAM_API_KEY=sk-or-v1-your-key
npx -y github:rohanarun/computer-use-cache start
```

## Agent prompt

```text
Create a Daytona sandbox, write a small Python script that converts an input PNG to JPG, run it, and return the output file path and command log summary.
```

## Cache notes

Sandbox IDs and temporary URLs should not be part of repeatable cached prompts. Put stable task intent in the model request, and keep volatile runtime values in tool execution state.

