import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { Address, StrKey, xdr } from '@stellar/stellar-sdk';
import {
  compareMetadata,
  inspectContractEnvMeta,
  inspectWasmEnvironmentMetadata,
  type ContractEnvMetaArtifact,
  type ContractEnvMetaEntry,
} from '../src/services/contract-env-meta';
import { formatContractEnvMetaReport } from '../src/output/contract-env-meta-report';

function uleb(value: number): Buffer {
  const bytes: number[] = [];
  do {
    let byte = value & 0x7f;
    value >>>= 7;
    if (value) byte |= 0x80;
    bytes.push(byte);
  } while (value);
  return Buffer.from(bytes);
}

function makeWasm(metadata?: Buffer): Buffer {
  const sections: Buffer[] = [];
  if (metadata) {
    const name = Buffer.from('contractenvmetav0');
    const body = Buffer.concat([uleb(name.length), name, metadata]);
    sections.push(Buffer.concat([Buffer.from([0]), uleb(body.length), body]));
  }
  return Buffer.concat([Buffer.from('0061736d01000000', 'hex'), ...sections]);
}

function makeVersionMetadata(protocol: number, preRelease = 0): Buffer {
  return Buffer.from([
    0,
    0,
    0,
    1,
    0,
    0,
    0,
    0,
    protocol >>> 24,
    protocol >>> 16,
    protocol >>> 8,
    protocol,
    preRelease >>> 24,
    preRelease >>> 16,
    preRelease >>> 8,
    preRelease,
  ]);
}

function makeUnknownMetadata(): Buffer {
  return Buffer.from([0, 0, 0, 1, 0, 0, 0, 7, 0, 0, 0, 42]);
}

function makeLedgerFixtures(wasm: Buffer) {
  const contractId = StrKey.encodeContract(Buffer.alloc(32, 1));
  const wasmHash = Buffer.alloc(32, 2);
  const address = Address.fromString(contractId);
  const instance = new xdr.ScContractInstance({
    executable: xdr.ContractExecutable.contractExecutableWasm(wasmHash),
    storage: [],
  });
  const instanceEntry = new xdr.LedgerEntry({
    lastModifiedLedgerSeq: 1,
    data: xdr.LedgerEntryData.contractData(
      new xdr.ContractDataEntry({
        ext: xdr.ExtensionPoint.fromXDR('AAAAAA==', 'base64'),
        contract: address.toScAddress(),
        key: xdr.ScVal.scvLedgerKeyContractInstance(),
        durability: xdr.ContractDataDurability.persistent(),
        val: xdr.ScVal.scvContractInstance(instance),
      }),
    ),
    ext: xdr.LedgerEntryExt.fromXDR('AAAAAA==', 'base64'),
  });
  const codeEntry = new xdr.LedgerEntry({
    lastModifiedLedgerSeq: 1,
    data: xdr.LedgerEntryData.contractCode(
      new xdr.ContractCodeEntry({
        ext: xdr.ContractCodeEntryExt.fromXDR('AAAAAA==', 'base64'),
        hash: wasmHash,
        code: wasm,
      }),
    ),
    ext: xdr.LedgerEntryExt.fromXDR('AAAAAA==', 'base64'),
  });
  return {
    contractId,
    wasmHash: wasmHash.toString('hex'),
    instanceXdr: instanceEntry.toXDR('base64'),
    codeXdr: codeEntry.toXDR('base64'),
  };
}

function artifact(entries: ContractEnvMetaEntry[], fingerprint?: string): ContractEnvMetaArtifact {
  return {
    source: { type: 'wasm', value: 'fixture.wasm' },
    status: 'decoded',
    fingerprint,
    normalized: { compatibilityValues: {}, entries },
  };
}

