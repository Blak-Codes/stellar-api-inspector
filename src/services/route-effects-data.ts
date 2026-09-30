import { normalizeHorizonUrl } from '../utils/urls';

const ACCOUNT_ID_RE = /^G[A-Z2-7]{55}$/;
const TX_HASH_RE = /^[0-9a-fA-F]{64}$/;
const OPERATION_ID_RE = /^\d+$/;

export interface AccountDataReport {
  accountId: string;
  entries: Array<{
    key: string;
    raw: string;
    byteLength: number;
    utf8: string | null;
    hex: string;
    binary: boolean;
  }>;
  summary: { count: number; totalBytes: number; largestEntry: string | null; averageBytes: number };
}

export interface EffectsReport {
  subject: string;
  type: 'transaction' | 'operation';
  metadata?: Record<string, unknown>;
  effects: NormalizedEffect[];
  summary: {
    count: number;
    byType: Record<string, number>;
    accounts: Record<string, number>;
    assets: Record<string, number>;
    assetMovements: Record<string, number>;
  };
}

export interface NormalizedEffect {
  id: string;
  type: string;
  account: string | null;
  asset: string | null;
  amount: string | null;
  operation: string | null;
  transaction: string | null;
  ledger: string | null;
  timestamp: string | null;
  raw: Record<string, unknown>;
}

export interface PathsReport {
  mode: 'strict-send' | 'strict-receive';
  count: number;
  shortestRoute: NormalizedPath | null;
  bestRoute: NormalizedPath | null;
  routes: NormalizedPath[];
}

export interface NormalizedPath {
  sourceAsset: string;
  sourceAmount: string;
  destinationAsset: string;
  destinationAmount: string;
  path: string[];
  hops: number;
  effectiveRate: number | null;
  raw: Record<string, unknown>;
}

export async function inspectAccountData(
  horizonUrl: string,
  accountId: string,
  key?: string,
  prefix?: string,
): Promise<AccountDataReport> {
  validateAccount(accountId);
  const base = normalizeHorizonUrl(horizonUrl);
  const account = await fetchJson<Record<string, unknown>>(`${base}/accounts/${accountId}`);
  const data = (account.data as Record<string, string> | undefined) ?? {};
  const entries = Object.entries(data)
    .filter(([entryKey]) => (key ? entryKey === key : true))
    .filter(([entryKey]) => (prefix ? entryKey.startsWith(prefix) : true))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([entryKey, raw]) => decodeDataEntry(entryKey, raw));
  const totalBytes = entries.reduce((sum, entry) => sum + entry.byteLength, 0);
  const largest = entries.reduce<(typeof entries)[number] | null>(
    (current, entry) => (!current || entry.byteLength > current.byteLength ? entry : current),
    null,
  );
  return {
    accountId,
    entries,
    summary: {
      count: entries.length,
      totalBytes,
      largestEntry: largest?.key ?? null,
      averageBytes: entries.length > 0 ? totalBytes / entries.length : 0,
    },
  };
}

export async function analyzeTransactionEffects(
  horizonUrl: string,
  hash: string,
  limit: number,
): Promise<EffectsReport> {
  if (!TX_HASH_RE.test(hash))
    throw new Error('Transaction hash must be a 64-character hex string.');
  const base = normalizeHorizonUrl(horizonUrl);
  const metadata = await fetchJson<Record<string, unknown>>(`${base}/transactions/${hash}`);
  const effects = await fetchEffects(`${base}/transactions/${hash}/effects`, limit);
  return buildEffectsReport(hash, 'transaction', effects, metadata);
}

export async function inspectOperationEffects(
  horizonUrl: string,
  operationId: string,
  limit: number,
): Promise<EffectsReport> {
  if (!OPERATION_ID_RE.test(operationId)) throw new Error('Operation ID must be numeric.');
  const base = normalizeHorizonUrl(horizonUrl);
  const metadata = await fetchJson<Record<string, unknown>>(`${base}/operations/${operationId}`);
  const effects = await fetchEffects(`${base}/operations/${operationId}/effects`, limit);
  return buildEffectsReport(operationId, 'operation', effects, metadata);
}

