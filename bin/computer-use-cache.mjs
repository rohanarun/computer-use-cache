#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { createComputerUseCacheServer, configFromEnv } from '../src/server.mjs';

const PACKAGE_JSON = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const VERSION = PACKAGE_JSON.version || '0.0.0';

const AGENT_TARGETS = {
  codex: {
    label: 'Codex',
    filename: 'codex.md',
    command: 'Use http://127.0.0.1:8000/v1 as the OpenAI-compatible base URL for repeatable coding and computer-use tasks.'
  },
  'claude-code': {
    label: 'Claude Code',
    filename: 'claude-code.md',
    command: 'Point Claude Code-compatible OpenAI routes at http://127.0.0.1:8000/v1 for repeated tool workflows.'
  },
  cursor: {
    label: 'Cursor',
    filename: 'cursor.md',
    command: 'Set the custom OpenAI-compatible endpoint to http://127.0.0.1:8000/v1 and reuse stable prompts for cache hits.'
  },
  openclaw: {
    label: 'OpenClaw',
    filename: 'openclaw.md',
    command: 'Configure the OpenAI-compatible provider base URL as http://127.0.0.1:8000/v1 before running repeatable app automations.'
  },
  hermes: {
    label: 'Hermes',
    filename: 'hermes.md',
    command: 'Use Computer-Use Cache as the model provider base URL for repeated browser, shell, and computer-use skills.'
  }
};

function usage() {
  return `Computer-Use Cache ${VERSION}

OpenAI-compatible cache proxy for repeatable computer-use and agent workflows.

Usage:
  computer-use-cache start [--port 8000] [--host 127.0.0.1] [--upstream https://openrouter.ai/api/v1]
  computer-use-cache init [--dir .]
  computer-use-cache install [codex|claude-code|cursor|openclaw|hermes|all] [--dir .]
  computer-use-cache env [--port 8000]
  computer-use-cache stats [--url http://127.0.0.1:8000]
  computer-use-cache clear [--url http://127.0.0.1:8000] [--admin-token token]
  computer-use-cache doctor

Examples:
  npx -y github:rohanarun/computer-use-cache start --upstream https://openrouter.ai/api/v1
  npx -y github:rohanarun/computer-use-cache install all
  export OPENAI_BASE_URL=http://127.0.0.1:8000/v1
  export OPENAI_API_KEY=$OPENROUTER_API_KEY
`;
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith('--')) {
      args._.push(item);
      continue;
    }
    const [rawKey, inline] = item.slice(2).split('=', 2);
    const key = rawKey.replace(/-([a-z])/g, (_, char) => char.toUpperCase());
    if (inline !== undefined) {
      args[key] = inline;
    } else if (argv[index + 1] && !argv[index + 1].startsWith('--')) {
      args[key] = argv[index + 1];
      index += 1;
    } else {
      args[key] = true;
    }
  }
  return args;
}

