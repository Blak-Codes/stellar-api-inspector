import { createHash } from 'crypto';
import { readFile } from 'fs/promises';
import { xdr } from '@stellar/stellar-sdk';
import {
  buildContractCodeLedgerKey,
  buildContractInstanceLedgerKey,
  parseContractInstanceFromLedgerEntry,
  validateContractId,
} from '../utils/xdr';

const ENV_META_SECTION = 'contractenvmetav0';
const DEFAULT_RPC_URL = 'https://soroban-testnet.stellar.org';

export type ContractEnvMetaStatus =
  | 'decoded'
  | 'partially-unsupported'
  | 'absent'
  | 'artifact-unavailable'
  | 'malformed';

export interface ContractEnvMetaEntry {
  key: string;
  value: unknown;
}

export interface ContractEnvMetaArtifact {
  source: { type: 'wasm' | 'wasm-hash' | 'contract-id'; value: string };
  status: ContractEnvMetaStatus;
  wasmHash?: string;
  wasmSizeBytes?: number;
  normalized?: {
    interfaceVersion?: { protocol: number; preRelease: number };
    compatibilityValues: Record<string, unknown>;
    entries: ContractEnvMetaEntry[];
  };
  fingerprint?: string;
  rawMetadata?: {
    encoding: 'base64-xdr';
    value: string;
    hex: string;
  };
  diagnostic?: string;
}

export interface ContractEnvMetaOptions {
  wasm?: string;
  wasmHash?: string;
  contractId?: string;
  rpcUrl?: string;
}

export interface ContractEnvMetaComparison {
  sameMetadata: boolean;
  compatibility: 'not-assessed';
  added: ContractEnvMetaEntry[];
  removed: ContractEnvMetaEntry[];
  changed: Array<{ key: string; before: unknown; after: unknown }>;
}

export interface ContractEnvMetaResult {
  artifact: ContractEnvMetaArtifact;
  comparison?: { artifact: ContractEnvMetaArtifact; result: ContractEnvMetaComparison };
}

interface RpcResponse<T> {
  result?: T;
  error?: { code: number; message: string };
}

interface LedgerEntriesResult {
  entries?: Array<{ xdr?: string }>;
}

export async function inspectContractEnvMeta(
  options: ContractEnvMetaOptions,
  compareWith?: ContractEnvMetaOptions,
): Promise<ContractEnvMetaResult> {
  const artifact = await inspectArtifact(options);
  if (!compareWith) return { artifact };

  const other = await inspectArtifact(compareWith);
  return {
    artifact,
    comparison: { artifact: other, result: compareMetadata(artifact, other) },
  };
}

export function inspectWasmEnvironmentMetadata(
  wasm: Buffer,
  source: ContractEnvMetaArtifact['source'],
): ContractEnvMetaArtifact {
  const base = {
    source,
    wasmHash: createHash('sha256').update(wasm).digest('hex'),
    wasmSizeBytes: wasm.length,
  };
  let section: Buffer | undefined;

  try {
    section = findCustomSection(wasm, ENV_META_SECTION);
    if (!section) {
      return { ...base, status: 'absent', diagnostic: 'Environment metadata section is absent.' };
    }

    const decoded = decodeMetadata(section);
    const fingerprint = fingerprintMetadata(decoded.normalized, decoded.unsupportedBytes);
    return {
      ...base,
      status: decoded.unsupportedBytes ? 'partially-unsupported' : 'decoded',
      normalized: decoded.normalized,
      fingerprint,
      rawMetadata: {
        encoding: 'base64-xdr',
        value: section.toString('base64'),
        hex: section.toString('hex'),
      },
      ...(decoded.diagnostic ? { diagnostic: decoded.diagnostic } : {}),
    };
  } catch (error) {
    return {
      ...base,
      status: 'malformed',
      diagnostic: error instanceof Error ? error.message : String(error),
      ...(section
        ? {
            rawMetadata: {
              encoding: 'base64-xdr' as const,
              value: section.toString('base64'),
              hex: section.toString('hex'),
            },
          }
        : {}),
    };
  }
}

