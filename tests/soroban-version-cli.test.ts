import { AddressInfo } from 'net';
import { createServer, Server } from 'http';
import { spawn } from 'child_process';
import path from 'path';

interface RpcRequest {
  method: string;
  params: Record<string, unknown>;
}

function runCli(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['-r', 'ts-node/register', path.join(process.cwd(), 'src/cli/index.ts'), ...args],
      { cwd: process.cwd() },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

describe('soroban-version CLI integration', () => {
  let server: Server;
  let endpoint: string;
  let requests: Array<{ path: string; rpc: RpcRequest }>;
  let replies: Record<string, unknown>;

  beforeAll(async () => {
    requests = [];
    replies = {};
    server = createServer((request, response) => {
      let body = '';
      request.setEncoding('utf8');
      request.on('data', (chunk: string) => (body += chunk));
      request.on('end', () => {
        const rpc = JSON.parse(body) as RpcRequest;
        requests.push({ path: request.url || '/', rpc });
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify(replies[request.url || '/']));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as AddressInfo;
    endpoint = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });

  beforeEach(() => {
    requests = [];
    replies = {};
  });

  it('prints normalized JSON metadata and retains the raw response', async () => {
    const raw = {
      jsonrpc: '2.0',
      id: 1,
      result: {
        implementation: 'stellar-rpc',
        version: '22.0.0',
        build: 'release',
        commit: 'abc123',
        protocol_version: 22,
        supported_rpc_versions: ['1.0.0'],
      },
    };
    replies['/node'] = raw;

    const result = await runCli(['soroban-version', `${endpoint}/node`, '--json']);

    expect(result.code).toBe(0);
    const output = JSON.parse(result.stdout) as { ok: boolean; data: Record<string, unknown> };
    expect(output.ok).toBe(true);
    expect(output.data).toMatchObject({
      status: 'available',
      endpointUrl: `${endpoint}/node`,
      metadata: { implementation: 'stellar-rpc', serverVersion: '22.0.0', revision: 'abc123' },
      rawResponse: raw,
    });
    expect(output.data.latencyMs).toEqual(expect.any(Number));
    expect(output.data.retrievedAt).toEqual(expect.any(String));
    expect(requests).toHaveLength(1);
    expect(requests[0].rpc.method).toBe('getVersionInfo');
  }, 20000);

  it('compares endpoints in JSON and reports metadata differences', async () => {
    replies['/one'] = {
      jsonrpc: '2.0',
      id: 1,
      result: { implementation: 'stellar-rpc', version: '22.0', commit: 'aaa' },
    };
    replies['/two'] = {
      jsonrpc: '2.0',
      id: 1,
      result: { implementation: 'alternate-rpc', version: '23.0', commit: 'bbb' },
    };

    const result = await runCli([
      'soroban-version',
      `${endpoint}/one`,
      '--compare',
      `${endpoint}/two`,
      '--json',
    ]);

    expect(result.code).toBe(0);
    const output = JSON.parse(result.stdout) as {
      data: {
        comparison: { softwareMetadataMatches: boolean; differences: unknown[] };
        nodes: unknown[];
      };
    };
    expect(output.data.nodes).toHaveLength(2);
    expect(output.data.comparison.softwareMetadataMatches).toBe(false);
    expect(output.data.comparison.differences).toHaveLength(3);
    expect(requests.map(({ rpc }) => rpc.method)).toEqual(['getVersionInfo', 'getVersionInfo']);
  }, 20000);

  it('gives human-readable unsupported-method diagnostics', async () => {
    replies['/legacy'] = {
      jsonrpc: '2.0',
      id: 1,
      error: { code: -32601, message: 'Method not found' },
    };

    const result = await runCli(['soroban-version', `${endpoint}/legacy`]);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Version Information');
    expect(result.stdout).toContain('unsupported');
    expect(result.stdout).toContain('Method not found');
    expect(requests[0].rpc.method).toBe('getVersionInfo');
  }, 20000);
});
