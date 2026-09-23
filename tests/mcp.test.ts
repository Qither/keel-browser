import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer, type BrowserAdapter } from '../src/mcp.js';
import { KeelError, type ClientId } from '../src/contracts.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

async function connect(result: unknown = { sessionId: 's', tabs: [{ tabId: 't' }] }, clientId: ClientId = 'codex') {
  const call = vi.fn<BrowserAdapter['call']>().mockResolvedValue(result);
  const server = createMcpServer({ call, heartbeat: async () => undefined, closeAll: async () => undefined }, clientId);
  const client = new Client({ name: 'keel-test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  cleanups.push(async () => { await client.close(); await server.close(); });
  return { client, call };
}

describe('MCP protocol', () => {
  it('initializes and lists the complete safe tool surface without browser access', async () => {
    const { client, call } = await connect();
    const { tools } = await client.listTools();
    expect(tools.map(tool => tool.name)).toEqual([
      'browser_open', 'browser_status', 'browser_close', 'browser_tabs', 'browser_new_tab', 'browser_close_tab',
      'browser_navigate', 'browser_snapshot', 'browser_click', 'browser_fill', 'browser_press', 'browser_scroll', 'browser_screenshot',
    ]);
    expect(tools.find(tool => tool.name === 'browser_open')?.description).toContain('MultiZen codex');
    expect(client.getInstructions()).toContain('MultiZen codex');
    for (const tool of tools) {
      expect(tool.inputSchema.additionalProperties).toBe(false);
      for (const property of ['clientId', 'client', 'profileAlias', 'profileId', 'capability', 'endpoint', 'apiKey', 'token', 'tokenFile', 'mcpUrl', 'evaluate', 'path', 'output']) {
        expect(tool.inputSchema.properties).not.toHaveProperty(property);
      }
    }
    expect(call).not.toHaveBeenCalled();
  });

  it.each(['claude-cli', 'claude-desktop'] as const)('binds %s instructions to claude without adding model-selectable routing fields', async clientId => {
    const { client, call } = await connect(undefined, clientId);
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(13);
    expect(tools.find(tool => tool.name === 'browser_open')?.description).toContain('MultiZen claude');
    expect(client.getInstructions()).toContain(`This ${clientId} instance`);
    expect(client.getInstructions()).toContain('MultiZen claude');
    const result = await client.callTool({ name: 'browser_open', arguments: { clientId: 'codex' } });
    expect(result.isError).toBe(true);
    expect(call).not.toHaveBeenCalled();
    await client.callTool({ name: 'browser_open', arguments: {} });
    expect(call).toHaveBeenCalledWith('open', { mode: 'mcp' });
  });

  it('opens an MCP session and returns structured public data', async () => {
    const { client, call } = await connect();
    const result = await client.callTool({ name: 'browser_open', arguments: { url: 'https://example.com' } });
    expect(call).toHaveBeenCalledWith('open', { mode: 'mcp', url: 'https://example.com' });
    expect(result.structuredContent).toEqual({ sessionId: 's', tabs: [{ tabId: 't' }] });
    expect(result.isError).not.toBe(true);
  });

  it.each([
    { name: 'browser_open', arguments: { profileId: 'other' } },
    { name: 'browser_open', arguments: { url: 'file:///private' } },
    { name: 'browser_click', arguments: { sessionId: 's', tabId: 't' } },
    { name: 'browser_scroll', arguments: { sessionId: 's', tabId: 't', direction: 'down', amount: 10_001 } },
    { name: 'browser_screenshot', arguments: { sessionId: 's', tabId: 't', output: 'secret.txt' } },
  ])('rejects unsupported arguments before browser access: $name', async request => {
    const { client, call } = await connect();
    const result = await client.callTool(request);
    expect(result.isError).toBe(true);
    expect(call).not.toHaveBeenCalled();
  });

  it('returns native MCP image content without duplicating base64 in structured data', async () => {
    const { client, call } = await connect({ data: 'aW1hZ2U=', mimeType: 'image/png', tabId: 't' });
    const result = await client.callTool({ name: 'browser_screenshot', arguments: { sessionId: 's', tabId: 't' } });
    expect(call).toHaveBeenCalledWith('screenshot', { sessionId: 's', tabId: 't' });
    expect(result.content).toEqual([{ type: 'image', data: 'aW1hZ2U=', mimeType: 'image/png' }]);
    expect(result.structuredContent).toEqual({ mimeType: 'image/png', tabId: 't' });
  });

  it('keeps stale-reference failures actionable and unexpected transport details private', async () => {
    const { client, call } = await connect();
    call.mockRejectedValueOnce(new KeelError('STALE_REFERENCE', 'Take a new snapshot after navigation.'));
    const request = { name: 'browser_click', arguments: { sessionId: 's', tabId: 't', ref: 'r1' } };
    const stale = await client.callTool(request);
    expect(stale.isError).toBe(true);
    expect(stale.structuredContent).toEqual({ error: { code: 'STALE_REFERENCE', message: 'Take a new snapshot after navigation.' } });
    call.mockRejectedValueOnce(new Error('secret-token ws://127.0.0.1:9222/secret'));
    const failed = await client.callTool(request);
    expect(failed.isError).toBe(true);
    expect(JSON.stringify(failed)).not.toContain('secret-token');
    expect(JSON.stringify(failed)).not.toContain('9222');
    expect(call).toHaveBeenCalledTimes(2);
  });
});