describe('contract environment metadata inspection', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('decodes normalized interface-version metadata and retains raw XDR', () => {
    const wasm = makeWasm(makeVersionMetadata(22, 3));
    const entryXdr = makeVersionMetadata(22, 3).subarray(4);
    expect(xdr.ScEnvMetaEntry.fromXDR(entryXdr, 'raw').toXDR('raw')).toEqual(entryXdr);
    const result = inspectWasmEnvironmentMetadata(wasm, { type: 'wasm', value: 'fixture.wasm' });

    expect(result.status).toBe('decoded');
    expect(result.normalized?.interfaceVersion).toEqual({ protocol: 22, preRelease: 3 });
    expect(result.normalized?.entries).toEqual([
      { key: 'interfaceVersion', value: { protocol: 22, preRelease: 3 } },
    ]);
    expect(Buffer.from(result.rawMetadata!.value, 'base64')).toEqual(makeVersionMetadata(22, 3));
    expect(result.fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it('normalizes multiple XDR entries deterministically', () => {
    const firstEntry = makeVersionMetadata(20).subarray(4);
    const secondEntry = makeVersionMetadata(21).subarray(4);
    const multiEntryXdr = Buffer.concat([Buffer.from([0, 0, 0, 2]), firstEntry, secondEntry]);
    const result = inspectWasmEnvironmentMetadata(makeWasm(multiEntryXdr), {
      type: 'wasm',
      value: 'fixture.wasm',
    });

    expect(result.status).toBe('decoded');
    expect(result.normalized?.entries).toHaveLength(2);
    expect(result.normalized?.interfaceVersion).toEqual({ protocol: 21, preRelease: 0 });
    expect(result.fingerprint).toBe(
      inspectWasmEnvironmentMetadata(makeWasm(multiEntryXdr), {
        type: 'wasm',
        value: 'another-path.wasm',
      }).fingerprint,
    );
  });

  it('reports missing metadata explicitly', () => {
    expect(
      inspectWasmEnvironmentMetadata(makeWasm(), { type: 'wasm', value: 'empty.wasm' }),
    ).toEqual(
      expect.objectContaining({ status: 'absent', diagnostic: expect.stringMatching(/absent/) }),
    );
  });

  it('preserves unsupported entries and marks partial decoding', () => {
    const result = inspectWasmEnvironmentMetadata(makeWasm(makeUnknownMetadata()), {
      type: 'wasm',
      value: 'future.wasm',
    });
    expect(result.status).toBe('partially-unsupported');
    expect(result.diagnostic).toMatch(/unsupported environment metadata kind/);
    expect(result.rawMetadata?.hex).toBe(makeUnknownMetadata().toString('hex'));
    expect(result.fingerprint).toBeDefined();
  });

  it('marks malformed custom sections without throwing', () => {
    const malformed = Buffer.concat([Buffer.from('0061736d01000000000a', 'hex'), Buffer.from([1])]);
    expect(
      inspectWasmEnvironmentMetadata(malformed, { type: 'wasm', value: 'bad.wasm' }).status,
    ).toBe('malformed');
    const malformedXdr = Buffer.from([0, 0, 0, 1]);
    expect(
      inspectWasmEnvironmentMetadata(makeWasm(malformedXdr), {
        type: 'wasm',
        value: 'bad-xdr.wasm',
      }),
    ).toEqual(
      expect.objectContaining({
        status: 'malformed',
        diagnostic: expect.any(String),
        rawMetadata: expect.objectContaining({ value: malformedXdr.toString('base64') }),
      }),
    );
  });

  it('compares identical, added, removed, and changed normalized entries', () => {
    const left = artifact(
      [
        { key: 'a', value: 'one' },
        { key: 'b', value: 1 },
      ],
      'same',
    );
    const identical = compareMetadata(
      left,
      artifact(
        [
          { key: 'b', value: 1 },
          { key: 'a', value: 'one' },
        ],
        'same',
      ),
    );
    expect(identical).toEqual({
      sameMetadata: true,
      compatibility: 'not-assessed',
      added: [],
      removed: [],
      changed: [],
    });

    const diff = compareMetadata(
      left,
      artifact(
        [
          { key: 'b', value: 2 },
          { key: 'c', value: true },
        ],
        'different',
      ),
    );
    expect(diff.added).toEqual([{ key: 'c', value: true }]);
    expect(diff.removed).toEqual([{ key: 'a', value: 'one' }]);
    expect(diff.changed).toEqual([{ key: 'b', before: 1, after: 2 }]);
    expect(diff.compatibility).toBe('not-assessed');
  });

  it('inspects local files without making network requests and reports unavailable files', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'contract-env-meta-'));
    const wasmPath = join(directory, 'contract.wasm');
    const fetchSpy = jest.fn();
    global.fetch = fetchSpy as unknown as typeof fetch;
    try {
      await writeFile(wasmPath, makeWasm(makeVersionMetadata(22)));
      const local = await inspectContractEnvMeta({ wasm: wasmPath });
      expect(local.artifact.status).toBe('decoded');
      const localComparison = await inspectContractEnvMeta({ wasm: wasmPath }, { wasm: wasmPath });
      expect(localComparison.comparison?.result.sameMetadata).toBe(true);
      expect(fetchSpy).not.toHaveBeenCalled();
      const missing = await inspectContractEnvMeta({ wasm: join(directory, 'missing.wasm') });
      expect(missing.artifact).toEqual(expect.objectContaining({ status: 'artifact-unavailable' }));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('resolves a deployed contract to its code entry using read-only RPC requests', async () => {
    const wasm = makeWasm(makeVersionMetadata(22));
    const fixture = makeLedgerFixtures(wasm);
    const requests: Array<{
      method: string;
      params: { keys: string[] };
    }> = [];
    global.fetch = jest.fn().mockImplementation((_url: string, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as {
        method: string;
        params: { keys: string[] };
      };
      requests.push(request);
      const index = requests.length;
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            jsonrpc: '2.0',
            id: 1,
            result: { entries: [{ xdr: index === 1 ? fixture.instanceXdr : fixture.codeXdr }] },
          }),
      } as Response);
    });

    const result = await inspectContractEnvMeta({
      contractId: fixture.contractId,
      rpcUrl: 'https://rpc.example',
    });
    expect(result.artifact.status).toBe('decoded');
    expect(result.artifact.normalized?.interfaceVersion?.protocol).toBe(22);
    expect(requests).toHaveLength(2);
    expect(requests.every((request) => request.method === 'getLedgerEntries')).toBe(true);
    expect(requests.every((request) => request.params.keys.length === 1)).toBe(true);
  });

  it('handles missing contract-code entries and hash lookup failures', async () => {
    const fixture = makeLedgerFixtures(makeWasm());
    let requestCount = 0;
    global.fetch = jest.fn().mockImplementation(() => {
      requestCount += 1;
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            jsonrpc: '2.0',
            id: 1,
            result: { entries: requestCount === 1 ? [{ xdr: fixture.instanceXdr }] : [] },
          }),
      } as Response);
    });
    const missingCode = await inspectContractEnvMeta({ contractId: fixture.contractId });
    expect(missingCode.artifact.status).toBe('artifact-unavailable');
    expect(missingCode.artifact.diagnostic).toMatch(/code ledger entry.*not found/i);

    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 503,
      statusText: 'Unavailable',
    } as Response);
    const failedHash = await inspectContractEnvMeta({ wasmHash: fixture.wasmHash });
    expect(failedHash.artifact.status).toBe('artifact-unavailable');
    expect(failedHash.artifact.diagnostic).toMatch(/HTTP 503/);
  });

  it('validates contract IDs and surfaces RPC JSON errors', async () => {
    await expect(inspectContractEnvMeta({ contractId: 'invalid' })).rejects.toThrow(
      /Invalid Soroban contract ID/,
    );
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          jsonrpc: '2.0',
          id: 1,
          error: { code: -1, message: 'offline' },
        }),
    } as Response);
    const result = await inspectContractEnvMeta({ wasmHash: 'ab'.repeat(32) });
    expect(result.artifact.status).toBe('artifact-unavailable');
    expect(result.artifact.diagnostic).toMatch(/JSON-RPC error -1/);
  });

  it('includes raw and normalized metadata in JSON and distinguishes observations in text output', () => {
    const artifactResult = inspectWasmEnvironmentMetadata(makeWasm(makeVersionMetadata(22)), {
      type: 'wasm',
      value: 'fixture.wasm',
    });
    const json = JSON.parse(JSON.stringify({ ok: true, data: { artifact: artifactResult } }));
    expect(json.data.artifact.normalized.interfaceVersion.protocol).toBe(22);
    expect(json.data.artifact.rawMetadata.encoding).toBe('base64-xdr');
    const text = formatContractEnvMetaReport({ artifact: artifactResult });
    expect(text).toContain('Present and decoded');
    expect(text).toContain('compatibility is not inferred');
    const comparisonText = formatContractEnvMetaReport({
      artifact: artifactResult,
      comparison: {
        artifact: artifactResult,
        result: compareMetadata(artifactResult, artifactResult),
      },
    });
    expect(comparisonText).toContain('Not assessed');
  });
});