export function compareMetadata(
  left: ContractEnvMetaArtifact,
  right: ContractEnvMetaArtifact,
): ContractEnvMetaComparison {
  const leftEntries = entryMap(left.normalized?.entries ?? []);
  const rightEntries = entryMap(right.normalized?.entries ?? []);
  const added: ContractEnvMetaEntry[] = [];
  const removed: ContractEnvMetaEntry[] = [];
  const changed: ContractEnvMetaComparison['changed'] = [];

  for (const [key, value] of rightEntries) {
    if (!leftEntries.has(key)) added.push({ key, value });
    else if (stableJson(leftEntries.get(key)) !== stableJson(value)) {
      changed.push({ key, before: leftEntries.get(key), after: value });
    }
  }
  for (const [key, value] of leftEntries) {
    if (!rightEntries.has(key)) removed.push({ key, value });
  }

  added.sort(byKey);
  removed.sort(byKey);
  changed.sort((a, b) => a.key.localeCompare(b.key));
  const sameMetadata = Boolean(left.fingerprint && left.fingerprint === right.fingerprint);

  return { sameMetadata, compatibility: 'not-assessed', added, removed, changed };
}

async function inspectArtifact(options: ContractEnvMetaOptions): Promise<ContractEnvMetaArtifact> {
  const selected = [options.wasm, options.wasmHash, options.contractId].filter(
    (value) => value !== undefined,
  );
  if (selected.length !== 1) {
    throw new Error('Specify exactly one of --wasm, --wasm-hash, or --contract-id.');
  }

  if (options.wasm) {
    const source = { type: 'wasm' as const, value: options.wasm };
    try {
      return inspectWasmEnvironmentMetadata(await readFile(options.wasm), source);
    } catch (error) {
      return unavailable(source, error);
    }
  }

  if (options.contractId) {
    const validation = validateContractId(options.contractId);
    if (!validation.valid) throw new Error(validation.error);
    const rpcUrl = options.rpcUrl ?? DEFAULT_RPC_URL;
    try {
      const instanceKey = buildContractInstanceLedgerKey(options.contractId);
      const instanceEntry = await fetchLedgerEntry(rpcUrl, instanceKey);
      if (!instanceEntry) {
        return unavailable(
          { type: 'contract-id', value: options.contractId },
          'Contract instance ledger entry was not found.',
        );
      }
      const instance = parseContractInstanceFromLedgerEntry(instanceEntry);
      if (!instance.wasmHash) {
        return unavailable(
          { type: 'contract-id', value: options.contractId },
          'Contract instance does not reference a WASM hash.',
        );
      }
      return inspectCodeByHash(instance.wasmHash, rpcUrl, {
        type: 'contract-id',
        value: options.contractId,
      });
    } catch (error) {
      return unavailable({ type: 'contract-id', value: options.contractId }, error);
    }
  }

  const hash = options.wasmHash!;
  if (!/^[0-9a-fA-F]{64}$/.test(hash)) {
    throw new Error('WASM hash must be 64 hexadecimal characters.');
  }
  return inspectCodeByHash(hash, options.rpcUrl ?? DEFAULT_RPC_URL, {
    type: 'wasm-hash',
    value: hash.toLowerCase(),
  });
}

async function inspectCodeByHash(
  hash: string,
  rpcUrl: string,
  source: ContractEnvMetaArtifact['source'],
): Promise<ContractEnvMetaArtifact> {
  try {
    const entryXdr = await fetchLedgerEntry(rpcUrl, buildContractCodeLedgerKey(hash));
    if (!entryXdr) {
      return unavailable(source, `Contract code ledger entry for WASM hash ${hash} was not found.`);
    }
    const entry = xdr.LedgerEntry.fromXDR(entryXdr, 'base64');
    if (entry.data().switch().name !== 'contractCode') {
      return unavailable(source, 'Ledger entry is not a contract code entry.');
    }
    const wasm = Buffer.from(entry.data().contractCode().code());
    return inspectWasmEnvironmentMetadata(wasm, source);
  } catch (error) {
    return unavailable(source, error);
  }
}

async function fetchLedgerEntry(rpcUrl: string, key: string): Promise<string | undefined> {
  const response = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'Stellar-API-Inspector/1.0' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'getLedgerEntries',
      params: { keys: [key] },
    }),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
  const body = (await response.json()) as RpcResponse<LedgerEntriesResult>;
  if (body.error) throw new Error(`JSON-RPC error ${body.error.code}: ${body.error.message}`);
  if (!body.result) throw new Error('JSON-RPC response for "getLedgerEntries" contained no result');
  return body.result.entries?.[0]?.xdr;
}

