import { normalizeHorizonUrl } from '../utils/urls';

const ACCOUNT_ID_RE = /^G[A-Z2-7]{55}$/;
const POOL_ID_RE = /^[0-9a-fA-F]{64}$/;

export interface SponsorshipReport {
  accountId: string;
  horizonUrl: string;
  sponsoredReserve: number;
  sponsoringReserve: number;
  sponsoredEntries: Array<{ type: string; id: string; sponsor: string }>;
  unresolved: string[];
  summaryByType: Record<string, number>;
}

export interface LiquidityPoolReport {
  id: string;
  horizonUrl: string;
  type: string;
  feeBp: number | null;
  totalTrustlines: string;
  totalShares: string;
  reserves: Array<{ asset: string; amount: string; sharePercent: number | null }>;
  reserveRatio: string | null;
  spotPrice: number | null;
  lastModifiedLedger: number | null;
  lastModifiedTime: string | null;
  activity?: {
    inspected: number;
    trades: number;
    operations: number;
    transactions: number;
    errors: string[];
  };
}

export function validateAccountId(accountId: string): { valid: boolean; error?: string } {
  if (!ACCOUNT_ID_RE.test(accountId)) {
    return { valid: false, error: 'Account ID must be a valid Stellar public key.' };
  }
  return { valid: true };
}

export function validateLiquidityPoolId(poolId: string): { valid: boolean; error?: string } {
  if (!POOL_ID_RE.test(poolId)) {
    return { valid: false, error: 'Liquidity pool ID must be a 64-character hex string.' };
  }
  return { valid: true };
}

export async function inspectSponsorship(
  horizonUrl: string,
  accountId: string,
): Promise<SponsorshipReport> {
  const validation = validateAccountId(accountId);
  if (!validation.valid) throw new Error(validation.error);

  const base = normalizeHorizonUrl(horizonUrl);
  const account = await fetchJson<Record<string, unknown>>(`${base}/accounts/${accountId}`);
  const sponsoredEntries: SponsorshipReport['sponsoredEntries'] = [];
  const unresolved: string[] = [];

  const balances = (account.balances as Array<Record<string, unknown>> | undefined) ?? [];
  for (const balance of balances) {
    if (balance.sponsor) {
      sponsoredEntries.push({
        type: 'trustline',
        id: assetLabel(balance),
        sponsor: String(balance.sponsor),
      });
    }
  }

  const signers = (account.signers as Array<Record<string, unknown>> | undefined) ?? [];
  for (const signer of signers) {
    if (signer.sponsor) {
      sponsoredEntries.push({
        type: 'signer',
        id: String(signer.key ?? 'unknown'),
        sponsor: String(signer.sponsor),
      });
    }
  }

  const data = (account.data as Record<string, unknown> | undefined) ?? {};
  if (Object.keys(data).length > 0) {
    unresolved.push(
      'Account data sponsorship details are not exposed in the loaded account data payload.',
    );
  }

  const summaryByType = sponsoredEntries.reduce<Record<string, number>>((summary, entry) => {
    summary[entry.type] = (summary[entry.type] ?? 0) + 1;
    return summary;
  }, {});

  const sponsoredReserve = numberField(account, 'num_sponsored');
  const sponsoringReserve = numberField(account, 'num_sponsoring');
  if (sponsoredReserve === 0 && sponsoringReserve === 0 && sponsoredEntries.length === 0) {
    unresolved.push('No current sponsorship relationships were found for this account.');
  }

  return {
    accountId,
    horizonUrl: base,
    sponsoredReserve,
    sponsoringReserve,
    sponsoredEntries,
    unresolved,
    summaryByType,
  };
}

export async function inspectLiquidityPool(
  horizonUrl: string,
  poolId: string,
  includeActivity: boolean,
  limit: number,
): Promise<LiquidityPoolReport> {
  const validation = validateLiquidityPoolId(poolId);
  if (!validation.valid) throw new Error(validation.error);

  const base = normalizeHorizonUrl(horizonUrl);
  const pool = await fetchJson<Record<string, unknown>>(`${base}/liquidity_pools/${poolId}`);
  const reservesRaw = (pool.reserves as Array<Record<string, unknown>> | undefined) ?? [];
  const totalReserve = reservesRaw.reduce(
    (sum, reserve) => sum + (Number.parseFloat(String(reserve.amount ?? '0')) || 0),
    0,
  );
  const reserves = reservesRaw.map((reserve) => {
    const amount = Number.parseFloat(String(reserve.amount ?? '0')) || 0;
    return {
      asset: String(reserve.asset ?? 'Unknown'),
      amount: String(reserve.amount ?? '0'),
      sharePercent: totalReserve > 0 ? (amount / totalReserve) * 100 : null,
    };
  });
  const first = Number.parseFloat(reserves[0]?.amount ?? '0') || 0;
  const second = Number.parseFloat(reserves[1]?.amount ?? '0') || 0;
  const report: LiquidityPoolReport = {
    id: String(pool.id ?? poolId),
    horizonUrl: base,
    type: String(pool.type ?? 'Unknown'),
    feeBp: typeof pool.fee_bp === 'number' ? pool.fee_bp : null,
    totalTrustlines: String(pool.total_trustlines ?? 'Unknown'),
    totalShares: String(pool.total_shares ?? 'Unknown'),
    reserves,
    reserveRatio: first > 0 && second > 0 ? `${first}:${second}` : null,
    spotPrice: first > 0 && second > 0 ? second / first : null,
    lastModifiedLedger:
      typeof pool.last_modified_ledger === 'number' ? pool.last_modified_ledger : null,
    lastModifiedTime: (pool.last_modified_time as string | undefined) ?? null,
  };

  if (includeActivity) {
    report.activity = await inspectPoolActivity(base, poolId, limit);
  }

  return report;
}

