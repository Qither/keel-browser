import { readFile } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { KeelError, VERSION, type KeelConfig, type ProfileAlias, type ProfileBinding } from './contracts.js';

export interface ProfileInspection { profileId: string; name: string; status: 'Active' | 'Inactive' }
export interface ConnectionInfo { profileId: string; name: string; cdpEndpoint: string }
export interface DiscoveredProfile { id: string; name: string; isRunning: boolean }
export const isProfileId = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
export function validateProfileBindings(profiles: KeelConfig['profiles']): void {
  for (const alias of ['codex', 'claude'] as const) {
    const binding = profiles?.[alias];
    if (!binding || typeof binding.name !== 'string' || !binding.name.trim() || binding.name.length > 256 || (binding.id !== undefined && !isProfileId(binding.id))) throw new KeelError('INVALID_CONFIG', 'Invalid MultiZen browser profile binding.');
  }
  if (profiles.codex.name === profiles.claude.name || (profiles.codex.id && profiles.claude.id && profiles.codex.id.toLowerCase() === profiles.claude.id.toLowerCase())) {
    throw new KeelError('PROFILE_BINDINGS_OVERLAP', 'Codex and Claude must use different MultiZen profiles.');
  }
}
export function resolveProfileBinding(binding: ProfileBinding, profiles: DiscoveredProfile[]): DiscoveredProfile {
  const matches = profiles.filter(profile => binding.id ? profile.id === binding.id : profile.name === binding.name);
  if (matches.length === 0) throw new KeelError('PROFILE_NOT_FOUND', 'The configured MultiZen browser profile was not found. Check its binding.');
  if (matches.length !== 1) throw new KeelError('PROFILE_AMBIGUOUS', 'Multiple MultiZen profiles match this binding. Pin one existing profile ID in the local configuration.');
  return matches[0]!;
}
export interface NativeMcpClient {
  connect(signal: AbortSignal): Promise<void>;
  callTool(name: 'list_profiles' | 'launch_profile', args: Record<string, unknown>, signal: AbortSignal): Promise<unknown>;
  close(): Promise<void>;
}
export type NativeMcpClientFactory = (url: string, token: string, timeoutMs: number) => NativeMcpClient;
type JsonObject = Record<string, unknown>;
const object = (value: unknown): value is JsonObject => !!value && typeof value === 'object' && !Array.isArray(value);
const invalidResponse = () => new KeelError('MULTIZEN_INVALID_RESPONSE', 'MultiZen returned an unsupported response. Check the installed version.');

/** Literal loopback only, with a fixed MCP path and no credentials or query. */
export function normalizeMcpUrl(value: string): string {
  try {
    if (!/^https?:\/\/(127\.0\.0\.1|\[::1\])(?::\d+)?\/mcp\/?$/i.test(value)) throw new Error();
    const url = new URL(value);
    if (url.port === '0') throw new Error();
    url.pathname = '/mcp';
    return url.href;
  } catch { throw new KeelError('INVALID_CONFIG', 'MultiZen MCP must use a literal loopback HTTP(S) address ending in /mcp.'); }
}

export function normalizeCdpEndpoint(value: unknown): string {
  try {
    if (typeof value !== 'string') throw new Error();
    if (!/^(https?|wss?):\/\/(127\.0\.0\.1|\[::1\]):\d+(?:\/|$)/i.test(value)) throw new Error();
    const url = new URL(value);
    if (url.username || url.password || url.search || url.hash || !url.port || url.port === '0') throw new Error();
    if (url.protocol === 'http:' || url.protocol === 'https:') {
      if (url.pathname !== '/') throw new Error();
      return url.origin;
    }
    if (!/^\/devtools\/browser\/[^/]+$/.test(url.pathname)) throw new Error();
    return url.href;
  } catch { throw new KeelError('INVALID_CDP_ENDPOINT', 'MultiZen returned an invalid local browser endpoint.'); }
}

