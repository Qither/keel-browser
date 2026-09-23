// Opt-in integration fixture. Uses a disposable Chrome data directory and a fake
// MultiZen MCP server; it never contacts the user's MultiZen instance or personal Chrome.
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { BrowserClient, stopBroker, brokerStatus } from '../dist/client.js';

const fixtureProfiles = {
  codex: { id: '00000000-0000-4000-8000-000000000001', name: 'codex' },
  claude: { id: '00000000-0000-4000-8000-000000000002', name: 'claude' },
};
function chromeExecutable() {
  if (process.env.KEEL_TEST_CHROME) {
    if (existsSync(process.env.KEEL_TEST_CHROME)) return process.env.KEEL_TEST_CHROME;
    throw new Error('KEEL_TEST_CHROME does not point to an existing Chrome/Chromium executable.');
  }
  const candidates = [
    ...[process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA]
      .filter(Boolean).map(base => join(base, 'Google', 'Chrome', 'Application', 'chrome.exe')),
    ...(process.platform === 'darwin' ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'] : []),
    ...(process.platform === 'linux' ? ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'] : []),
  ];
  const executable = candidates.find(candidate => existsSync(candidate));
  if (!executable) throw new Error('Chrome/Chromium was not found in standard installation locations. Set KEEL_TEST_CHROME to its executable path.');
  return executable;
}
const executable = chromeExecutable();
const root = await mkdtemp(join(tmpdir(), 'keel-browser-smoke-'));
const home = join(root, 'router');
await mkdir(home);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const cleanup = [];
const calls = [];
let forbiddenHits = 0;
const checks = [];
async function listen(handler) {
  const server = createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  cleanup.push(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return `http://127.0.0.1:${server.address().port}`;
}
async function launchFixtureBrowser(alias) {
  const profileDir = join(root, `disposable-chrome-${alias}`);
  const child = spawn(executable, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profileDir}`, '--no-first-run', '--no-default-browser-check', 'about:blank'], { windowsHide: true, stdio: 'ignore' });
  let spawnFailed = false;
  child.on('error', () => { spawnFailed = true; });
  cleanup.push(async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill();
    await Promise.race([new Promise(resolve => child.once('exit', resolve)), sleep(2000)]);
  });
  let cdp;
  let cdpHttp;
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    if (spawnFailed || child.exitCode !== null) throw new Error(`Disposable ${alias} Chrome failed to start. Check KEEL_TEST_CHROME.`);
    try {
      const [port, path] = (await readFile(join(profileDir, 'DevToolsActivePort'), 'utf8')).trim().split(/\r?\n/);
      cdp = `ws://127.0.0.1:${port}${path}`; cdpHttp = `http://127.0.0.1:${port}`; break;
    } catch { await sleep(100); }
  }
  assert.ok(cdp, `disposable ${alias} Chrome becomes ready`);
  const observer = await chromium.connectOverCDP(cdp);
  cleanup.push(() => observer.close()); // This fixture owns the entire disposable browser.
  const context = observer.contexts()[0];
  const manual = await context.newPage();
  return { child, cdpHttp, context, manual };
}
try {
  const codexBrowser = await launchFixtureBrowser('codex');
  const claudeBrowser = await launchFixtureBrowser('claude');
  const browsers = { codex: codexBrowser, claude: claudeBrowser };
  const { context, manual } = codexBrowser;
  let controlBase;
  controlBase = await listen(async (req, res) => {
    if (req.url?.startsWith('/protected-probe')) { forbiddenHits++; res.end('control endpoint'); return; }
    if (req.url !== '/mcp') { res.writeHead(404).end(); return; }
    if (req.headers.authorization !== 'Bearer fixture-key') { res.writeHead(401).end(); return; }
    const server = new McpServer({ name: 'mock-multizen', version: '1.0.0' });
    const result = data => ({ content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data });
    server.registerTool('list_profiles', { inputSchema: {} }, async args => {
      calls.push({ tool: 'list_profiles', arguments: args });
      return result({ profiles: Object.values(fixtureProfiles).map(profile => ({ ...profile, isRunning: true, password: 'never-expose-fixture-secret' })) });
    });
    server.registerTool('launch_profile', { inputSchema: { profile_id: z.enum([fixtureProfiles.codex.id, fixtureProfiles.claude.id]) } }, async args => {
      calls.push({ tool: 'launch_profile', arguments: args });
      const alias = Object.keys(fixtureProfiles).find(alias => fixtureProfiles[alias].id === args.profile_id);
      assert.ok(alias, 'only known fixture profile IDs can launch');
      return result({ ...fixtureProfiles[alias], cdpEndpoint: browsers[alias].cdpHttp, pid: browsers[alias].child.pid, isRunning: true });
    });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => { void transport.close().catch(() => {}); void server.close().catch(() => {}); });
    try {
      let body = ''; for await (const chunk of req) body += chunk;
      await server.connect(transport);
      await transport.handleRequest(req, res, body ? JSON.parse(body) : undefined);
    } catch {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    }
  });
  const site = await listen((req, res) => {
    if (req.url === '/redirect-control') { res.writeHead(302, { location: `${controlBase}/protected-probe?redirect` }); res.end(); return; }
    res.setHeader('content-type', 'text/html');
    res.end(`<!doctype html><html><head><title>Keel fixture</title></head><body>
      <h1>Fixture ${req.url}</h1><label>Name <input aria-label="Name" /></label>
      <input type="password" value="fixture-password" aria-label="Password" />
      <button onclick="document.querySelector('#result').textContent='Clicked '+document.querySelector('input').value">Run</button>
      <a target="_blank" href="/popup">Open popup</a>
      <a target="_blank" href="${controlBase}/protected-probe?popup">Blocked popup</a>
      <div id="result"></div><div style="height:1600px">Long page</div></body></html>`);
  });
  await manual.goto(`${site}/manual`);
  await claudeBrowser.manual.goto(`${site}/manual-claude`);
  const tokenFile = join(home, 'fixture-token');
  await writeFile(tokenFile, 'fixture-key');
  await writeFile(join(home, 'config.json'), JSON.stringify({ provider: 'multizen', mcpUrl: `${controlBase}/mcp`, profiles: { codex: { name: 'codex' }, claude: { name: 'claude' } }, tokenEnv: 'KEEL_SMOKE_MULTIZEN_TOKEN', tokenFile }));
  delete process.env.KEEL_SMOKE_MULTIZEN_TOKEN;
  cleanup.push(() => stopBroker(home));
  const first = new BrowserClient({ home, clientId: 'codex' });
  const second = new BrowserClient({ home, clientId: 'codex' });
  const [a, b] = await Promise.all([first.call('open', { url: `${site}/first` }), second.call('open', { url: `${site}/second` })]);
  assert.notEqual(a.tabs[0].tabId, b.tabs[0].tabId);
  assert.equal(a.profileId, fixtureProfiles.codex.id);
  assert.equal(a.profileAlias, 'codex');
  assert.equal(a.clientId, 'codex');
  assert.equal(JSON.stringify(a).includes('capability'), false);
  assert.equal(JSON.stringify(a).includes('never-expose'), false);
  const ap = { sessionId: a.sessionId, tabId: a.tabs[0].tabId };
  const bp = { sessionId: b.sessionId, tabId: b.tabs[0].tabId };
  await assert.rejects(first.call('snapshot', bp), { code: 'SESSION_NOT_OWNED' });
  await assert.rejects(first.call('snapshot', { ...ap, tabId: bp.tabId }), { code: 'INVALID_TAB' });
  checks.push('two sessions, ownership, private credentials');
  const claudeCliClient = new BrowserClient({ home, clientId: 'claude-cli' });
  const claudeDesktopClient = new BrowserClient({ home, clientId: 'claude-desktop' });
  const [claudeCliSession, claudeDesktopSession] = await Promise.all([
    claudeCliClient.call('open', { url: `${site}/claude-cli` }),
    claudeDesktopClient.call('open', { url: `${site}/claude-desktop` }),
  ]);
  for (const [clientId, session] of [['claude-cli', claudeCliSession], ['claude-desktop', claudeDesktopSession]]) {
    assert.equal(session.clientId, clientId);
    assert.equal(session.profileAlias, 'claude');
    assert.equal(session.profileId, fixtureProfiles.claude.id);
    assert.ok(claudeBrowser.context.pages().some(page => page.url() === `${site}/${clientId}`));
    assert.equal(context.pages().some(page => page.url() === `${site}/${clientId}`), false);
  }
  assert.ok(context.pages().some(page => page.url() === `${site}/first`));
  assert.equal(claudeBrowser.context.pages().some(page => page.url() === `${site}/first`), false);
  await assert.rejects(claudeCliClient.call('status', { sessionId: claudeDesktopSession.sessionId }), { code: 'SESSION_NOT_OWNED' });
  checks.push('codex uses its browser; claude-cli and claude-desktop share a separate profile with separate sessions');
  let snap = await first.call('snapshot', ap);
  assert.equal(JSON.stringify(snap).includes('fixture-password'), false);
  const inputRef = snap.elements.find(x => x.label === 'Name').ref;
  await first.call('fill', { ...ap, ref: inputRef, text: 'Alice' });
  await first.call('press', { ...ap, ref: inputRef, key: 'Tab' });
  await first.call('click', { ...ap, ref: snap.elements.find(x => x.text === 'Run').ref });
  snap = await first.call('snapshot', ap);
  assert.match(snap.text, /Clicked Alice/);
  assert.doesNotMatch((await second.call('snapshot', bp)).text, /Clicked Alice/);
  await first.call('scroll', { ...ap, direction: 'down', amount: 300 });
  const png = await first.call('screenshot', ap);
  assert.equal(Buffer.from(png.data, 'base64').subarray(1, 4).toString(), 'PNG');
  checks.push('snapshot, fill, press, click, scroll, PNG screenshot');
  const staleRef = snap.elements.find(x => x.text === 'Run').ref;
  await first.call('navigate', { ...ap, url: `${site}/after-navigation` });
  await assert.rejects(first.call('click', { ...ap, ref: staleRef }), { code: 'STALE_REF' });
  await assert.rejects(first.call('navigate', { ...ap, url: `${controlBase}/protected-probe` }), { code: 'NAVIGATION_BLOCKED' });
  // A real redirect regression: the management request must never reach the server.
  await first.call('navigate', { ...ap, url: `${site}/redirect-control` }).catch(() => {});
  assert.equal(forbiddenHits, 0, 'redirect cannot reach a control endpoint');
  await first.call('navigate', { ...ap, url: `${site}/popup-test` });
  snap = await first.call('snapshot', ap);
  await first.call('click', { ...ap, ref: snap.elements.find(x => x.text === 'Blocked popup').ref });
  await sleep(300);
  assert.equal(forbiddenHits, 0, 'popup first request cannot reach a control endpoint');
  await first.call('click', { ...ap, ref: snap.elements.find(x => x.text === 'Open popup').ref });
  await sleep(300);
  assert.ok((await first.call('tabs', { sessionId: a.sessionId })).some(tab => tab.url === `${site}/popup`));
  checks.push('stale refs, blocked direct/redirect/popup control requests, popup ownership');
  await first.closeAll();
  assert.equal((await second.call('status', { sessionId: b.sessionId })).status, 'active');
  assert.equal(manual.isClosed(), false);
  await manual.reload();
  assert.equal((await claudeCliClient.call('status', { sessionId: claudeCliSession.sessionId })).status, 'active');
  await second.closeAll();
  await claudeCliClient.closeAll();
  assert.equal((await claudeDesktopClient.call('status', { sessionId: claudeDesktopSession.sessionId })).status, 'active');
  assert.equal(claudeBrowser.manual.isClosed(), false);
  await claudeBrowser.manual.reload();
  await claudeDesktopClient.closeAll();
  checks.push('closing sessions preserves other clients and both manual pages');
  // Exercise actual native stdio protocol and screenshot content.
  const mcp = new Client({ name: 'keel-smoke', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [resolve('dist/mcp.js')], env: { ...Object.fromEntries(Object.entries(process.env).filter(([, value]) => typeof value === 'string')), KEEL_BROWSER_HOME: home, KEEL_BROWSER_CLIENT: 'claude-desktop' }, stderr: 'pipe' });
  await mcp.connect(transport);
  cleanup.push(() => mcp.close());
  assert.equal((await mcp.listTools()).tools.length, 13);
  const opened = await mcp.callTool({ name: 'browser_open', arguments: { url: `${site}/mcp` } });
  assert.notEqual(opened.isError, true);
  const owned = opened.structuredContent;
  assert.equal(owned.clientId, 'claude-desktop');
  assert.equal(owned.profileId, fixtureProfiles.claude.id);
  const image = await mcp.callTool({ name: 'browser_screenshot', arguments: { sessionId: owned.sessionId, tabId: owned.tabs[0].tabId } });
  assert.equal(image.content[0].type, 'image');
  // CLI commands must retain capabilities between separate processes.
  const cli = async args => JSON.parse((await promisify(execFile)(process.execPath, [resolve('dist/cli.js'), '--client', 'claude-cli', ...args, '--home', home], { windowsHide: true })).stdout);
  const cliSession = await cli(['open', '--url', `${site}/cli`]);
  assert.equal(cliSession.clientId, 'claude-cli');
  assert.equal(cliSession.profileId, fixtureProfiles.claude.id);
  assert.equal((await cli(['status', '--session', cliSession.sessionId])).status, 'active');
  for (const path of ['/mcp', '/cli']) {
    assert.ok(claudeBrowser.context.pages().some(page => page.url() === `${site}${path}`));
    assert.equal(context.pages().some(page => page.url() === `${site}${path}`), false);
  }
  await cli(['close', '--session', cliSession.sessionId]);
  assert.notEqual((await mcp.callTool({ name: 'browser_status', arguments: { sessionId: owned.sessionId } })).isError, true);
  await mcp.callTool({ name: 'browser_close', arguments: { sessionId: owned.sessionId } });
  await mcp.close();
  checks.push('native Claude Desktop MCP and Claude CLI subprocesses share their profile and preserve separate capabilities');
  await stopBroker(home);
  assert.equal((await brokerStatus(home)).running, false);
  assert.equal(manual.isClosed(), false);
  await manual.reload();
  assert.equal(claudeBrowser.manual.isClosed(), false);
  await claudeBrowser.manual.reload();
  for (const call of calls) {
    assert.ok(call.tool === 'list_profiles' || call.tool === 'launch_profile');
    if (call.tool === 'launch_profile') {
      assert.deepEqual(Object.keys(call.arguments), ['profile_id']);
      assert.ok(Object.values(fixtureProfiles).some(profile => profile.id === call.arguments.profile_id));
    } else assert.deepEqual(call.arguments, {});
  }
  assert.ok(calls.some(call => call.tool === 'list_profiles'));
  for (const profile of Object.values(fixtureProfiles)) {
    assert.ok(calls.some(call => call.tool === 'launch_profile' && call.arguments.profile_id === profile.id));
  }
  checks.push('broker stop preserves both shared browsers; only native list_profiles and known fake-ID launch_profile used');
  console.log(JSON.stringify({ ok: true, fixture: 'Two disposable Chromium profiles + mock MultiZen MCP (not live MultiZen)', checks }));
} finally {
  for (const action of cleanup.reverse()) await action().catch(() => {});
  // Only remove the exact directory returned by mkdtemp under the OS temp directory.
  if (resolve(root).startsWith(resolve(tmpdir()) + '\\') || resolve(root).startsWith(resolve(tmpdir()) + '/'))
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
}