export function formatSponsorshipReport(report: SponsorshipReport): string {
  const lines = [
    '=== Account Sponsorship Audit ===',
    `Account: ${report.accountId}`,
    `Reserves sponsored for account: ${report.sponsoredReserve}`,
    `Reserves sponsored by account: ${report.sponsoringReserve}`,
    '',
    'Sponsored entries:',
  ];
  if (report.sponsoredEntries.length === 0) {
    lines.push('- None found in account payload');
  } else {
    for (const entry of report.sponsoredEntries) {
      lines.push(`- ${entry.type} ${entry.id} sponsored by ${entry.sponsor}`);
    }
  }
  lines.push('', 'Summary by type:');
  const summaries = Object.entries(report.summaryByType);
  if (summaries.length === 0) lines.push('- none');
  for (const [type, count] of summaries) lines.push(`- ${type}: ${count}`);
  if (report.unresolved.length > 0) {
    lines.push('', 'Notes:');
    for (const note of report.unresolved) lines.push(`- ${note}`);
  }
  return lines.join('\n');
}

export function formatLiquidityPoolReport(report: LiquidityPoolReport): string {
  const lines = [
    '=== Liquidity Pool Inspection ===',
    `Pool: ${report.id}`,
    `Type: ${report.type}`,
    `Fee: ${report.feeBp ?? 'Unknown'} bp`,
    `Total trustlines: ${report.totalTrustlines}`,
    `Total shares: ${report.totalShares}`,
    `Last modified ledger: ${report.lastModifiedLedger ?? 'Unknown'}`,
    `Last modified time: ${report.lastModifiedTime ?? 'Unknown'}`,
    `Reserve ratio: ${report.reserveRatio ?? 'Unavailable'}`,
    `Spot price: ${report.spotPrice ?? 'Unavailable'}`,
    '',
    'Reserves:',
  ];
  for (const reserve of report.reserves) {
    lines.push(
      `- ${reserve.asset}: ${reserve.amount} (${reserve.sharePercent === null ? 'n/a' : `${reserve.sharePercent.toFixed(2)}%`})`,
    );
  }
  if (report.activity) {
    lines.push(
      '',
      `Activity inspected: ${report.activity.inspected}`,
      `Trades: ${report.activity.trades}`,
      `Operations: ${report.activity.operations}`,
      `Transactions: ${report.activity.transactions}`,
    );
    for (const error of report.activity.errors) lines.push(`- ${error}`);
  }
  return lines.join('\n');
}

async function inspectPoolActivity(
  base: string,
  poolId: string,
  limit: number,
): Promise<NonNullable<LiquidityPoolReport['activity']>> {
  const activity = {
    inspected: 0,
    trades: 0,
    operations: 0,
    transactions: 0,
    errors: [] as string[],
  };
  const safeLimit = Math.max(1, Math.min(200, Math.floor(limit)));
  for (const [kind, path] of [
    ['trades', 'trades'],
    ['operations', 'operations'],
    ['transactions', 'transactions'],
  ] as const) {
    try {
      const url = new URL(`${base}/liquidity_pools/${poolId}/${path}`);
      url.searchParams.set('limit', String(safeLimit));
      url.searchParams.set('order', 'desc');
      const payload = await fetchJson<{ _embedded?: { records?: unknown[] } }>(url.toString());
      const count = payload._embedded?.records?.length ?? 0;
      activity[kind] = count;
      activity.inspected += count;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      activity.errors.push(`${kind} unavailable: ${message}`);
    }
  }
  return activity;
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { headers: { 'User-Agent': 'Stellar-API-Inspector/1.0' } });
  if (response.status === 404) throw new Error(`Horizon resource not found: ${url}`);
  if (!response.ok) throw new Error(`Horizon request failed: HTTP ${response.status}`);
  return (await response.json()) as T;
}

function numberField(record: Record<string, unknown>, key: string): number {
  return Number.parseInt(String(record[key] ?? '0'), 10) || 0;
}

function assetLabel(balance: Record<string, unknown>): string {
  if (balance.asset_type === 'native') return 'XLM';
  return `${balance.asset_code ?? 'Unknown'}:${String(balance.asset_issuer ?? '').slice(0, 8)}...`;
}
