import { describe, expect, it } from 'vitest';
import { KeelError } from '../src/contracts.js';
import { UrlPolicy } from '../src/url-policy.js';

describe('UrlPolicy', () => {
  const createPolicy = () => {
    const policy = new UrlPolicy('http://127.0.0.1:55173');
    policy.setBrokerPort(53111);
    policy.setCdpEndpoint('ws://127.0.0.1:9222/devtools/browser/example');
    return policy;
  };

  it('normalizes navigation and permits local fixture ports', () => {
    const policy = createPolicy();
    expect(policy.assertNavigation('HTTPS://example.com:443/a/../b?q=1')).toBe('https://example.com/b?q=1');
    expect(policy.assertNavigation('http://localhost:45001/fixture')).toBe('http://localhost:45001/fixture');
    expect(policy.allowsRequest('http://127.0.0.1:45001/redirect')).toBe(true);
  });

  it.each([
    'http://127.0.0.1:55173/mcp',
    'https://127.99.1.2:55173/',
    'http://localhost.:55173/',
    'http://test.localhost:55173/',
    'http://LOCALHOST:55173/',
    'http://localhost.localdomain:55173/',
    'http://ip6-localhost:55173/',
    'http://0.0.0.0:55173/',
    'http://127.1:55173/',
    'http://2130706433:55173/',
    'http://0177.0.0.1:55173/',
    'http://0x7f000001:55173/',
    'http://%31%32%37.0.0.1:55173/',
    'http://[::1]:55173/',
    'http://[0:0:0:0:0:0:0:1]:55173/',
    'http://[::]:55173/',
    'http://[::ffff:127.0.0.1]:55173/',
    'http://[::ffff:7f01:202]:55173/',
    'http://[::127.0.0.1]:55173/',
    'http://example.com@localhost:55173/',
    'http://localhost:53111/rpc',
    'https://[::1]:9222/json',
  ])('blocks navigation and redirected requests to control alias %s', url => {
    const policy = createPolicy();
    expect(() => policy.assertNavigation(url)).toThrow(KeelError);
    expect(policy.allowsRequest(url)).toBe(false);
  });

  it.each(['javascript:alert(1)', 'file:///C:/secret.txt', 'data:text/html,test', 'blob:https://example.com/id', 'about:blank', 'ftp://example.com', 'ws://localhost:9222/', '/relative', 'not a URL'])('rejects unsupported schemes and malformed values: %s', url => {
    const policy = createPolicy();
    expect(() => policy.assertNavigation(url)).toThrow(KeelError);
    expect(policy.allowsRequest(url)).toBe(false);
  });

  it('matches configured non-loopback hosts by normalized hostname and effective port', () => {
    const policy = new UrlPolicy('http://control.example.com/api');
    policy.setCdpEndpoint('wss://debug.example.com/devtools/browser/id');
    expect(policy.allowsRequest('http://CONTROL.example.com.:80/other')).toBe(false);
    expect(policy.allowsRequest('https://control.example.com:80/other')).toBe(false);
    expect(policy.allowsRequest('https://debug.example.com/json/version')).toBe(false);
    expect(policy.allowsRequest('https://control.example.com/')).toBe(true);
    expect(policy.allowsRequest('http://control.example.com.attacker.test/')).toBe(true);
  });

  it('rejects credentials without reflecting them in errors', () => {
    const policy = createPolicy();
    expect(() => policy.assertNavigation('https://user:secret@example.com/')).toThrow('Navigation URLs cannot contain credentials.');
    expect(policy.allowsRequest('https://user:secret@example.com/')).toBe(false);
  });

  it('permits ordinary remote WebSockets and unrelated local ports', () => {
    const policy = createPolicy();
    expect(policy.allowsWebSocket('ws://example.com/socket')).toBe(true);
    expect(policy.allowsWebSocket('wss://example.com/socket')).toBe(true);
    expect(policy.allowsWebSocket('ws://127.0.0.1:45001/socket')).toBe(true);
    expect(policy.allowsWebSocket('wss://localhost:45001/socket')).toBe(true);
  });

  it.each([
    'ws://localhost:55173/',
    'wss://LOCALHOST.:9222/devtools/browser/id',
    'ws://[::1]:53111/',
    'wss://2130706433:55173/',
    'ws://localhost:9222/',
    'wss://user:secret@example.com/socket',
    'ws://user@example.com/socket',
    'https://example.com/socket',
    'file:///C:/secret',
    '/relative',
    'not a URL',
  ])('rejects control, credentialed, or invalid WebSocket URLs: %s', url => {
    expect(createPolicy().allowsWebSocket(url)).toBe(false);
  });

  it('compares default WebSocket control ports across protocols', () => {
    const policy = new UrlPolicy('http://control.example.com/');
    policy.setCdpEndpoint('wss://debug.example.com/devtools/browser/id');
    expect(policy.allowsWebSocket('ws://control.example.com/socket')).toBe(false);
    expect(policy.allowsWebSocket('ws://debug.example.com:443/socket')).toBe(false);
    expect(policy.allowsWebSocket('wss://debug.example.com/socket')).toBe(false);
    expect(policy.allowsWebSocket('ws://debug.example.com/socket')).toBe(true);
  });

  it('blocks old control ports after reconnection', () => {
    const policy = createPolicy();
    policy.setBrokerPort(53112);
    policy.setCdpEndpoint('ws://localhost:9223/devtools/browser/new');
    for (const port of [53111, 53112, 9222, 9223]) {
      expect(policy.allowsRequest(`http://127.0.0.1:${port}/`)).toBe(false);
    }
  });

  it('rejects invalid control configuration without reflecting its value', () => {
    expect(() => new UrlPolicy('secret-key')).toThrow('A control endpoint has an invalid URL.');
    const policy = createPolicy();
    for (const port of [0, -1, 65_536, 4.5, Number.NaN]) {
      expect(() => policy.setBrokerPort(port)).toThrow(KeelError);
    }
    expect(() => policy.setCdpEndpoint('file:///secret-key')).toThrow(KeelError);
  });
});
