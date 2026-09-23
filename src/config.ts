import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { MultiZenProvider, normalizeMcpUrl, tokenStatus, isProfileId, resolveProfileBinding, validateProfileBindings } from './multizen.js';
import { KeelError, parseClientId, profileForClient, safeError, type ClientId, type KeelConfig, type ProfileAlias } from './contracts.js';
import { processAlive, readState } from './state.js';

export function getHome(): string {
  return resolve(process.env.KEEL_BROWSER_HOME || join(process.env.LOCALAPPDATA || join(homedir(), '.local', 'share'), 'keel-browser'));
}
const validTimeout = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= 2_147_483_647;
const validPort = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 65535;
function defaults(): KeelConfig {
  const app = join(process.env.APPDATA || join(homedir(), '.config'), 'MultiZen');
  return { provider: 'multizen', mcpUrl: 'http://127.0.0.1:7777/mcp', tokenEnv: 'MULTIZEN_MCP_TOKEN', tokenFile: join(app, 'mcp-token'), settingsFile: join(app, 'settings.json'),
    profiles: { codex: { name: 'codex' }, claude: { name: 'claude' } }, cliIdleMs: 1_800_000, mcpLeaseMs: 120_000, operationTimeoutMs: 15_000, providerTimeoutMs: 30_000 };
}
function parseConfiguration(path: string): Record<string, unknown> {
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(path, 'utf8')); } catch { throw new KeelError('INVALID_CONFIG', 'Cannot read the keel-browser configuration.'); }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new KeelError('INVALID_CONFIG', 'Configuration must be a JSON object.');
  return raw as Record<string, unknown>;
}
function legacy(data: Record<string, unknown>): boolean {
  return Object.hasOwn(data, 'profileId') || ['apiBaseUrl', 'apiKeyEnv', 'localApiFile'].some(key => Object.hasOwn(data, key));
}
export function loadConfig(home = getHome()): KeelConfig {
  const path = join(home, 'config.json');
  const config = defaults();
  if (!existsSync(path)) return config;
  const data = parseConfiguration(path);
  if (legacy(data)) throw new KeelError('CONFIG_MIGRATION_REQUIRED', 'The previous browser configuration must be migrated. Run keel-browser init.');
  if (Object.keys(data).some(key => !Object.hasOwn(config, key))) throw new KeelError('INVALID_CONFIG', 'Configuration contains unsupported fields. Store the token only in its configured environment variable or file.');
  applyConfig(config, data);
  return config;
}
function applyConfig(config: KeelConfig, data: Record<string, unknown>): void {
  if (data.provider !== undefined && data.provider !== 'multizen') throw new KeelError('INVALID_CONFIG', 'Only MultiZen browser profiles are supported.');
  if (data.profiles !== undefined) {
    if (!data.profiles || typeof data.profiles !== 'object' || Array.isArray(data.profiles)) throw new KeelError('INVALID_CONFIG', 'Profiles must contain codex and claude bindings.');
    const profiles = data.profiles as Record<string, unknown>;
    if (Object.keys(profiles).some(key => !['codex', 'claude'].includes(key))) throw new KeelError('INVALID_CONFIG', 'Unsupported profile alias.');
    for (const alias of ['codex', 'claude'] as const) {
      const raw = profiles[alias];
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new KeelError('INVALID_CONFIG', 'Profiles must contain codex and claude bindings.');
      const binding = raw as Record<string, unknown>;
      if (Object.keys(binding).some(key => !['name', 'id'].includes(key)) || typeof binding.name !== 'string' || !binding.name.trim() || binding.name.length > 256 || (binding.id !== undefined && !isProfileId(binding.id))) throw new KeelError('INVALID_CONFIG', 'Invalid browser profile binding.');
      config.profiles[alias] = { name: binding.name, ...(binding.id ? { id: binding.id as string } : {}) };
    }
  }
  if (data.mcpUrl !== undefined) {
    if (typeof data.mcpUrl !== 'string') throw new KeelError('INVALID_CONFIG', 'Invalid MultiZen MCP address.');
    config.mcpUrl = normalizeMcpUrl(data.mcpUrl);
  }
  if (data.tokenEnv !== undefined) {
    if (typeof data.tokenEnv !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(data.tokenEnv)) throw new KeelError('INVALID_CONFIG', 'Invalid token environment variable name.');
    config.tokenEnv = data.tokenEnv;
  }
  for (const key of ['tokenFile', 'settingsFile'] as const) {
    if (data[key] !== undefined) {
      if (typeof data[key] !== 'string' || !data[key].trim()) throw new KeelError('INVALID_CONFIG', 'Invalid MultiZen configuration file path.');
      config[key] = data[key];
    }
  }
  for (const key of ['cliIdleMs', 'mcpLeaseMs', 'operationTimeoutMs', 'providerTimeoutMs'] as const) {
    if (data[key] !== undefined) {
      if (!validTimeout(data[key])) throw new KeelError('INVALID_CONFIG', `Invalid timeout: ${key}.`);
      config[key] = data[key];
    }
  }
  validateProfileBindings(config.profiles);
}
export async function initConfig(home = getHome()): Promise<{ path: string; created: boolean; migrated?: boolean }> {
  const path = join(home, 'config.json');
  const config = defaults();
  const existing = existsSync(path) ? parseConfiguration(path) : undefined;
  if (existing && !legacy(existing)) {
    const current = loadConfig(home);
    if (current.profiles.codex.id && current.profiles.claude.id) return { path, created: false };
    applyConfig(config, existing);
  }
  const running = await readState(home);
  if (running && processAlive(running.pid)) throw new KeelError('CONFIG_MIGRATION_REQUIRES_STOP', 'Stop the existing Router before changing profile bindings: keel-browser broker stop.');
  try {
    const settings: unknown = JSON.parse(await readFile(config.settingsFile!, 'utf8'));
    if ((!existing || (legacy(existing) && existing.provider !== 'multizen')) && settings && typeof settings === 'object' && validPort((settings as Record<string, unknown>).mcpHttpPort)) config.mcpUrl = `http://127.0.0.1:${(settings as Record<string, unknown>).mcpHttpPort}/mcp`;
  } catch { /* Missing settings use the standard local endpoint. */ }
  if (existing && legacy(existing)) {
    // Rebuild from an allowlist. Never copy legacy secret fields or make secret-bearing backups.
    for (const key of ['cliIdleMs', 'mcpLeaseMs', 'operationTimeoutMs', 'providerTimeoutMs'] as const) if (validTimeout(existing[key])) config[key] = existing[key];
    if (existing.provider === 'multizen') {
      const safeFields = Object.fromEntries(['provider', 'mcpUrl', 'tokenEnv', 'tokenFile', 'settingsFile'].filter(key => Object.hasOwn(existing, key)).map(key => [key, existing[key]]));
      applyConfig(config, safeFields);
      if (isProfileId(existing.profileId)) config.profiles.codex.id = existing.profileId;
    }
  }
  const discovered = await new MultiZenProvider(config).discoverProfiles();
  for (const alias of ['codex', 'claude'] as const) {
    const profile = resolveProfileBinding(config.profiles[alias], discovered);
    config.profiles[alias] = { ...config.profiles[alias], id: profile.id };
  }
  validateProfileBindings(config.profiles);
  await mkdir(home, { recursive: true, mode: 0o700 });
  if (existing) {
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
      await rename(temporary, path);
      return { path, created: false, migrated: true };
    } catch { await unlink(temporary).catch(() => {}); throw new KeelError('CONFIG_WRITE_FAILED', 'Cannot migrate the keel-browser configuration.'); }
  }
  try {
    await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    return { path, created: true };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return { path, created: false };
    throw new KeelError('CONFIG_WRITE_FAILED', 'Cannot create the keel-browser configuration.');
  }
}