export async function inspectPaths(options: {
  horizonUrl: string;
  mode: 'strict-send' | 'strict-receive';
  sourceAsset?: string;
  sourceAmount?: string;
  sourceAccount?: string;
  destinationAsset?: string;
  destinationAmount?: string;
  destinationAccount?: string;
  sort?: 'destination' | 'source' | 'hops' | 'rate';
  limit?: number;
}): Promise<PathsReport> {
  const base = normalizeHorizonUrl(options.horizonUrl);
  const url = new URL(
    `${base}/${options.mode === 'strict-send' ? 'paths/strict-send' : 'paths/strict-receive'}`,
  );
  if (options.mode === 'strict-send') {
    requireAmount(options.sourceAmount, 'source amount');
    if (!options.destinationAccount || !ACCOUNT_ID_RE.test(options.destinationAccount)) {
      throw new Error('A valid destination account is required for strict-send paths.');
    }
    applyAssetParams(url, 'source_', options.sourceAsset ?? 'native');
    url.searchParams.set('source_amount', options.sourceAmount);
    url.searchParams.set('destination_account', options.destinationAccount);
  } else {
    requireAmount(options.destinationAmount, 'destination amount');
    if (!options.sourceAccount || !ACCOUNT_ID_RE.test(options.sourceAccount)) {
      throw new Error('A valid source account is required for strict-receive paths.');
    }
    url.searchParams.set('source_account', options.sourceAccount);
    applyAssetParams(url, 'destination_', options.destinationAsset ?? 'native');
    url.searchParams.set('destination_amount', options.destinationAmount);
  }
  const payload = await fetchJson<{ _embedded?: { records?: Array<Record<string, unknown>> } }>(
    url.toString(),
  );
  const routes = (payload._embedded?.records ?? []).map(normalizePath);
  const sorted = sortRoutes(routes, options.sort ?? 'rate').slice(0, clampLimit(options.limit));
  return {
    mode: options.mode,
    count: sorted.length,
    shortestRoute: sorted.reduce<NormalizedPath | null>(
      (best, route) => (!best || route.hops < best.hops ? route : best),
      null,
    ),
    bestRoute: sorted[0] ?? null,
    routes: sorted,
  };
}

export function formatAccountDataReport(report: AccountDataReport): string {
  const lines = [
    '=== Account Data Entries ===',
    `Account: ${report.accountId}`,
    `Entries: ${report.summary.count}`,
    `Total bytes: ${report.summary.totalBytes}`,
    `Largest entry: ${report.summary.largestEntry ?? 'None'}`,
    `Average bytes: ${report.summary.averageBytes.toFixed(2)}`,
  ];
  if (report.entries.length === 0) return `${lines.join('\n')}\nNo matching data entries found.`;
  lines.push('', 'Entries:');
  for (const entry of report.entries) {
    lines.push(
      `- ${entry.key}: ${entry.byteLength} byte(s), ${entry.binary ? 'binary' : `text "${entry.utf8}"`}, raw ${entry.raw}`,
    );
  }
  return lines.join('\n');
}

export function formatEffectsReport(report: EffectsReport): string {
  const lines = [
    `=== ${report.type === 'transaction' ? 'Transaction' : 'Operation'} Effects ===`,
    `Subject: ${report.subject}`,
    `Effects: ${report.summary.count}`,
    '',
    'Effect counts:',
  ];
  for (const [type, count] of Object.entries(report.summary.byType))
    lines.push(`- ${type}: ${count}`);
  if (report.effects.length === 0) lines.push('- No effects returned by Horizon.');
  lines.push('', 'Effects:');
  for (const effect of report.effects) {
    lines.push(
      `- ${effect.id} ${effect.type} account=${effect.account ?? 'n/a'} asset=${effect.asset ?? 'n/a'} amount=${effect.amount ?? 'n/a'}`,
    );
  }
  return lines.join('\n');
}

