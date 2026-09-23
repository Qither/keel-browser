import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { KeelError } from './contracts.js';

export interface BrokerState { pid: number; port: number; token: string; instanceId: string }

export async function writePrivate(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  await rename(temporary, path);
}

export async function ensureHome(home: string): Promise<void> {
  await mkdir(home, { recursive: true, mode: 0o700 });
}

export async function readState(home: string): Promise<BrokerState | undefined> {
  try {
    const value = JSON.parse(await readFile(join(home, 'broker.json'), 'utf8')) as BrokerState;
    if (!Number.isInteger(value.pid) || value.pid <= 0 || !Number.isInteger(value.port)
      || value.port < 1 || value.port > 65535 || !/^[a-f0-9]{64}$/.test(value.token)
      || typeof value.instanceId !== 'string') throw new Error('invalid');
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new KeelError('INVALID_STATE', 'Router state is invalid. Inspect the local state directory.');
  }
}

export function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
}
