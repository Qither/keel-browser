import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MultiZenProvider, normalizeCdpEndpoint, normalizeMcpUrl, tokenStatus, type NativeMcpClient, type NativeMcpClientFactory } from '../src/multizen.js';
import type { KeelConfig } from '../src/contracts.js';

const PROFILE_ID = '11111111-1111-4111-8111-111111111111';
const CLAUDE_ID = '22222222-2222-4222-8222-222222222222';

let home: string;
let config: KeelConfig;
const result = (data: unknown) => ({ content: [{ type: 'text', text: JSON.stringify(data) }] });
const profiles = { profiles: [{ id: CLAUDE_ID, name: 'claude', isRunning: false }, { id: PROFILE_ID, name: 'renamed codex', isRunning: true, proxyPassword: 'private-metadata' }] };
const launched = { id: PROFILE_ID, cdpEndpoint: 'http://127.0.0.1:9333', pid: 123, startedAt: 'now' };
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'keel-multizen-test-'));
  config = { provider: 'multizen', profiles: { codex: { name: 'codex', id: PROFILE_ID }, claude: { name: 'claude' } }, mcpUrl: 'http://127.0.0.1:7777/mcp', tokenEnv: 'KEEL_TEST_MULTIZEN_TOKEN', tokenFile: join(home, 'mcp-token'), cliIdleMs: 1_800_000, mcpLeaseMs: 120_000, operationTimeoutMs: 15_000, providerTimeoutMs: 1000 };
  vi.stubEnv(config.tokenEnv, 'fixture-token');
});
afterEach(async () => { vi.unstubAllEnvs(); vi.restoreAllMocks(); await rm(home, { recursive: true, force: true }); });
function fixture(...payloads: unknown[]) {
  const callTool = vi.fn<NativeMcpClient['callTool']>();
  for (const payload of payloads) callTool.mockResolvedValueOnce(payload);
  const client: NativeMcpClient = { connect: vi.fn(async () => {}), callTool, close: vi.fn(async () => {}) };
  const factory = vi.fn<NativeMcpClientFactory>(() => client);
  return { client, factory, callTool, provider: new MultiZenProvider(config, 'codex', factory) };
}

