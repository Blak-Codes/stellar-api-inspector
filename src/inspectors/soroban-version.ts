import { validateHorizonUrl, normalizeHorizonUrl } from '../utils/urls';

export type SorobanVersionStatus =
  | 'available'
  | 'partially-available'
  | 'unsupported'
  | 'unreachable'
  | 'malformed';

export interface SorobanVersionMetadata {
  implementation?: string | null;
  serverVersion?: string | null;
  buildVersion?: string | null;
  revision?: string | null;
  protocolVersion?: string | number | null;
  supportedRpcVersions?: string[] | Record<string, unknown> | null;
}

export interface SorobanVersionInfo {
  endpointUrl: string;
  status: SorobanVersionStatus;
  metadata: SorobanVersionMetadata;
  latencyMs: number;
  retrievedAt: string;
  rawResponse?: unknown;
  error?: string;
}

export interface SorobanVersionComparison {
  first: SorobanVersionInfo;
  second: SorobanVersionInfo;
  differences: Array<{
    field: keyof SorobanVersionMetadata;
    first: unknown;
    second: unknown;
  }>;
  softwareMetadataMatches: boolean | null;
}

interface JsonRpcEnvelope {
  jsonrpc?: unknown;
  id?: unknown;
  result?: unknown;
  error?: { code?: unknown; message?: unknown; data?: unknown };
}

const metadataFields: Array<keyof SorobanVersionMetadata> = [
  'implementation',
  'serverVersion',
  'buildVersion',
  'revision',
  'protocolVersion',
  'supportedRpcVersions',
];

const unavailableMetadata: SorobanVersionMetadata = {
  implementation: null,
  serverVersion: null,
  buildVersion: null,
  revision: null,
  protocolVersion: null,
  supportedRpcVersions: null,
};

function pickString(record: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return null;
}

function normalizeMetadata(value: Record<string, unknown>): SorobanVersionMetadata {
  const implementation = pickString(value, [
    'implementation',
    'server',
    'server_name',
    'serverName',
    'name',
  ]);
  const serverVersion = pickString(value, ['version', 'server_version', 'serverVersion']);
  const buildVersion = pickString(value, ['build', 'build_version', 'buildVersion']);
  const revision = pickString(value, ['commit', 'revision', 'git_commit', 'gitCommit']);
  const rawProtocolVersion = value.protocol_version ?? value.protocolVersion;
  const protocolVersion =
    typeof rawProtocolVersion === 'string' || typeof rawProtocolVersion === 'number'
      ? rawProtocolVersion
      : null;
  const rawSupportedVersions =
    value.supported_rpc_versions ??
    value.supportedRpcVersions ??
    value.rpc_versions ??
    value.rpcVersions;
  const supportedRpcVersions =
    Array.isArray(rawSupportedVersions) &&
    rawSupportedVersions.every((item) => typeof item === 'string')
      ? rawSupportedVersions
      : rawSupportedVersions !== null &&
          typeof rawSupportedVersions === 'object' &&
          !Array.isArray(rawSupportedVersions)
        ? (rawSupportedVersions as Record<string, unknown>)
        : null;

  return {
    implementation,
    serverVersion: serverVersion ?? null,
    buildVersion: buildVersion ?? null,
    revision: revision ?? null,
    protocolVersion,
    supportedRpcVersions,
  };
}

function isUnsupported(error: JsonRpcEnvelope['error']): boolean {
  if (!error) return false;
  const message = typeof error.message === 'string' ? error.message.toLowerCase() : '';
  return (
    error.code === -32601 ||
    message.includes('method not found') ||
    message.includes('unsupported method')
  );
}

