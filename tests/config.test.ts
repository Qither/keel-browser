import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { doctor, getHome, initConfig, loadConfig } from '../src/config.js';
import { MultiZenProvider } from '../src/multizen.js';
import { KeelError } from '../src/contracts.js';

const PROFILE_ID = '11111111-1111-4111-8111-111111111111';
const CLAUDE_ID = '22222222-2222-4222-8222-222222222222';
const nativeProfiles = [{ id: PROFILE_ID, name: 'codex', isRunning: true }, { id: CLAUDE_ID, name: 'claude', isRunning: false }];

let home: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'keel-config-test-'));
  vi.stubEnv('APPDATA', join(home, 'appdata'));
  vi.stubEnv('MULTIZEN_MCP_TOKEN', '');
  vi.spyOn(MultiZenProvider.prototype, 'discoverProfiles').mockResolvedValue(nativeProfiles);
});
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await rm(home, { recursive: true, force: true }); });

describe('MultiZen binding configuration', () => {
  it('defaults to portable exact-name bindings and existing native token/settings files', () => {
    expect(loadConfig(home)).toMatchObject({ provider: 'multizen', profiles: { codex: { name: 'codex' }, claude: { name: 'claude' } }, mcpUrl: 'http://127.0.0.1:7777/mcp', tokenEnv: 'MULTIZEN_MCP_TOKEN', tokenFile: join(home, 'appdata', 'MultiZen', 'mcp-token'), providerTimeoutMs: 30_000 });
  });
  it('initializes using the existing settings port and then preserves an explicit binding', async () => {
    const app = join(home, 'appdata', 'MultiZen'); await mkdir(app, { recursive: true });
    await writeFile(join(app, 'settings.json'), JSON.stringify({ mcpHttpEnabled: true, mcpHttpPort: 8899, unrelatedSecret: 'private-settings' }));
    const first = await initConfig(home);
    expect(first.created).toBe(true);
    expect(loadConfig(home).profiles).toEqual({ codex: { name: 'codex', id: PROFILE_ID }, claude: { name: 'claude', id: CLAUDE_ID } });
    expect(loadConfig(home).mcpUrl).toBe('http://127.0.0.1:8899/mcp');
    expect(MultiZenProvider.prototype.discoverProfiles).toHaveBeenCalledTimes(1);
    await writeFile(join(app, 'settings.json'), JSON.stringify({ mcpHttpEnabled: true, mcpHttpPort: 9000 }));
    expect(await initConfig(home)).toEqual({ path: first.path, created: false });
    expect(loadConfig(home).mcpUrl).toBe('http://127.0.0.1:8899/mcp');
    expect(await readFile(first.path, 'utf8')).not.toContain('private-settings');
  });
  it('requires explicit legacy migration and rebuilds only safe lifecycle values without secret backups', async () => {
    const path = join(home, 'config.json');
    await writeFile(path, JSON.stringify({ apiBaseUrl: 'http://127.0.0.1:55173', apiKeyEnv: 'legacy-private-secret', localApiFile: 'private-old-path', profileId: 'retired-profile-id', cliIdleMs: 5000, mcpLeaseMs: -1, operationTimeoutMs: 4000, apiTimeoutMs: 100 }));
    expect(() => loadConfig(home)).toThrow(/Run keel-browser init/);
    expect(await initConfig(home)).toEqual({ path, created: false, migrated: true });
    expect(loadConfig(home)).toMatchObject({ provider: 'multizen', profiles: { codex: { id: PROFILE_ID }, claude: { id: CLAUDE_ID } }, cliIdleMs: 5000, mcpLeaseMs: 120_000, operationTimeoutMs: 4000, providerTimeoutMs: 30_000 });
    const serialized = await readFile(path, 'utf8');
    expect(serialized).not.toMatch(/legacy-private-secret|private-old-path|apiKeyEnv|apiBaseUrl|retired-profile-id/);
    expect(await readdir(home)).toEqual(['config.json']);
  });
  it('refuses to migrate while the old Router could continue serving the previous provider', async () => {
    const path = join(home, 'config.json');
    const legacy = JSON.stringify({ profileId: 'retired-profile-id', apiBaseUrl: 'http://127.0.0.1:55173' });
    await writeFile(path, legacy);
    await writeFile(join(home, 'broker.json'), JSON.stringify({ pid: process.pid, port: 12345, token: '0'.repeat(64), instanceId: 'old-broker' }));
    await expect(initConfig(home)).rejects.toMatchObject({ code: 'CONFIG_MIGRATION_REQUIRES_STOP' });
    expect(await readFile(path, 'utf8')).toBe(legacy);
  });
  it('migrates a single-profile MultiZen binding by keeping its pinned identity and resolving Claude', async () => {
    const path = join(home, 'config.json');
    await writeFile(path, JSON.stringify({ provider: 'multizen', profileId: PROFILE_ID, mcpUrl: 'http://127.0.0.1:8899/mcp', operationTimeoutMs: 4321 }));
    vi.mocked(MultiZenProvider.prototype.discoverProfiles).mockResolvedValue([{ ...nativeProfiles[0]!, name: 'renamed codex' }, nativeProfiles[1]!]);
    expect(await initConfig(home)).toMatchObject({ created: false, migrated: true });
    expect(loadConfig(home)).toMatchObject({ mcpUrl: 'http://127.0.0.1:8899/mcp', profiles: { codex: { id: PROFILE_ID }, claude: { id: CLAUDE_ID } }, operationTimeoutMs: 4321 });
  });
  it('keeps existing config untouched if the second binding cannot be resolved', async () => {
    const path = join(home, 'config.json');
    const prior = JSON.stringify({ provider: 'multizen', profileId: PROFILE_ID });
    await writeFile(path, prior);
    vi.mocked(MultiZenProvider.prototype.discoverProfiles).mockResolvedValue([nativeProfiles[0]!]);
    await expect(initConfig(home)).rejects.toMatchObject({ code: 'PROFILE_NOT_FOUND' });
    expect(await readFile(path, 'utf8')).toBe(prior);
    expect(await readdir(home)).toEqual(['config.json']);
  });
  it('creates no config when name resolution is ambiguous', async () => {
    vi.mocked(MultiZenProvider.prototype.discoverProfiles).mockResolvedValue([...nativeProfiles, { ...nativeProfiles[0]!, id: '33333333-3333-4333-8333-333333333333' }]);
    await expect(initConfig(home)).rejects.toMatchObject({ code: 'PROFILE_AMBIGUOUS' });
    expect(await readdir(home)).toEqual([]);
  });
  it('does not migrate two aliases onto the same browser profile', async () => {
    const path = join(home, 'config.json');
    const prior = JSON.stringify({ provider: 'multizen', profileId: PROFILE_ID });
    await writeFile(path, prior);
    vi.mocked(MultiZenProvider.prototype.discoverProfiles).mockResolvedValue([{ id: PROFILE_ID, name: 'claude', isRunning: true }]);
    await expect(initConfig(home)).rejects.toMatchObject({ code: 'PROFILE_BINDINGS_OVERLAP' });
    expect(await readFile(path, 'utf8')).toBe(prior);
  });
  it.each([
    { codex: { name: 'shared' }, claude: { name: 'shared' } },
    { codex: { name: 'codex', id: PROFILE_ID }, claude: { name: 'claude', id: PROFILE_ID } },
  ])('rejects aliases with overlapping profile identities', async profiles => {
    await writeFile(join(home, 'config.json'), JSON.stringify({ profiles }));
    expect(() => loadConfig(home)).toThrow('different MultiZen profiles');
  });
  it('resolves the router state directory without sharing MultiZen application storage', () => {
    vi.stubEnv('KEEL_BROWSER_HOME', home); expect(getHome()).toBe(resolve(home));
    vi.stubEnv('KEEL_BROWSER_HOME', ''); vi.stubEnv('LOCALAPPDATA', home);
    expect(getHome()).toBe(join(home, 'keel-browser'));
  });
  it.each([{ profileId: 'other' }, { profiles: { codex: { name: 'codex' } } }, { profiles: { codex: { name: 'codex', id: 'not-uuid' }, claude: { name: 'claude' } } }, { provider: 'other' }, { mcpUrl: 'http://example.test/mcp' }, { token: 'private-value' }, { tokenEnv: 'not a name' }, { tokenFile: '' }, { settingsFile: 1 }, { cliIdleMs: 0 }, { mcpLeaseMs: -1 }, { providerTimeoutMs: 2_147_483_648 }, { operationTimeoutMs: 1.5 }, { toString: 'bad' }])('rejects unsafe configuration without echoing values', async partial => {
    await writeFile(join(home, 'config.json'), JSON.stringify(partial));
    expect(() => loadConfig(home)).toThrow();
    expect(() => loadConfig(home)).not.toThrow('private-value');
  });
  it('handles malformed JSON without echoing its content', async () => {
    await writeFile(join(home, 'config.json'), '{private-value');
    expect(() => loadConfig(home)).toThrow('Cannot read');
    expect(() => loadConfig(home)).not.toThrow('private-value');
  });
});