describe('MultiZen profile provider', () => {
  it('inspects metadata without launching and strips all unrelated/sensitive fields', async () => {
    const f = fixture(result(profiles));
    expect(await f.provider.inspect()).toEqual({ profileId: PROFILE_ID, name: 'renamed codex', status: 'Active' });
    expect(f.callTool).toHaveBeenCalledExactlyOnceWith('list_profiles', {}, expect.any(AbortSignal));
    expect(f.client.close).toHaveBeenCalledTimes(1);
  });
  it('coalesces concurrent opens and idempotently launches only the existing fixed profile without overrides', async () => {
    const f = fixture(result(profiles), result(launched));
    const values = await Promise.all([f.provider.connectInfo(), f.provider.connectInfo(), f.provider.connectInfo()]);
    expect(values[0]).toEqual({ profileId: PROFILE_ID, name: 'renamed codex', cdpEndpoint: 'http://127.0.0.1:9333' });
    expect(values[2]).toEqual(values[0]);
    expect(f.callTool.mock.calls.map(([name, args]) => [name, args])).toEqual([['list_profiles', {}], ['launch_profile', { profile_id: PROFILE_ID }]]);
    expect(f.factory).toHaveBeenCalledTimes(1);
    expect(f.client.close).toHaveBeenCalledTimes(1);
  });
  it('never substitutes a same-named profile when the fixed ID is absent', async () => {
    const f = fixture(result({ profiles: [{ id: CLAUDE_ID, name: 'codex', isRunning: false }] }));
    await expect(f.provider.connectInfo()).rejects.toMatchObject({ code: 'PROFILE_NOT_FOUND' });
    expect(f.callTool).toHaveBeenCalledTimes(1);
    expect(f.client.close).toHaveBeenCalledTimes(1);
  });
  it('rejects a mismatched launch ID and invalid browser endpoints', async () => {
    await expect(fixture(result(profiles), result({ ...launched, id: 'other' })).provider.connectInfo()).rejects.toMatchObject({ code: 'PROFILE_MISMATCH' });
    await expect(fixture(result(profiles), result({ ...launched, cdpEndpoint: 'http://remote.example:9333' })).provider.connectInfo()).rejects.toMatchObject({ code: 'INVALID_CDP_ENDPOINT' });
  });
  it('uses an environment override, otherwise privately reads the existing token file', async () => {
    await writeFile(config.tokenFile, 'file-fixture-token\n');
    const env = fixture(result(profiles));
    await env.provider.inspect();
    expect(env.factory).toHaveBeenCalledWith(config.mcpUrl, 'fixture-token', config.providerTimeoutMs);
    expect(await tokenStatus(config)).toEqual({ configured: true, source: 'environment' });
    vi.stubEnv(config.tokenEnv, '');
    const file = fixture(result(profiles));
    await file.provider.inspect();
    expect(file.factory).toHaveBeenCalledWith(config.mcpUrl, 'file-fixture-token', config.providerTimeoutMs);
    expect(await tokenStatus(config)).toEqual({ configured: true, source: 'file' });
  });
  it('fails locally when no token exists and does not construct a network client', async () => {
    vi.stubEnv(config.tokenEnv, '');
    const f = fixture();
    await expect(f.provider.inspect()).rejects.toMatchObject({ code: 'TOKEN_MISSING' });
    expect(f.factory).not.toHaveBeenCalled();
    expect(await tokenStatus(config)).toEqual({ configured: false, source: 'missing' });
  });
  it.each([
    [{ isError: true, content: [{ type: 'text', text: 'private-upstream' }] }, 'MULTIZEN_TOOL_ERROR'],
    [{ content: [{ type: 'text', text: 'private-invalid-json' }] }, 'MULTIZEN_INVALID_RESPONSE'],
    [result({ profiles: 'not-a-list' }), 'MULTIZEN_INVALID_RESPONSE'],
    [result({ profiles: [{ id: PROFILE_ID, name: 'codex', isRunning: 'yes' }] }), 'MULTIZEN_INVALID_RESPONSE'],
  ])('sanitizes tool errors and incompatible payloads', async (payload, code) => {
    const f = fixture(payload);
    const pending = f.provider.inspect();
    await expect(pending).rejects.toMatchObject({ code });
    await expect(pending).rejects.not.toThrow('private-');
    expect(f.client.close).toHaveBeenCalledTimes(1);
  });
  it.each([[401, 'MULTIZEN_AUTH_FAILED'], [403, 'MULTIZEN_AUTH_FAILED'], [-32601, 'MULTIZEN_TOOL_UNAVAILABLE'], [500, 'MULTIZEN_UNAVAILABLE']])('sanitizes failed handshakes and always closes transport', async (code, expected) => {
    const f = fixture();
    vi.mocked(f.client.connect).mockRejectedValue(Object.assign(new Error('private-network-error'), { code }));
    const pending = f.provider.inspect();
    await expect(pending).rejects.toMatchObject({ code: expected });
    await expect(pending).rejects.not.toThrow('private-network-error');
    expect(f.client.close).toHaveBeenCalledTimes(1);
    expect(f.callTool).not.toHaveBeenCalled();
  });
  it('bounds the entire operation and prevents a late metadata result from launching after timeout', async () => {
    config.providerTimeoutMs = 20;
    const f = fixture();
    let release!: (value: unknown) => void;
    f.callTool.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    await expect(f.provider.connectInfo()).rejects.toMatchObject({ code: 'MULTIZEN_TIMEOUT' });
    expect(f.client.close).toHaveBeenCalledTimes(1);
    release(result(profiles));
    await new Promise(resolve => setImmediate(resolve));
    expect(f.callTool).toHaveBeenCalledTimes(1);
  });
  it('does not retry an uncertain launch timeout', async () => {
    config.providerTimeoutMs = 20;
    const f = fixture(result(profiles));
    f.callTool.mockImplementationOnce(() => new Promise(() => {}));
    await expect(f.provider.connectInfo()).rejects.toMatchObject({ code: 'MULTIZEN_TIMEOUT' });
    expect(f.callTool.mock.calls.map(([name]) => name)).toEqual(['list_profiles', 'launch_profile']);
    expect(f.client.close).toHaveBeenCalledTimes(1);
  });
  it('rejects malformed bindings even if configuration loading is bypassed', () => {
    expect(() => new MultiZenProvider({ ...config, profiles: { ...config.profiles, codex: { name: 'codex', id: 'invalid-id' } } })).toThrow();
    expect(() => new MultiZenProvider(config, 'unknown' as 'codex')).toThrow();
  });
  it('resolves Claude by unique exact name while keeping Codex on its pinned ID', async () => {
    const f = fixture(result(profiles), result({ ...launched, id: CLAUDE_ID }));
    const claude = new MultiZenProvider(config, 'claude', f.factory);
    expect(await claude.connectInfo()).toMatchObject({ profileId: CLAUDE_ID, name: 'claude' });
    expect(f.callTool.mock.calls.map(([name, args]) => [name, args])).toEqual([['list_profiles', {}], ['launch_profile', { profile_id: CLAUDE_ID }]]);
    expect(config.profiles.codex.id).toBe(PROFILE_ID);
  });
  it('rejects duplicate unpinned names before launching anything', async () => {
    delete config.profiles.codex.id;
    const f = fixture(result({ profiles: [{ id: PROFILE_ID, name: 'codex', isRunning: true }, { id: CLAUDE_ID, name: 'codex', isRunning: false }] }));
    await expect(f.provider.connectInfo()).rejects.toMatchObject({ code: 'PROFILE_AMBIGUOUS' });
    expect(f.callTool).toHaveBeenCalledTimes(1);
  });
  it('uses exact case-sensitive names and never substitutes when a pinned profile is renamed', async () => {
    delete config.profiles.codex.id;
    const f = fixture(result({ profiles: [{ id: PROFILE_ID, name: 'Codex', isRunning: true }] }));
    await expect(f.provider.inspect()).rejects.toMatchObject({ code: 'PROFILE_NOT_FOUND' });
    config.profiles.codex.id = PROFILE_ID;
    const pinned = fixture(result(profiles));
    expect(await pinned.provider.inspect()).toMatchObject({ profileId: PROFILE_ID, name: 'renamed codex' });
  });
  it('returns only safe discovery fields for initialization', async () => {
    const f = fixture(result(profiles));
    expect(await f.provider.discoverProfiles()).toEqual([{ id: CLAUDE_ID, name: 'claude', isRunning: false }, { id: PROFILE_ID, name: 'renamed codex', isRunning: true }]);
    expect(f.callTool.mock.calls.map(([name]) => name)).toEqual(['list_profiles']);
  });
  it('rejects a renamed pinned profile that overlaps the other unpinned alias', async () => {
    const f = fixture(result({ profiles: [{ id: PROFILE_ID, name: 'claude', isRunning: true }] }));
    await expect(f.provider.connectInfo()).rejects.toMatchObject({ code: 'PROFILE_BINDINGS_OVERLAP' });
    expect(f.callTool).toHaveBeenCalledTimes(1);
  });
});