export function formatPathsReport(report: PathsReport): string {
  const lines = [`=== Path Payment Routes (${report.mode}) ===`, `Routes: ${report.count}`];
  if (report.count === 0) return `${lines.join('\n')}\nNo viable paths returned by Horizon.`;
  if (report.shortestRoute) lines.push(`Shortest route hops: ${report.shortestRoute.hops}`);
  if (report.bestRoute) lines.push(`Best route rate: ${report.bestRoute.effectiveRate ?? 'n/a'}`);
  lines.push('', 'Routes:');
  for (const route of report.routes) {
    lines.push(
      `- ${route.sourceAmount} ${route.sourceAsset} -> ${route.destinationAmount} ${route.destinationAsset}; hops=${route.hops}; path=${route.path.join(' > ') || '(direct)'}; rate=${route.effectiveRate ?? 'n/a'}`,
    );
  }
  return lines.join('\n');
}

function decodeDataEntry(key: string, raw: string): AccountDataReport['entries'][number] {
  const bytes = Buffer.from(raw, 'base64');
  const utf8 = bytes.toString('utf8');
  const binary = utf8.includes('\uFFFD') || /[\x00-\x08\x0E-\x1F]/.test(utf8);
  return {
    key,
    raw,
    byteLength: bytes.length,
    utf8: binary ? null : utf8,
    hex: bytes.toString('hex'),
    binary,
  };
}

async function fetchEffects(url: string, limit: number): Promise<NormalizedEffect[]> {
  const effects: NormalizedEffect[] = [];
  let nextUrl: string | undefined = withLimit(url, clampLimit(limit));
  while (nextUrl && effects.length < clampLimit(limit)) {
    const payload = await fetchJson<{
      _embedded?: { records?: Array<Record<string, unknown>> };
      _links?: { next?: { href?: string } };
    }>(nextUrl);
    for (const record of payload._embedded?.records ?? []) {
      effects.push(normalizeEffect(record));
      if (effects.length >= clampLimit(limit)) break;
    }
    nextUrl = payload._links?.next?.href;
  }
  return effects;
}

function buildEffectsReport(
  subject: string,
  type: 'transaction' | 'operation',
  effects: NormalizedEffect[],
  metadata: Record<string, unknown>,
): EffectsReport {
  const summary: EffectsReport['summary'] = {
    count: effects.length,
    byType: {},
    accounts: {},
    assets: {},
    assetMovements: {},
  };
  for (const effect of effects) {
    summary.byType[effect.type] = (summary.byType[effect.type] ?? 0) + 1;
    if (effect.account)
      summary.accounts[effect.account] = (summary.accounts[effect.account] ?? 0) + 1;
    if (effect.asset) summary.assets[effect.asset] = (summary.assets[effect.asset] ?? 0) + 1;
    if (effect.asset && effect.amount) {
      summary.assetMovements[effect.asset] =
        (summary.assetMovements[effect.asset] ?? 0) + (Number.parseFloat(effect.amount) || 0);
    }
  }
  return { subject, type, metadata, effects, summary };
}

function normalizeEffect(record: Record<string, unknown>): NormalizedEffect {
  return {
    id: String(record.id ?? 'unknown'),
    type: String(record.type ?? 'unknown'),
    account:
      stringField(record, 'account') ??
      stringField(record, 'account_id') ??
      stringField(record, 'funder'),
    asset: effectAsset(record),
    amount: stringField(record, 'amount') ?? stringField(record, 'starting_balance'),
    operation: linkTail(record, 'operation') ?? stringField(record, 'operation_id'),
    transaction: linkTail(record, 'transaction') ?? stringField(record, 'transaction_hash'),
    ledger: linkTail(record, 'ledger'),
    timestamp: stringField(record, 'created_at'),
    raw: record,
  };
}

function normalizePath(record: Record<string, unknown>): NormalizedPath {
  const sourceAmount = String(record.source_amount ?? '0');
  const destinationAmount = String(
    record.destination_amount ?? record.destination_amount_min ?? '0',
  );
  const path = ((record.path as Array<Record<string, unknown>> | undefined) ?? []).map(assetLabel);
  const sourceAsset = assetFromPrefixed(record, 'source_');
  const destinationAsset = assetFromPrefixed(record, 'destination_');
  const source = Number.parseFloat(sourceAmount) || 0;
  const destination = Number.parseFloat(destinationAmount) || 0;
  return {
    sourceAsset,
    sourceAmount,
    destinationAsset,
    destinationAmount,
    path,
    hops: path.length,
    effectiveRate: source > 0 && destination > 0 ? destination / source : null,
    raw: record,
  };
}