async function readToken(config: KeelConfig): Promise<{ token: string; source: 'environment' | 'file' }> {
  const fromEnv = process.env[config.tokenEnv]?.trim();
  let token: string;
  let source: 'environment' | 'file';
  if (fromEnv) { token = fromEnv; source = 'environment'; }
  else {
    try { token = (await readFile(config.tokenFile, 'utf8')).trim(); source = 'file'; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new KeelError('TOKEN_MISSING', 'MultiZen MCP token is unavailable. Start MultiZen or set the configured token environment variable.');
      throw new KeelError('TOKEN_FILE_UNAVAILABLE', 'Cannot read the configured MultiZen MCP token file.');
    }
  }
  if (!token) throw new KeelError('TOKEN_MISSING', 'MultiZen MCP token is empty.');
  if (token.length > 16_384 || !/^[!-~]+$/.test(token)) throw new KeelError('INVALID_TOKEN', 'The configured MultiZen MCP token has an invalid format.');
  return { token, source };
}

export async function tokenStatus(config: KeelConfig): Promise<{ configured: boolean; source: 'environment' | 'file' | 'missing' }> {
  try { const value = await readToken(config); return { configured: true, source: value.source }; }
  catch { return { configured: false, source: 'missing' }; }
}

const createNativeClient: NativeMcpClientFactory = (url, token, timeoutMs) => {
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { Authorization: `Bearer ${token}` }, redirect: 'error' },
    reconnectionOptions: { maxRetries: 0, initialReconnectionDelay: 1000, maxReconnectionDelay: 1000, reconnectionDelayGrowFactor: 1 },
  });
  const client = new Client({ name: 'keel-browser-provider', version: VERSION });
  return {
    connect: signal => client.connect(transport, { timeout: timeoutMs, signal }),
    callTool: (name, args, signal) => client.callTool({ name, arguments: args }, undefined, { timeout: timeoutMs, signal }),
    async close() { await Promise.allSettled([client.close(), transport.close()]); },
  };
};

function parseResult(result: unknown): JsonObject {
  if (!object(result)) throw invalidResponse();
  if (result.isError === true) throw new KeelError('MULTIZEN_TOOL_ERROR', 'MultiZen rejected the profile request. Check its application status.');
  let payload: unknown = result.structuredContent;
  if (payload === undefined) {
    if (!Array.isArray(result.content)) throw invalidResponse();
    const texts = result.content.filter(block => object(block) && block.type === 'text');
    if (texts.length !== 1 || !object(texts[0]) || typeof texts[0].text !== 'string') throw invalidResponse();
    try { payload = JSON.parse(texts[0].text); } catch { throw invalidResponse(); }
  }
  if (!object(payload)) throw invalidResponse();
  return payload;
}

function safeProviderError(error: unknown, timedOut: boolean): KeelError {
  if (timedOut) return new KeelError('MULTIZEN_TIMEOUT', 'MultiZen MCP timed out. The profile request was not retried.');
  if (error instanceof KeelError) return error;
  const status = object(error) ? error.code : undefined;
  if (status === 401 || status === 403 || (error instanceof Error && error.name === 'UnauthorizedError')) return new KeelError('MULTIZEN_AUTH_FAILED', 'MultiZen rejected MCP authentication.');
  if (status === -32601) return new KeelError('MULTIZEN_TOOL_UNAVAILABLE', 'MultiZen profile tools are unavailable. Check the installed version.');
  return new KeelError('MULTIZEN_UNAVAILABLE', 'Cannot complete the MultiZen MCP request. Check the application and MCP address.');
}