function findCustomSection(wasm: Buffer, sectionName: string): Buffer | undefined {
  if (wasm.length < 8 || wasm.subarray(0, 4).toString('hex') !== '0061736d') {
    throw new Error('Artifact is not a valid WebAssembly module (invalid magic header).');
  }
  if (wasm.readUInt32LE(4) !== 1) throw new Error('Unsupported WebAssembly binary version.');

  let offset = 8;
  let found: Buffer | undefined;
  while (offset < wasm.length) {
    const sectionId = wasm[offset++];
    const size = readUleb128(wasm, offset);
    offset = size.nextOffset;
    const end = offset + size.value;
    if (end > wasm.length) {
      throw new Error('Malformed WebAssembly section: declared size exceeds artifact length.');
    }
    if (sectionId === 0) {
      const nameLength = readUleb128(wasm, offset);
      const nameStart = nameLength.nextOffset;
      const nameEnd = nameStart + nameLength.value;
      if (nameEnd > end) {
        throw new Error('Malformed WebAssembly custom section name.');
      }
      if (wasm.subarray(nameStart, nameEnd).toString('utf8') === sectionName) {
        if (found) {
          throw new Error('Malformed WebAssembly: duplicate environment metadata sections.');
        }
        found = wasm.subarray(nameEnd, end);
      }
    }
    offset = end;
  }
  if (offset !== wasm.length) throw new Error('Malformed WebAssembly section boundaries.');
  return found;
}

function decodeMetadata(section: Buffer): {
  normalized: NonNullable<ContractEnvMetaArtifact['normalized']>;
  unsupportedBytes?: Buffer;
  diagnostic?: string;
} {
  if (section.length < 4) {
    throw new Error('Environment metadata XDR is truncated before its entry count.');
  }
  const count = section.readUInt32BE(0);
  let offset = 4;
  const entries: ContractEnvMetaEntry[] = [];
  let interfaceVersion: { protocol: number; preRelease: number } | undefined;

  for (let index = 0; index < count; index += 1) {
    if (offset + 4 > section.length) {
      throw new Error(`Environment metadata XDR entry ${index} is truncated.`);
    }
    const kind = section.readInt32BE(offset);
    if (kind !== 0) {
      const unsupportedBytes = section.subarray(offset);
      return {
        normalized: { interfaceVersion, compatibilityValues: {}, entries },
        unsupportedBytes,
        diagnostic: `Metadata entry ${index} uses unsupported environment metadata kind ${kind}; raw XDR is preserved.`,
      };
    }
    if (offset + 12 > section.length) {
      throw new Error(`Interface version metadata entry ${index} is truncated.`);
    }
    const value = {
      protocol: section.readUInt32BE(offset + 4),
      preRelease: section.readUInt32BE(offset + 8),
    };
    entries.push({ key: 'interfaceVersion', value });
    interfaceVersion = value;
    offset += 12;
  }

  if (offset !== section.length) {
    throw new Error('Environment metadata XDR has trailing bytes after its entries.');
  }
  entries.sort(byKey);
  return {
    normalized: {
      interfaceVersion,
      compatibilityValues: interfaceVersion ? { protocol: interfaceVersion.protocol } : {},
      entries,
    },
  };
}

function fingerprintMetadata(
  normalized: NonNullable<ContractEnvMetaArtifact['normalized']>,
  unsupportedBytes?: Buffer,
): string {
  const payload = {
    interfaceVersion: normalized.interfaceVersion ?? null,
    compatibilityValues: normalized.compatibilityValues,
    entries: normalized.entries,
    unsupportedXdrHex: unsupportedBytes?.toString('hex') ?? null,
  };
  return createHash('sha256').update(stableJson(payload)).digest('hex');
}

function readUleb128(data: Buffer, start: number): { value: number; nextOffset: number } {
  let value = 0;
  let shift = 0;
  let offset = start;
  while (offset < data.length && shift < 35) {
    const byte = data[offset++];
    value |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return { value, nextOffset: offset };
    shift += 7;
  }
  throw new Error('Malformed WebAssembly section length encoding.');
}

function unavailable(
  source: ContractEnvMetaArtifact['source'],
  error: unknown,
): ContractEnvMetaArtifact {
  return {
    source,
    status: 'artifact-unavailable',
    diagnostic: error instanceof Error ? error.message : String(error),
  };
}

function entryMap(entries: ContractEnvMetaEntry[]): Map<string, unknown> {
  const result = new Map<string, unknown>();
  for (const entry of entries) result.set(entry.key, entry.value);
  return result;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function byKey(left: ContractEnvMetaEntry, right: ContractEnvMetaEntry): number {
  return left.key.localeCompare(right.key);
}
