#!/usr/bin/env node
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { BrowserClient } from './client.js';
import { parseClientId, profileForClient, safeError, VERSION, type ClientId } from './contracts.js';

export interface BrowserAdapter {
  call(method: string, params?: Record<string, unknown>): Promise<unknown>;
  heartbeat(): Promise<void>;
  closeAll(): Promise<void>;
}

const id = z.string().min(1).max(200);
const url = z.string().url().max(8192).refine(value => {
  const protocol = new URL(value).protocol;
  return protocol === 'http:' || protocol === 'https:';
}, 'Only HTTP and HTTPS URLs are supported.');
const session = { sessionId: id };
const tab = { ...session, tabId: id };
const element = { ...tab, ref: id };

export const toolDefinitions: Array<{ method: string; description: string; shape: z.ZodRawShape; readOnly?: boolean }> = [
  { method: 'open', description: 'Open a task session with a new owned tab in this client’s existing MultiZen profile.', shape: { url: url.optional() } },
  { method: 'status', description: 'Read the state of an owned browser session.', shape: session, readOnly: true },
  { method: 'close', description: 'Close only this session’s owned tabs. Keep the shared MultiZen profile running.', shape: session },
  { method: 'tabs', description: 'List only tabs owned by this session.', shape: session, readOnly: true },
  { method: 'new_tab', description: 'Create another owned tab in this session.', shape: { ...session, url: url.optional() } },
  { method: 'close_tab', description: 'Close one tab owned by this session.', shape: tab },
  { method: 'navigate', description: 'Navigate an owned tab to an HTTP or HTTPS URL. Local management endpoints are blocked.', shape: { ...tab, url } },
  { method: 'snapshot', description: 'Read page text and elements with opaque references. Obtain new references after navigation.', shape: tab, readOnly: true },
  { method: 'click', description: 'Click an element reference from the current snapshot of this owned tab.', shape: element },
  { method: 'fill', description: 'Fill an input identified by a current snapshot reference.', shape: { ...element, text: z.string().max(100_000) } },
  { method: 'press', description: 'Press a key on an element identified by a current snapshot reference.', shape: { ...element, key: z.string().min(1).max(100) } },
  { method: 'scroll', description: 'Scroll an owned tab in one direction by a bounded number of pixels.', shape: { ...tab, direction: z.enum(['up', 'down', 'left', 'right']), amount: z.number().int().min(1).max(10_000).optional() } },
  { method: 'screenshot', description: 'Capture an owned tab as a PNG image without writing an arbitrary host file.', shape: tab, readOnly: true },
];

function toolResult(result: unknown, method: string): CallToolResult {
  const value = result !== null && typeof result === 'object' && !Array.isArray(result)
    ? result as Record<string, unknown>
    : { result };
  if (method === 'screenshot' && typeof value.data === 'string' && value.mimeType === 'image/png') {
    const { data, ...metadata } = value;
    return { content: [{ type: 'image', data, mimeType: 'image/png' }], structuredContent: metadata };
  }
  return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value };
}

export function createMcpServer(client: BrowserAdapter, clientId: ClientId = 'codex'): McpServer {
  const selected = parseClientId(clientId);
  const profileAlias = profileForClient(selected);
  const server = new McpServer({ name: 'keel-browser', version: VERSION }, {
    instructions: `Use only this router for browser work. This ${selected} instance uses the existing MultiZen ${profileAlias} profile; tasks using that profile share login state. Open a session, use its returned sessionId and tabId, and close it when finished. A session cannot access other sessions’ tabs. Never retry a timed-out mutation automatically.`,
  });
  for (const definition of toolDefinitions) {
    const inputSchema = z.object(definition.shape).strict();
    server.registerTool(`browser_${definition.method}`, {
      description: definition.method === 'open'
        ? `Open a task session with a new owned tab in the existing MultiZen ${profileAlias} profile.`
        : definition.description,
      inputSchema,
      annotations: {
        readOnlyHint: definition.readOnly === true,
        destructiveHint: definition.readOnly !== true && !['open', 'new_tab'].includes(definition.method),
        idempotentHint: definition.readOnly === true,
        openWorldHint: true,
      },
    }, async (args): Promise<CallToolResult> => {
      try {
        const params: Record<string, unknown> = { ...args };
        if (definition.method === 'open') params.mode = 'mcp';
        return toolResult(await client.call(definition.method, params), definition.method);
      } catch (error) {
        const failure = { error: safeError(error) };
        return { isError: true, content: [{ type: 'text', text: JSON.stringify(failure) }], structuredContent: failure };
      }
    });
  }
  return server;
}

/** The adapter owns only capabilities created during this MCP process. */
export async function startMcp(home?: string, clientId: ClientId = 'codex'): Promise<{ close(): Promise<void> }> {
  const selected = parseClientId(clientId);
  const client = new BrowserClient({ persistent: false, home, clientId: selected });
  let closing = false;
  const pending = new Set<Promise<unknown>>();
  const server = createMcpServer({
    heartbeat: () => client.heartbeat(),
    closeAll: () => client.closeAll(),
    call: async (method, params) => {
      if (closing) throw new Error('MCP transport is closing.');
      const operation = client.call(method, params);
      pending.add(operation);
      try { return await operation; }
      finally {
        pending.delete(operation);
        // An open already in flight can acquire a capability after shutdown begins.
        if (closing && method === 'open') await client.closeAll().catch(() => undefined);
      }
    },
  }, selected);
  const transport = new StdioServerTransport();
  let shutdownPromise: Promise<void> | undefined;
  let heartbeatBusy = false;
  const heartbeat = setInterval(() => {
    if (heartbeatBusy || shutdownPromise) return;
    heartbeatBusy = true;
    void client.heartbeat().catch(() => undefined).finally(() => { heartbeatBusy = false; });
  }, 30_000);
  heartbeat.unref();

  const shutdown = (): Promise<void> => {
    if (shutdownPromise) return shutdownPromise;
    closing = true;
    clearInterval(heartbeat);
    // Defer the body so an onclose callback cannot re-enter before this is assigned.
    shutdownPromise = Promise.resolve().then(async () => {
      process.stdin.off('end', onInputEnd);
      process.stdin.off('close', onInputEnd);
      process.off('SIGINT', onSignal);
      process.off('SIGTERM', onSignal);
      await server.close().catch(() => undefined);
      let timeout: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          Promise.allSettled([...pending]).then(() => client.closeAll()).catch(() => undefined),
          new Promise<void>(resolveTimeout => { timeout = setTimeout(resolveTimeout, 5000); }),
        ]);
      } finally {
        if (timeout) clearTimeout(timeout);
      }
    });
    return shutdownPromise;
  };
  // A stalled broker fetch must not keep the stdio child alive past the cleanup bound.
  const onInputEnd = (): void => { void shutdown().finally(() => process.exit(0)); };
  const onSignal = (): void => { void shutdown().finally(() => process.exit(0)); };
  server.server.onclose = () => { if (!closing) onInputEnd(); };
  process.stdin.once('end', onInputEnd);
  process.stdin.once('close', onInputEnd);
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  try {
    await server.connect(transport);
  } catch (error) {
    await shutdown();
    throw error;
  }
  return { close: shutdown };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void Promise.resolve().then(() => startMcp(undefined, parseClientId(process.env.KEEL_BROWSER_CLIENT ?? 'codex'))).catch(error => {
    process.stderr.write(`${JSON.stringify({ error: safeError(error) })}\n`);
    process.exitCode = 1;
  });
}
