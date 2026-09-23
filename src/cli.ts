#!/usr/bin/env node
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { BrowserClient, startBroker, brokerStatus, stopBroker } from './client.js';
import { getHome, initConfig, loadConfig, doctor } from './config.js';
import { KeelError, parseClientId, profileForClient, safeError, type ClientId } from './contracts.js';
import { startMcp } from './mcp.js';
import { integrationConfig } from './integrations.js';

interface CliClient { call(method: string, params?: Record<string, unknown>): Promise<unknown> }
export interface CliDependencies {
  getHome: typeof getHome;
  initConfig: typeof initConfig;
  loadConfig: typeof loadConfig;
  doctor: typeof doctor;
  startBroker: typeof startBroker;
  brokerStatus: typeof brokerStatus;
  stopBroker: typeof stopBroker;
  startMcp: typeof startMcp;
  createClient(options: { persistent: boolean; home: string; clientId: ClientId }): CliClient;
}
const defaults: CliDependencies = {
  getHome, initConfig, loadConfig, doctor, startBroker, brokerStatus, stopBroker, startMcp,
  createClient: options => new BrowserClient(options),
};

const pageCommands: Record<string, { method: string; required: string[]; optional?: string[] }> = {
  open: { method: 'open', required: [], optional: ['url'] },
  status: { method: 'status', required: ['session'] },
  close: { method: 'close', required: ['session'] },
  tabs: { method: 'tabs', required: ['session'] },
  'new-tab': { method: 'new_tab', required: ['session'], optional: ['url'] },
  'close-tab': { method: 'close_tab', required: ['session', 'tab'] },
  navigate: { method: 'navigate', required: ['session', 'tab', 'url'] },
  snapshot: { method: 'snapshot', required: ['session', 'tab'] },
  click: { method: 'click', required: ['session', 'tab', 'ref'] },
  fill: { method: 'fill', required: ['session', 'tab', 'ref', 'text'] },
  press: { method: 'press', required: ['session', 'tab', 'ref', 'key'] },
  scroll: { method: 'scroll', required: ['session', 'tab', 'direction'], optional: ['amount'] },
  screenshot: { method: 'screenshot', required: ['session', 'tab'] },
};

const help = {
  name: 'keel-browser',
  commands: [
    'init | doctor | broker start/status/stop | mcp',
    'integration codex/claude-cli/claude-desktop',
    'open [--url URL]',
    'status | close | tabs --session SESSION',
    'new-tab --session SESSION [--url URL]',
    'close-tab | snapshot | screenshot --session SESSION --tab TAB',
    'navigate --session SESSION --tab TAB --url URL',
    'click --session SESSION --tab TAB --ref REF',
    'fill --session SESSION --tab TAB --ref REF --text TEXT',
    'press --session SESSION --tab TAB --ref REF --key KEY',
    'scroll --session SESSION --tab TAB --direction up/down/left/right [--amount PIXELS]',
  ],
  options: ['--client codex/claude-cli/claude-desktop', '--home DIRECTORY', '--json', '--help'],
  notes: 'CLI sessions persist between commands. Close sessions explicitly; idle sessions expire. Screenshots return base64 PNG data in JSON.',
};