type Check = { ok: boolean; code?: string; message?: string };
export interface DoctorReport {
  ok: boolean; provider: 'multizen'; mcpUrl: string; clientId: ClientId; profileAlias: ProfileAlias; profileId?: string;
  tokenConfigured: boolean; tokenSource: 'environment' | 'file' | 'missing';
  health: Check; profile: Check & { name?: string; status?: 'Active' | 'Inactive' };
  settings: { status: 'match' | 'different' | 'disabled' | 'missing' | 'invalid' | 'unconfigured'; httpEnabled?: boolean; detectedMcpUrl?: string };
}
export async function doctor(config: KeelConfig, clientId: ClientId = 'codex'): Promise<DoctorReport> {
  clientId = parseClientId(clientId);
  const profileAlias = profileForClient(clientId);
  const token = await tokenStatus(config);
  const report: DoctorReport = { ok: false, provider: 'multizen', mcpUrl: normalizeMcpUrl(config.mcpUrl), clientId, profileAlias, ...(config.profiles[profileAlias].id ? { profileId: config.profiles[profileAlias].id } : {}),
    tokenConfigured: token.configured, tokenSource: token.source, health: { ok: false }, profile: { ok: false }, settings: { status: 'unconfigured' } };
  if (config.settingsFile) {
    try {
      const data = JSON.parse(await readFile(config.settingsFile, 'utf8')) as Record<string, unknown>;
      if (!data || typeof data !== 'object' || !validPort(data.mcpHttpPort) || typeof data.mcpHttpEnabled !== 'boolean') throw new Error();
      const detectedMcpUrl = `http://127.0.0.1:${data.mcpHttpPort}/mcp`;
      report.settings = { status: !data.mcpHttpEnabled ? 'disabled' : detectedMcpUrl === report.mcpUrl ? 'match' : 'different', httpEnabled: data.mcpHttpEnabled, detectedMcpUrl };
    } catch (error) { report.settings = { status: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'invalid' }; }
  }
  try {
    const profile = await new MultiZenProvider(config, profileAlias).inspect();
    report.profileId = profile.profileId;
    report.health = { ok: true }; report.profile = { ok: true, name: profile.name, status: profile.status };
  } catch (error) {
    const failure = safeError(error);
    const healthy = ['PROFILE_NOT_FOUND', 'PROFILE_AMBIGUOUS'].includes(failure.code);
    report.health = { ok: healthy, ...(healthy ? {} : failure) };
    report.profile = { ok: false, ...failure };
  }
  report.ok = report.health.ok && report.profile.ok && !['different', 'invalid', 'disabled'].includes(report.settings.status);
  return report;
}