/** Query the read-only getVersionInfo RPC method and retain its raw JSON-RPC response. */
export async function inspectSorobanVersion(url: string): Promise<SorobanVersionInfo> {
  const endpointUrl = normalizeHorizonUrl(url);
  const validation = validateHorizonUrl(url);
  const emptyInfo = (status: SorobanVersionStatus, latencyMs: number, error?: string) => ({
    endpointUrl,
    status,
    metadata: unavailableMetadata,
    latencyMs,
    retrievedAt: new Date().toISOString(),
    ...(error ? { error } : {}),
  });

  if (!validation.valid) return emptyInfo('unreachable', 0, validation.error);

  const startedAt = Date.now();
  let response: Response;
  try {
    response = await fetch(endpointUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Stellar-API-Inspector/1.0',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getVersionInfo', params: {} }),
    });
  } catch (error: unknown) {
    const latencyMs = Date.now() - startedAt;
    return emptyInfo(
      'unreachable',
      latencyMs,
      error instanceof Error ? error.message : String(error),
    );
  }
  if (!response.ok) {
    return emptyInfo(
      'unreachable',
      Date.now() - startedAt,
      `HTTP ${response.status} ${response.statusText}`,
    );
  }

  let rawResponse: unknown;
  try {
    rawResponse = await response.json();
  } catch (error: unknown) {
    return {
      ...emptyInfo(
        'malformed',
        Date.now() - startedAt,
        error instanceof Error ? error.message : String(error),
      ),
      rawResponse: null,
    };
  }
  const latencyMs = Date.now() - startedAt;
  const retrievedAt = new Date().toISOString();

  if (!rawResponse || typeof rawResponse !== 'object' || Array.isArray(rawResponse)) {
    return {
      ...emptyInfo('malformed', latencyMs, 'RPC response must be a JSON object'),
      rawResponse,
    };
  }

  const envelope = rawResponse as JsonRpcEnvelope;
  if (envelope.error) {
    const message =
      typeof envelope.error.message === 'string' ? envelope.error.message : 'RPC request failed';
    return {
      ...emptyInfo(
        isUnsupported(envelope.error) ? 'unsupported' : 'unreachable',
        latencyMs,
        `JSON-RPC error ${String(envelope.error.code ?? '')}: ${message}`.trim(),
      ),
      rawResponse,
    };
  }

  if (!Object.prototype.hasOwnProperty.call(envelope, 'result')) {
    return {
      ...emptyInfo('malformed', latencyMs, 'RPC response contained neither a result nor an error'),
      rawResponse,
    };
  }
  if (!envelope.result || typeof envelope.result !== 'object' || Array.isArray(envelope.result)) {
    return {
      ...emptyInfo('malformed', latencyMs, 'Version result must be a JSON object'),
      rawResponse,
    };
  }

  const metadata = normalizeMetadata(envelope.result as Record<string, unknown>);
  const presentCount = metadataFields.filter((field) => metadata[field] != null).length;
  return {
    endpointUrl,
    status: presentCount === metadataFields.length ? 'available' : 'partially-available',
    metadata,
    latencyMs,
    retrievedAt,
    rawResponse,
  };
}

/** Compare exposed software metadata without inferring protocol compatibility. */
export function compareSorobanVersions(
  first: SorobanVersionInfo,
  second: SorobanVersionInfo,
): SorobanVersionComparison {
  const differences = metadataFields.flatMap((field) => {
    const firstValue = first.metadata[field];
    const secondValue = second.metadata[field];
    if (metadataValuesEqual(firstValue, secondValue)) return [];
    return [{ field, first: firstValue ?? null, second: secondValue ?? null }];
  });
  const softwareFields: Array<keyof SorobanVersionMetadata> = [
    'implementation',
    'serverVersion',
    'buildVersion',
    'revision',
  ];
  const hasSoftwareMetadata = softwareFields.some(
    (field) => first.metadata[field] != null || second.metadata[field] != null,
  );
  const softwareMetadataMatches = hasSoftwareMetadata
    ? softwareFields.every((field) =>
        metadataValuesEqual(first.metadata[field], second.metadata[field]),
      )
    : null;

  return { first, second, differences, softwareMetadataMatches };
}

function metadataValuesEqual(first: unknown, second: unknown): boolean {
  const stableValue = (value: unknown): unknown => {
    if (value === null || value === undefined || typeof value !== 'object') return value ?? null;
    if (Array.isArray(value)) return value.map(stableValue);
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, stableValue((value as Record<string, unknown>)[key])]),
    );
  };
  return JSON.stringify(stableValue(first)) === JSON.stringify(stableValue(second));
}
