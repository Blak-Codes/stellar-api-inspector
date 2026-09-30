import {
  compareSorobanVersions,
  inspectSorobanVersion,
  SorobanVersionInfo,
} from '../src/inspectors/soroban-version';

describe('inspectSorobanVersion', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  function mockResponse(body: unknown, ok = true, status = 200): Response {
    return {
      ok,
      status,
      statusText: ok ? 'OK' : 'Service Unavailable',
      json: jest.fn().mockResolvedValue(body),
    } as unknown as Response;
  }

  it('normalizes complete version information and preserves the raw RPC response', async () => {
    const rawResponse = {
      jsonrpc: '2.0',
      id: 1,
      result: {
        implementation: 'Stellar Core RPC',
        version: '22.1.0',
        build: 'release',
        commit: 'abc123',
        protocol_version: 22,
        supported_rpc_versions: ['1.0.0'],
      },
    };
    global.fetch = jest.fn().mockResolvedValue(mockResponse(rawResponse));

    const info = await inspectSorobanVersion('https://rpc.example.com/');

    expect(info.status).toBe('available');
    expect(info.endpointUrl).toBe('https://rpc.example.com');
    expect(info.metadata).toEqual({
      implementation: 'Stellar Core RPC',
      serverVersion: '22.1.0',
      buildVersion: 'release',
      revision: 'abc123',
      protocolVersion: 22,
      supportedRpcVersions: ['1.0.0'],
    });
    expect(info.rawResponse).toEqual(rawResponse);
    expect(Number.isFinite(info.latencyMs)).toBe(true);
    expect(info.latencyMs).toBeGreaterThanOrEqual(0);
    expect(Number.isNaN(Date.parse(info.retrievedAt))).toBe(false);
    expect(global.fetch).toHaveBeenCalledWith(
      'https://rpc.example.com',
      expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining('"method":"getVersionInfo"'),
      }),
    );
  });

  it('reports missing optional fields as partial rather than guessing', async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValue(
        mockResponse({ jsonrpc: '2.0', id: 1, result: { version: '1.2.3', commit: 'deadbeef' } }),
      );

    const info = await inspectSorobanVersion('https://rpc.example.com');

    expect(info.status).toBe('partially-available');
    expect(info.metadata.serverVersion).toBe('1.2.3');
    expect(info.metadata.revision).toBe('deadbeef');
    expect(info.metadata.implementation).toBeNull();
    expect(info.metadata.protocolVersion).toBeNull();
    expect(info.metadata.buildVersion).toBeNull();
    expect(info.metadata.supportedRpcVersions).toBeNull();
  });

  it('measures elapsed time through response-body parsing', async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValue(mockResponse({ jsonrpc: '2.0', id: 1, result: { version: '1.0.0' } }));
    jest.spyOn(Date, 'now').mockReturnValueOnce(100).mockReturnValueOnce(145);

    const info = await inspectSorobanVersion('https://rpc.example.com');

    expect(info.latencyMs).toBe(45);
  });

  it('classifies an unsupported version method and retains its error response', async () => {
    const rawResponse = {
      jsonrpc: '2.0',
      id: 1,
      error: { code: -32601, message: 'Method not found' },
    };
    global.fetch = jest.fn().mockResolvedValue(mockResponse(rawResponse));

    const info = await inspectSorobanVersion('https://rpc.example.com');

    expect(info.status).toBe('unsupported');
    expect(info.rawResponse).toEqual(rawResponse);
    expect(info.error).toMatch(/method not found/i);
  });

  it('handles malformed version results safely', async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValue(mockResponse({ jsonrpc: '2.0', id: 1, result: 'bad' }));

    const info = await inspectSorobanVersion('https://rpc.example.com');

    expect(info.status).toBe('malformed');
    expect(info.rawResponse).toEqual({ jsonrpc: '2.0', id: 1, result: 'bad' });
    expect(info.metadata).toEqual({
      implementation: null,
      serverVersion: null,
      buildVersion: null,
      revision: null,
      protocolVersion: null,
      supportedRpcVersions: null,
    });
  });

  it('reports invalid URLs without making a request', async () => {
    const fetchMock = jest.fn();
    global.fetch = fetchMock;

    const info = await inspectSorobanVersion('file:///tmp/node');

    expect(info.status).toBe('unreachable');
    expect(info.latencyMs).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('classifies failed requests as unreachable', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('connection refused'));

    const info = await inspectSorobanVersion('https://rpc.example.com');

    expect(info.status).toBe('unreachable');
    expect(info.error).toContain('connection refused');
  });
});

describe('compareSorobanVersions', () => {
  const base: SorobanVersionInfo = {
    endpointUrl: 'https://one.example.com',
    status: 'available',
    metadata: {
      implementation: 'stellar-rpc',
      serverVersion: '22.0.0',
      buildVersion: 'release',
      revision: 'aaa111',
      protocolVersion: 22,
      supportedRpcVersions: ['1.0.0'],
    },
    latencyMs: 4,
    retrievedAt: '2025-01-01T00:00:00.000Z',
  };

  it('reports matching nodes without differences', () => {
    const comparison = compareSorobanVersions(base, {
      ...base,
      endpointUrl: 'https://two.example.com',
    });

    expect(comparison.differences).toEqual([]);
    expect(comparison.softwareMetadataMatches).toBe(true);
  });

  it('reports implementation, server-version, revision, and protocol differences', () => {
    const second: SorobanVersionInfo = {
      ...base,
      metadata: {
        ...base.metadata,
        implementation: 'alternate-rpc',
        serverVersion: '23.0.0',
        revision: 'bbb222',
        protocolVersion: 23,
      },
    };

    const comparison = compareSorobanVersions(base, second);

    expect(comparison.differences.map(({ field }) => field)).toEqual([
      'implementation',
      'serverVersion',
      'revision',
      'protocolVersion',
    ]);
    expect(comparison.softwareMetadataMatches).toBe(false);
  });

  it('compares build metadata but does not infer protocol incompatibility', () => {
    const second: SorobanVersionInfo = {
      ...base,
      metadata: { ...base.metadata, buildVersion: 'debug' },
    };

    const comparison = compareSorobanVersions(base, second);

    expect(comparison.differences).toEqual([
      { field: 'buildVersion', first: 'release', second: 'debug' },
    ]);
    expect(comparison.softwareMetadataMatches).toBe(false);
  });

  it('returns null when neither node exposes software metadata', () => {
    const first: SorobanVersionInfo = { ...base, metadata: { protocolVersion: 22 } };
    const second: SorobanVersionInfo = { ...base, metadata: { protocolVersion: 22 } };

    expect(compareSorobanVersions(first, second).softwareMetadataMatches).toBeNull();
  });
});