export async function executeCli(argv: string[], dependencies: Partial<CliDependencies> = {}): Promise<unknown> {
  const deps = { ...defaults, ...dependencies };
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({ args: argv, strict: true, allowPositionals: true, options: {
      help: { type: 'boolean', short: 'h' }, json: { type: 'boolean' },
      home: { type: 'string' }, client: { type: 'string' }, session: { type: 'string' }, tab: { type: 'string' },
      url: { type: 'string' }, ref: { type: 'string' }, text: { type: 'string' },
      key: { type: 'string' }, direction: { type: 'string' }, amount: { type: 'string' },
    } });
  } catch {
    throw new KeelError('INVALID_ARGUMENT', 'Invalid command or option. Run keel-browser --help for supported options.');
  }
  const { values, positionals } = parsed;
  if (values.help || positionals.length === 0) {
    const clientId = parseClientId(values.client ?? process.env.KEEL_BROWSER_CLIENT ?? 'codex');
    return { ...help, clientId, profile: `Existing MultiZen profile alias ${profileForClient(clientId)}` };
  }
  const command = positionals[0]!;
  const definition = pageCommands[command];
  const allowed = new Set(['json', 'home', 'help', 'client', ...(definition?.required ?? []), ...(definition?.optional ?? [])]);
  if (Object.keys(values).some(key => !allowed.has(key))) {
    throw new KeelError('INVALID_ARGUMENT', 'This command does not accept one or more supplied options.');
  }
  if (positionals.length !== (command === 'broker' || command === 'integration' ? 2 : 1)) {
    throw new KeelError('INVALID_ARGUMENT', 'Unexpected or missing positional argument. Run keel-browser --help.');
  }
  if (command === 'integration') {
    const target = parseClientId(positionals[1]);
    if (values.client !== undefined && parseClientId(values.client) !== target) {
      throw new KeelError('INVALID_ARGUMENT', 'The integration target and --client option must match.');
    }
    return integrationConfig(target, typeof values.home === 'string' ? { home: resolve(values.home) } : {});
  }
  const clientId = parseClientId(values.client ?? process.env.KEEL_BROWSER_CLIENT ?? 'codex');
  const home = typeof values.home === 'string' ? resolve(values.home) : deps.getHome();
  if (command === 'init') return deps.initConfig(home);
  if (command === 'doctor') return deps.doctor(await deps.loadConfig(home), clientId);
  if (command === 'mcp') { await deps.startMcp(home, clientId); return undefined; }
  if (command === 'broker') {
    if (positionals[1] === 'start') return deps.startBroker(home);
    if (positionals[1] === 'status') return deps.brokerStatus(home);
    if (positionals[1] === 'stop') { await deps.stopBroker(home); return { running: false }; }
    throw new KeelError('INVALID_ARGUMENT', 'Broker action must be start, status, or stop.');
  }
  if (!definition) throw new KeelError('INVALID_ARGUMENT', 'Unknown command. Run keel-browser --help.');
  const params: Record<string, unknown> = {};
  for (const name of definition.required) {
    if (typeof values[name] !== 'string' || (name !== 'text' && values[name] === '')) {
      throw new KeelError('INVALID_ARGUMENT', `Missing required --${name} option.`);
    }
  }
  for (const name of [...definition.required, ...(definition.optional ?? [])]) {
    if (values[name] !== undefined) params[name === 'session' ? 'sessionId' : name === 'tab' ? 'tabId' : name] = values[name];
  }
  if (params.url !== undefined) {
    try {
      const target = new URL(String(params.url));
      if (!['http:', 'https:'].includes(target.protocol)) throw new Error();
    } catch { throw new KeelError('INVALID_ARGUMENT', 'URL must be an absolute HTTP or HTTPS URL.'); }
  }
  if (command === 'scroll') {
    if (!['up', 'down', 'left', 'right'].includes(String(params.direction))) {
      throw new KeelError('INVALID_ARGUMENT', 'Scroll direction must be up, down, left, or right.');
    }
    if (params.amount !== undefined) {
      const amount = Number(params.amount);
      if (!Number.isInteger(amount) || amount < 1 || amount > 10_000) {
        throw new KeelError('INVALID_ARGUMENT', 'Scroll amount must be an integer between 1 and 10000.');
      }
      params.amount = amount;
    }
  }
  if (command === 'open') params.mode = 'cli';
  return deps.createClient({ persistent: true, home, clientId }).call(definition.method, params);
}

export async function runCli(
  argv = process.argv.slice(2),
  dependencies: Partial<CliDependencies> = {},
  output: (text: string) => void = text => { process.stdout.write(text); },
): Promise<number> {
  try {
    const result = await executeCli(argv, dependencies);
    if (result !== undefined) output(`${JSON.stringify(result)}\n`);
    return 0;
  } catch (error) {
    output(`${JSON.stringify({ error: safeError(error) })}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void runCli().then(code => { process.exitCode = code; });
}