function optionNumber(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

async function writeInitFiles(targetDir) {
  await mkdir(targetDir, { recursive: true });
  const envText = `# Computer-Use Cache
UPSTREAM_BASE_URL=https://openrouter.ai/api/v1
UPSTREAM_API_KEY=sk-or-v1-your-key
HOST=127.0.0.1
PORT=8000
CACHE_DIR=.computer-use-cache
CACHE_ENABLED=1
CACHE_TTL_SECONDS=2592000
INCLUDE_CACHE_METADATA=1
`;
  const promptText = `# Computer-Use Cache Agent Instructions

Use Computer-Use Cache as the OpenAI-compatible base URL for repeatable computer-use, browser, coding, and tool workflows.

Base URL:

\`\`\`text
http://127.0.0.1:8000/v1
\`\`\`

When you call an OpenAI-compatible model, keep deterministic parameters stable for repeatable work:

- Keep model, messages, tools, tool_choice, response_format, temperature, top_p, and seed consistent when replaying a workflow.
- Use \`cache: false\` only for private, one-off, or credential-bearing requests.
- Do not include API keys, passwords, private tokens, or credentials in cached prompts.
- Check response headers: \`X-Computer-Use-Cache: HIT|MISS|BYPASS\`.

For Codex/OpenClaw/Hermes/Claude wrappers, set:

\`\`\`bash
export OPENAI_BASE_URL=http://127.0.0.1:8000/v1
export OPENAI_API_KEY=$UPSTREAM_API_KEY
\`\`\`
`;
  const configText = JSON.stringify({
    baseURL: 'http://127.0.0.1:8000/v1',
    cacheHeader: 'X-Computer-Use-Cache',
    chatCompletionsEndpoint: '/v1/chat/completions',
    statsEndpoint: '/cache/stats'
  }, null, 2);
  await writeFile(path.join(targetDir, '.env.computer-use-cache.example'), envText, 'utf8');
  await writeFile(path.join(targetDir, 'COMPUTER_USE_CACHE_AGENT.md'), promptText, 'utf8');
  await writeFile(path.join(targetDir, 'computer-use-cache.config.json'), `${configText}\n`, 'utf8');
}

function agentInstallText(target) {
  return `# Computer-Use Cache for ${target.label}

Computer-Use Cache is a drop-in OpenAI-compatible cache for repeatable computer-use, browser, coding, and tool workflows.

## Run the cache

\`\`\`bash
export UPSTREAM_BASE_URL=https://openrouter.ai/api/v1
export UPSTREAM_API_KEY=sk-or-v1-your-key
npx -y github:rohanarun/computer-use-cache start
\`\`\`

## Configure ${target.label}

Base URL:

\`\`\`text
http://127.0.0.1:8000/v1
\`\`\`

API key:

\`\`\`text
$UPSTREAM_API_KEY
\`\`\`

${target.command}

## Agent instruction

Use the cache for repeated workflows where the same model request, tools, and deterministic parameters can replay safely. Do not cache private credentials, one-off secrets, passwords, API keys, or user tokens. Check \`X-Computer-Use-Cache\` for \`HIT\`, \`MISS\`, or \`BYPASS\`.
`;
}

async function writeInstallFiles(targetDir, targetName) {
  await writeInitFiles(targetDir);
  const installDir = path.join(targetDir, '.computer-use-cache', 'agents');
  await mkdir(installDir, { recursive: true });
  const names = targetName === 'all' ? Object.keys(AGENT_TARGETS) : [targetName];
  for (const name of names) {
    const target = AGENT_TARGETS[name];
    if (!target) {
      throw new Error(`Unknown install target "${name}". Use one of: ${Object.keys(AGENT_TARGETS).join(', ')}, all`);
    }
    await writeFile(path.join(installDir, target.filename), agentInstallText(target), 'utf8');
  }
  return names;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0] || (args.version ? 'version' : args.help ? 'help' : 'help');
  if (command === 'help' || command === '--help' || command === '-h') {
    console.log(usage());
    return;
  }
  if (command === 'version' || command === '--version' || command === '-v') {
    console.log(VERSION);
    return;
  }
  if (command === 'init') {
    const dir = path.resolve(String(args.dir || args.d || '.'));
    await writeInitFiles(dir);
    console.log(`Created Computer-Use Cache agent files in ${dir}`);
    console.log('Next: computer-use-cache start');
    return;
  }
  if (command === 'install') {
    const target = String(args._[1] || 'all').toLowerCase();
    const dir = path.resolve(String(args.dir || args.d || '.'));
    const names = await writeInstallFiles(dir, target);
    console.log(`Installed Computer-Use Cache setup files for: ${names.map((name) => AGENT_TARGETS[name].label).join(', ')}`);
    console.log(`Files: ${path.join(dir, '.computer-use-cache', 'agents')}`);
    console.log('Next: computer-use-cache start');
    return;
  }
  if (command === 'env') {
    const host = args.host || '127.0.0.1';
    const port = optionNumber(args.port, 8000);
    console.log(`export OPENAI_BASE_URL=http://${host}:${port}/v1`);
    console.log('export OPENAI_API_KEY=$UPSTREAM_API_KEY');
    return;
  }
  if (command === 'doctor') {
    console.log(`node: ${process.version}`);
    console.log(`fetch: ${typeof fetch === 'function' ? 'ok' : 'missing'}`);
    console.log(`upstream key: ${process.env.UPSTREAM_API_KEY || process.env.OPENROUTER_API_KEY || process.env.OPENAI_API_KEY ? 'set' : 'missing'}`);
    console.log(`cache dir: ${configFromEnv(args).cacheDir}`);
    return;
  }
  if (command === 'stats' || command === 'clear') {
    const base = String(args.url || 'http://127.0.0.1:8000').replace(/\/+$/, '');
    const headers = {};
    if (args.adminToken) headers['x-cache-admin-token'] = String(args.adminToken);
    const response = await fetch(`${base}${command === 'stats' ? '/cache/stats' : '/cache/clear'}`, {
      method: command === 'stats' ? 'GET' : 'POST',
      headers
    });
    const text = await response.text();
    console.log(text);
    if (!response.ok) process.exitCode = 1;
    return;
  }
  if (command === 'start' || command === 'serve' || command === 'proxy') {
    const overrides = {
      host: args.host,
      port: args.port,
      upstreamBaseUrl: args.upstream || args.upstreamBaseUrl,
      upstreamApiKey: args.upstreamApiKey,
      cacheDir: args.cacheDir,
      adminToken: args.adminToken
    };
    const server = createComputerUseCacheServer(overrides);
    const config = server.computerUseCache.config;
    await new Promise((resolve) => server.listen(config.port, config.host, resolve));
    console.log(`Computer-Use Cache listening on http://${config.host}:${config.port}`);
    console.log(`OpenAI-compatible baseURL: http://${config.host}:${config.port}/v1`);
    console.log(`Upstream: ${config.upstreamBaseUrl}`);
    console.log(`Cache dir: ${config.cacheDir}`);
    return;
  }
  console.error(`Unknown command: ${command}\n`);
  console.error(usage());
  process.exitCode = 1;
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exitCode = 1;
});