/** Only metadata and idempotent launch for the selected existing profile are exposed. */
export class MultiZenProvider {
  private readonly url: string;
  private connecting?: Promise<ConnectionInfo>;
  constructor(private readonly config: KeelConfig, private readonly alias: ProfileAlias = 'codex', private readonly factory: NativeMcpClientFactory = createNativeClient) {
    if (config.provider !== 'multizen' || !['codex', 'claude'].includes(alias)) throw new KeelError('INVALID_CONFIG', 'A configured MultiZen browser profile is required.');
    validateProfileBindings(config.profiles);
    if (!Number.isSafeInteger(config.providerTimeoutMs) || config.providerTimeoutMs <= 0) throw new KeelError('INVALID_CONFIG', 'Invalid MultiZen provider timeout.');
    this.url = normalizeMcpUrl(config.mcpUrl);
  }
  discoverProfiles(): Promise<DiscoveredProfile[]> { return this.withClient((client, signal) => this.discoverWith(client, signal)); }
  inspect(): Promise<ProfileInspection> { return this.withClient((client, signal) => this.inspectWith(client, signal)); }
  connectInfo(): Promise<ConnectionInfo> {
    if (!this.connecting) {
      const pending = this.withClient(async (client, signal) => {
        const profile = await this.inspectWith(client, signal);
        signal.throwIfAborted();
        const result = parseResult(await client.callTool('launch_profile', { profile_id: profile.profileId }, signal));
        signal.throwIfAborted();
        if (result.id !== profile.profileId) throw new KeelError('PROFILE_MISMATCH', 'MultiZen returned a different profile.');
        return { profileId: profile.profileId, name: profile.name, cdpEndpoint: normalizeCdpEndpoint(result.cdpEndpoint) };
      });
      this.connecting = pending;
      void pending.finally(() => { if (this.connecting === pending) this.connecting = undefined; }).catch(() => {});
    }
    return this.connecting;
  }
  private async inspectWith(client: NativeMcpClient, signal: AbortSignal): Promise<ProfileInspection> {
    const profiles = await this.discoverWith(client, signal);
    const profile = resolveProfileBinding(this.config.profiles[this.alias], profiles);
    const otherBinding = this.config.profiles[this.alias === 'codex' ? 'claude' : 'codex'];
    if (otherBinding.id ? otherBinding.id === profile.id : otherBinding.name === profile.name) {
      throw new KeelError('PROFILE_BINDINGS_OVERLAP', 'Codex and Claude must use different MultiZen profiles.');
    }
    return { profileId: profile.id, name: profile.name, status: profile.isRunning ? 'Active' : 'Inactive' };
  }
  private async discoverWith(client: NativeMcpClient, signal: AbortSignal): Promise<DiscoveredProfile[]> {
    signal.throwIfAborted();
    const result = parseResult(await client.callTool('list_profiles', {}, signal));
    signal.throwIfAborted();
    if (!Array.isArray(result.profiles)) throw invalidResponse();
    return result.profiles.map(profile => {
      if (!object(profile) || !isProfileId(profile.id) || typeof profile.name !== 'string' || typeof profile.isRunning !== 'boolean') throw invalidResponse();
      return { id: profile.id, name: profile.name, isRunning: profile.isRunning };
    });
  }
  private async withClient<T>(operation: (client: NativeMcpClient, signal: AbortSignal) => Promise<T>): Promise<T> {
    const { token } = await readToken(this.config);
    let client: NativeMcpClient | undefined;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      client = this.factory(this.url, token, this.config.providerTimeoutMs);
      const connection = client;
      const work = (async () => { await connection.connect(controller.signal); controller.signal.throwIfAborted(); return operation(connection, controller.signal); })();
      return await Promise.race([work, new Promise<never>((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new KeelError('MULTIZEN_TIMEOUT', 'MultiZen MCP timed out. The profile request was not retried.')); }, this.config.providerTimeoutMs);
      })]);
    } catch (error) { throw safeProviderError(error, controller.signal.aborted); }
    finally {
      if (timer) clearTimeout(timer);
      controller.abort();
      if (client) {
        let closeTimer: ReturnType<typeof setTimeout> | undefined;
        try { await Promise.race([client.close().catch(() => {}), new Promise<void>(resolve => { closeTimer = setTimeout(resolve, 1000); })]); }
        finally { if (closeTimer) clearTimeout(closeTimer); }
      }
    }
  }
}