describe('local endpoint validation', () => {
  it('accepts literal loopback HTTP CDP origins and normalized MCP paths', () => {
    expect(normalizeMcpUrl('http://[::1]:7777/mcp/')).toBe('http://[::1]:7777/mcp');
    expect(normalizeCdpEndpoint('http://127.0.0.1:9333/')).toBe('http://127.0.0.1:9333');
    expect(normalizeCdpEndpoint('ws://127.0.0.1:9333/devtools/browser/id')).toBe('ws://127.0.0.1:9333/devtools/browser/id');
  });
  it.each(['http://localhost:7777/mcp', 'http://2130706433:7777/mcp', 'http://secret@127.0.0.1:7777/mcp', 'http://127.0.0.1:7777/mcp?token=secret', 'http://127.0.0.1:7777/other', 'file:///mcp'])('blocks unsafe MCP addresses', url => { expect(() => normalizeMcpUrl(url)).toThrow(); });
  it.each(['http://example.test:9333', 'http://localhost:9333', 'http://127.0.0.1:9333/path', 'http://127.0.0.1:9333/?secret=x', 'ws://127.0.0.1:9333/not-browser', 'http://user:secret@127.0.0.1:9333'])('blocks unsafe CDP addresses', url => { expect(() => normalizeCdpEndpoint(url)).toThrow(); });
});

it('uses the official StreamableHTTP handshake and bearer header against a local MCP fixture', async () => {
  const requests: Array<{ method: string; params?: Record<string, unknown>; auth?: string }> = [];
  const server = createServer((request, response) => { void (async () => {
    if (request.method !== 'POST') { response.writeHead(405).end(); return; }
    let body = ''; for await (const chunk of request) body += chunk;
    const message = JSON.parse(body) as { id?: number; method: string; params?: Record<string, unknown> };
    requests.push({ method: message.method, params: message.params, auth: request.headers.authorization });
    if (message.id === undefined) { response.writeHead(202).end(); return; }
    const payload = message.method === 'initialize' ? { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } }
      : result(message.params?.name === 'list_profiles' ? profiles : launched);
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: payload }));
  })().catch(() => response.writeHead(500).end()); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const port = (server.address() as { port: number }).port;
    const value = await new MultiZenProvider({ ...config, mcpUrl: `http://127.0.0.1:${port}/mcp` }).connectInfo();
    expect(value.profileId).toBe(PROFILE_ID);
    expect(requests.filter(request => request.method === 'tools/call').map(request => request.params)).toEqual([{ name: 'list_profiles', arguments: {} }, { name: 'launch_profile', arguments: { profile_id: PROFILE_ID } }]);
    expect(requests.every(request => request.auth === 'Bearer fixture-token')).toBe(true);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
