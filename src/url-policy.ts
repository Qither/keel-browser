import { KeelError } from './contracts.js';

const HTTP_PROTOCOLS = new Set(['http:', 'https:']);
const WEBSOCKET_PROTOCOLS = new Set(['ws:', 'wss:']);
const CONTROL_PROTOCOLS = new Set(['http:', 'https:', 'ws:', 'wss:']);

function parseUrl(value: string): URL | undefined {
  try { return new URL(value); } catch { return undefined; }
}

/** WHATWG URL canonicalizes integer, octal, and hexadecimal IPv4 spellings. */
function hostIdentity(url: URL): string {
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, '');
  if (host === 'localhost' || host.endsWith('.localhost') ||
      host === 'localhost.localdomain' || host === 'ip6-localhost' || host === 'ip6-loopback' ||
      host === '0.0.0.0' || /^127\./.test(host)) return 'loopback';

  if (host.includes(':')) {
    const halves = host.split('::');
    const left = halves[0] ? halves[0].split(':') : [];
    const right = halves[1] ? halves[1].split(':') : [];
    const groups = halves.length === 2
      ? [...left, ...Array<string>(8 - left.length - right.length).fill('0'), ...right]
      : left;
    const words = groups.map(part => Number.parseInt(part, 16));
    if (words.length === 8) {
      // Unspecified, loopback, and IPv4-compatible/mapped loopback addresses.
      const firstSixZero = words.slice(0, 6).every(part => part === 0);
      const mapped = words.slice(0, 5).every(part => part === 0) && words[5] === 0xffff;
      if (firstSixZero && words[6] === 0 && (words[7] === 0 || words[7] === 1)) return 'loopback';
      if ((firstSixZero || mapped) && (words[6]! >>> 8) === 127) return 'loopback';
      if (mapped && words[6] === 0 && words[7] === 0) return 'loopback';
    }
  }
  return host;
}

function endpointIdentity(url: URL): string {
  const port = url.port || (url.protocol === 'https:' || url.protocol === 'wss:' ? '443' : '80');
  return `${hostIdentity(url)}|${port}`;
}

/**
 * Prevent accidental browser access to known control endpoints, including redirects.
 * This is not a network sandbox: it does not resolve DNS, prevent DNS rebinding,
 * or isolate tasks sharing a browser profile. Every routed request must be checked.
 */
export class UrlPolicy {
  private readonly controls = new Set<string>();

  constructor(controlUrl: string) {
    this.addControlEndpoint(controlUrl);
  }

  setBrokerPort(port: number): void {
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      throw new KeelError('INVALID_CONFIG', 'The Router port must be a valid TCP port.');
    }
    // Retain previous control identities if a listener or CDP endpoint changes.
    this.controls.add(`loopback|${port}`);
  }

  setCdpEndpoint(endpoint: string): void {
    this.addControlEndpoint(endpoint);
  }

  assertNavigation(value: string): string {
    const url = parseUrl(value);
    if (!url || !HTTP_PROTOCOLS.has(url.protocol)) {
      throw new KeelError('NAVIGATION_BLOCKED', 'Only absolute HTTP and HTTPS navigation URLs are allowed.');
    }
    if (url.username || url.password) {
      throw new KeelError('NAVIGATION_BLOCKED', 'Navigation URLs cannot contain credentials.');
    }
    if (this.controls.has(endpointIdentity(url))) {
      throw new KeelError('NAVIGATION_BLOCKED', 'Browser access to a local control endpoint is blocked.');
    }
    return url.href;
  }

  allowsRequest(value: string): boolean {
    const url = parseUrl(value);
    return !!url && HTTP_PROTOCOLS.has(url.protocol) && !url.username && !url.password && !this.controls.has(endpointIdentity(url));
  }

  allowsWebSocket(value: string): boolean {
    const url = parseUrl(value);
    return !!url && WEBSOCKET_PROTOCOLS.has(url.protocol) && !url.username && !url.password && !this.controls.has(endpointIdentity(url));
  }


  private addControlEndpoint(endpoint: string): void {
    const url = parseUrl(endpoint);
    if (!url || !CONTROL_PROTOCOLS.has(url.protocol)) {
      throw new KeelError('INVALID_CONFIG', 'A control endpoint has an invalid URL.');
    }
    this.controls.add(endpointIdentity(url));
  }
}