describe('MultiZen doctor', () => {
  it('reports settings drift and token source without exposing token or metadata secrets', async () => {
    const config = loadConfig(home); await mkdir(join(home, 'appdata', 'MultiZen'), { recursive: true });
    await writeFile(config.tokenFile, 'private-file-token');
    await writeFile(config.settingsFile!, JSON.stringify({ mcpHttpEnabled: true, mcpHttpPort: 9000, secret: 'private-settings' }));
    vi.spyOn(MultiZenProvider.prototype, 'inspect').mockResolvedValue({ profileId: PROFILE_ID, name: 'codex', status: 'Active' });
    const report = await doctor(config);
    expect(report).toMatchObject({ ok: false, tokenConfigured: true, tokenSource: 'file', health: { ok: true }, profile: { ok: true }, settings: { status: 'different', detectedMcpUrl: 'http://127.0.0.1:9000/mcp' } });
    expect(JSON.stringify(report)).not.toMatch(/private-file-token|private-settings|cdpEndpoint/);
    expect(config.mcpUrl).toBe('http://127.0.0.1:7777/mcp');
  });
  it('reports disabled native HTTP independently of profile reachability', async () => {
    const config = loadConfig(home); await mkdir(join(home, 'appdata', 'MultiZen'), { recursive: true });
    await writeFile(config.settingsFile!, JSON.stringify({ mcpHttpEnabled: false, mcpHttpPort: 7777 }));
    vi.spyOn(MultiZenProvider.prototype, 'inspect').mockRejectedValue(new KeelError('TOKEN_MISSING', 'Token unavailable.'));
    expect(await doctor(config)).toMatchObject({ ok: false, tokenConfigured: false, tokenSource: 'missing', settings: { status: 'disabled' }, profile: { ok: false, code: 'TOKEN_MISSING' } });
  });
  it('distinguishes a healthy native MCP endpoint from a missing bound profile', async () => {
    vi.spyOn(MultiZenProvider.prototype, 'inspect').mockRejectedValue(new KeelError('PROFILE_NOT_FOUND', 'Profile unavailable.'));
    expect(await doctor(loadConfig(home))).toMatchObject({ ok: false, health: { ok: true }, profile: { ok: false, code: 'PROFILE_NOT_FOUND' } });
  });
  it.each(['claude-cli', 'claude-desktop'] as const)('diagnoses the Claude binding for %s', async clientId => {
    vi.spyOn(MultiZenProvider.prototype, 'inspect').mockResolvedValue({ profileId: CLAUDE_ID, name: 'claude', status: 'Inactive' });
    expect(await doctor(loadConfig(home), clientId)).toMatchObject({ clientId, profileAlias: 'claude', profileId: CLAUDE_ID, profile: { ok: true, name: 'claude' } });
  });
});
