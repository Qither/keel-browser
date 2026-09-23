// Explicit live acceptance: opens only new test tabs in the selected existing MultiZen
// profile. Does not stop the shared browser or alter its saved configuration.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { BrowserClient } from '../dist/client.js';
import { doctor, loadConfig, getHome } from '../dist/config.js';
import { parseClientId, profileForClient, safeError } from '../dist/contracts.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const { values } = parseArgs({ options: { client: { type: 'string' } } });
const clientId = parseClientId(values.client ?? process.env.KEEL_BROWSER_CLIENT ?? 'codex');
const companionClientId = clientId === 'claude-cli' ? 'claude-desktop' : clientId;
const report = await doctor(loadConfig(), clientId);
if (!report.ok) {
  console.log(JSON.stringify({ ok: false, live: true, diagnostic: report }));
  process.exitCode = 2;
} else {
  const server = createServer((request, response) => {
    response.setHeader('content-type', 'text/html; charset=utf-8');
    response.end('<!doctype html><title>keel-browser 验收</title><h1>keel-browser controlled test</h1><input aria-label="Test value"><button onclick="document.querySelector(\'output\').textContent=\'PASS \'+document.querySelector(\'input\').value">Run test</button><output></output>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/keel-browser-test`;
  const first = new BrowserClient({ clientId });
  const second = new BrowserClient({ clientId: companionClientId });
  let mcp;
  try {
    const a = await first.call('open', { url });
    const b = await second.call('open', { url });
    assert.equal(a.profileId, report.profileId);
    assert.equal(b.profileId, report.profileId);
    assert.equal(a.clientId, clientId);
    assert.equal(b.clientId, companionClientId);
    const page = { sessionId: a.sessionId, tabId: a.tabs[0].tabId };
    const snapshot = await first.call('snapshot', page);
    await first.call('fill', { ...page, ref: snapshot.elements.find(x => x.label === 'Test value').ref, text: 'keel' });
    await first.call('click', { ...page, ref: snapshot.elements.find(x => x.text === 'Run test').ref });
    assert.match((await first.call('snapshot', page)).text, /PASS keel/);
    const screenshot = await first.call('screenshot', page);
    const png = Buffer.from(screenshot.data, 'base64');
    assert.equal(png.subarray(1, 4).toString(), 'PNG');
    assert.ok(png.readUInt32BE(16) > 0 && png.readUInt32BE(20) > 0);
    await mkdir(resolve('artifacts'), { recursive: true });
    await writeFile(resolve('artifacts/multizen-live.png'), png);
    await first.closeAll();
    assert.equal((await second.call('status', { sessionId: b.sessionId })).status, 'active');
    await second.closeAll();
    mcp = new Client({ name: 'keel-live-acceptance', version: '1.0.0' });
    const transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('../dist/cli.js', import.meta.url)), 'mcp', '--client', companionClientId], env: { ...Object.fromEntries(Object.entries(process.env).filter(([, value]) => typeof value === 'string')), KEEL_BROWSER_HOME: getHome() }, stderr: 'pipe' });
    await mcp.connect(transport);
    const opened = await mcp.callTool({ name: 'browser_open', arguments: { url } });
    assert.notEqual(opened.isError, true);
    const owned = opened.structuredContent;
    assert.equal(owned.clientId, companionClientId);
    assert.equal(owned.profileId, report.profileId);
    const observed = await mcp.callTool({ name: 'browser_snapshot', arguments: { sessionId: owned.sessionId, tabId: owned.tabs[0].tabId } });
    assert.notEqual(observed.isError, true);
    const image = await mcp.callTool({ name: 'browser_screenshot', arguments: { sessionId: owned.sessionId, tabId: owned.tabs[0].tabId } });
    assert.equal(image.content[0].type, 'image');
    await mcp.callTool({ name: 'browser_close', arguments: { sessionId: owned.sessionId } });
    console.log(JSON.stringify({ ok: true, live: true, provider: 'multizen', clientId, companionClientId, profileAlias: profileForClient(clientId), profileName: a.profileName, checks: ['client/profile binding', 'two live sessions', 'snapshot/fill/click/screenshot', 'close preserves other session', 'native MCP open/snapshot/image/close'] }));
  } catch (error) {
    console.log(JSON.stringify({ ok: false, live: true, error: safeError(error) }));
    process.exitCode = 1;
  } finally {
    await mcp?.close().catch(() => {});
    await Promise.allSettled([first.closeAll(), second.closeAll()]);
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}