function sortRoutes(
  routes: NormalizedPath[],
  sort: 'destination' | 'source' | 'hops' | 'rate',
): NormalizedPath[] {
  return [...routes].sort((a, b) => {
    if (sort === 'hops') return a.hops - b.hops;
    if (sort === 'source')
      return (Number.parseFloat(a.sourceAmount) || 0) - (Number.parseFloat(b.sourceAmount) || 0);
    if (sort === 'destination')
      return (
        (Number.parseFloat(b.destinationAmount) || 0) -
        (Number.parseFloat(a.destinationAmount) || 0)
      );
    return (b.effectiveRate ?? 0) - (a.effectiveRate ?? 0);
  });
}

function applyAssetParams(url: URL, prefix: string, asset: string): void {
  if (asset === 'native' || asset.toUpperCase() === 'XLM') {
    url.searchParams.set(`${prefix}asset_type`, 'native');
    return;
  }
  const [code, issuer] = asset.split(':');
  if (!code || !issuer || !ACCOUNT_ID_RE.test(issuer)) {
    throw new Error('Issued assets must use CODE:G... format.');
  }
  url.searchParams.set(
    `${prefix}asset_type`,
    code.length <= 4 ? 'credit_alphanum4' : 'credit_alphanum12',
  );
  url.searchParams.set(`${prefix}asset_code`, code);
  url.searchParams.set(`${prefix}asset_issuer`, issuer);
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { headers: { 'User-Agent': 'Stellar-API-Inspector/1.0' } });
  if (response.status === 404) throw new Error(`Horizon resource not found: ${url}`);
  if (!response.ok) throw new Error(`Horizon request failed: HTTP ${response.status}`);
  return (await response.json()) as T;
}

function validateAccount(accountId: string): void {
  if (!ACCOUNT_ID_RE.test(accountId))
    throw new Error('Account ID must be a valid Stellar public key.');
}

function requireAmount(amount: string | undefined, label: string): void {
  if (!amount || Number.parseFloat(amount) <= 0)
    throw new Error(`A positive ${label} is required.`);
}

function clampLimit(limit: number | undefined): number {
  return Math.max(1, Math.min(200, Math.floor(limit ?? 20)));
}

function withLimit(url: string, limit: number): string {
  const next = new URL(url);
  next.searchParams.set('limit', String(limit));
  next.searchParams.set('order', 'asc');
  return next.toString();
}

function stringField(record: Record<string, unknown>, key: string): string | null {
  return record[key] === undefined || record[key] === null ? null : String(record[key]);
}

function linkTail(record: Record<string, unknown>, name: string): string | null {
  const href =
    (record._links as Record<string, { href?: string }> | undefined)?.[name]?.href ?? null;
  return href ? (href.split('/').filter(Boolean).pop() ?? null) : null;
}

function effectAsset(record: Record<string, unknown>): string | null {
  if (record.asset_type === 'native') return 'XLM';
  if (record.asset) return String(record.asset);
  if (record.asset_code)
    return `${record.asset_code}:${String(record.asset_issuer ?? '').slice(0, 8)}...`;
  return null;
}

function assetFromPrefixed(record: Record<string, unknown>, prefix: string): string {
  return assetLabel({
    asset_type: record[`${prefix}asset_type`],
    asset_code: record[`${prefix}asset_code`],
    asset_issuer: record[`${prefix}asset_issuer`],
  });
}

function assetLabel(asset: Record<string, unknown>): string {
  if (asset.asset_type === 'native' || asset.type === 'native') return 'XLM';
  const code = asset.asset_code ?? asset.code ?? 'Unknown';
  const issuer = asset.asset_issuer ?? asset.issuer;
  return issuer ? `${code}:${String(issuer).slice(0, 8)}...` : String(code);
}
