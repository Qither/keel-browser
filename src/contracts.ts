import { createRequire } from 'node:module';

// Single source of truth for the published version, so a release bump never
// leaves the MCP handshake reporting a stale number. `dist/` sits one level
// below the package root in both a source checkout and an npm install.
export const VERSION: string = createRequire(import.meta.url)('../package.json').version;

export const CLIENT_IDS = ['codex', 'claude-cli', 'claude-desktop'] as const;
export type ClientId = typeof CLIENT_IDS[number];
export type ProfileAlias = 'codex' | 'claude';
export interface ProfileBinding { name: string; id?: string }
export function profileForClient(clientId: ClientId): ProfileAlias {
  return clientId === 'codex' ? 'codex' : 'claude';
}
export function parseClientId(value: unknown = 'codex'): ClientId {
  if (!CLIENT_IDS.includes(value as ClientId)) throw new KeelError('INVALID_CLIENT', 'Client must be codex, claude-cli, or claude-desktop.');
  return value as ClientId;
}

export interface KeelConfig {
  provider: 'multizen';
  mcpUrl: string;
  tokenEnv: string;
  tokenFile: string;
  settingsFile?: string;
  profiles: Record<ProfileAlias, ProfileBinding>;
  cliIdleMs: number;
  mcpLeaseMs: number;
  operationTimeoutMs: number;
  providerTimeoutMs: number;
}

export interface RpcRequest {
  method: string;
  clientId?: ClientId;
  sessionId?: string;
  capability?: string;
  params?: Record<string, unknown>;
}

export interface PublicTab { tabId: string; url?: string; title?: string }
export interface PublicSession {
  sessionId: string;
  clientId: ClientId;
  profileAlias: ProfileAlias;
  profileId: string;
  profileName: string;
  status: 'active' | 'disconnected' | 'paused' | 'closing' | 'closed';
  tabs: PublicTab[];
}
export interface OpenResult extends PublicSession { capability: string }
export interface RouterEngine {
  call(request: RpcRequest): Promise<unknown>;
  sweep(): Promise<void>;
  shutdown(): Promise<void>;
  setBrokerPort?(port: number): void;
}

export class KeelError extends Error {
  constructor(public code: string, message: string) { super(message); this.name = 'KeelError'; }
}
export function safeError(error: unknown): { code: string; message: string } {
  return error instanceof KeelError
    ? { code: error.code, message: error.message }
    : { code: 'INTERNAL_ERROR', message: 'Operation failed. Check the local diagnostic status.' };
}
