import { normalizeHorizonUrl } from '../utils/urls';

const ACCOUNT_ID_RE = /^G[A-Z2-7]{55}$/;
const CLAIMABLE_BALANCE_ID_RE = /^[0-9a-fA-F]{64}$/;

export interface OffersQuery {
  horizonUrl: string;
  accountId: string;
  limit?: number;
  cursor?: string;
  order?: 'asc' | 'desc';
}

export interface OfferSummary {
  pair: string;
  count: number;
  totalAmount: number;
  minPrice: number | null;
  maxPrice: number | null;
}

export interface AccountOffersReport {
  accountId: string;
  horizonUrl: string;
  count: number;
  distinctPairs: number;
  offers: Array<Record<string, unknown>>;
  pairs: OfferSummary[];
}

export interface ClaimableBalanceReport {
  id: string;
  horizonUrl: string;
  asset: string;
  amount: string;
  sponsor: string | null;
  lastModifiedLedger: number | null;
  lastModifiedTime: string | null;
  claimants: Array<{
    destination: string;
    predicate: unknown;
    description: string;
  }>;
}

export function validateAccountId(accountId: string): { valid: boolean; error?: string } {
  if (!ACCOUNT_ID_RE.test(accountId)) {
    return { valid: false, error: 'Account ID must be a valid Stellar public key.' };
  }
  return { valid: true };
}

export function validateClaimableBalanceId(balanceId: string): { valid: boolean; error?: string } {
  if (!CLAIMABLE_BALANCE_ID_RE.test(balanceId)) {
    return { valid: false, error: 'Claimable balance ID must be a 64-character hex string.' };
  }
  return { valid: true };
}

export async function inspectAccountOffers(query: OffersQuery): Promise<AccountOffersReport> {
  const validation = validateAccountId(query.accountId);
  if (!validation.valid) throw new Error(validation.error);

  const base = normalizeHorizonUrl(query.horizonUrl);
  const url = new URL(`${base}/accounts/${encodeURIComponent(query.accountId)}/offers`);
  url.searchParams.set('limit', String(clamp(query.limit ?? 20, 1, 200)));
  url.searchParams.set('order', query.order ?? 'desc');
  if (query.cursor) url.searchParams.set('cursor', query.cursor);

  const response = await fetch(url, { headers: userAgent() });
  if (!response.ok)
    throw new Error(`Horizon account offers request failed: HTTP ${response.status}`);
  const payload = (await response.json()) as {
    _embedded?: { records?: Array<Record<string, unknown>> };
  };
  const offers = payload._embedded?.records ?? [];
  const pairMap = new Map<string, OfferSummary>();

  for (const offer of offers) {
    const selling = assetLabel(offer.selling as Record<string, unknown> | undefined);
    const buying = assetLabel(offer.buying as Record<string, unknown> | undefined);
    const pair = `${selling} -> ${buying}`;
    const amount = Number.parseFloat(String(offer.amount ?? '0')) || 0;
    const price = Number.parseFloat(String(offer.price ?? '')) || null;
    const summary = pairMap.get(pair) ?? {
      pair,
      count: 0,
      totalAmount: 0,
      minPrice: null,
      maxPrice: null,
    };
    summary.count += 1;
    summary.totalAmount += amount;
    if (price !== null) {
      summary.minPrice = summary.minPrice === null ? price : Math.min(summary.minPrice, price);
      summary.maxPrice = summary.maxPrice === null ? price : Math.max(summary.maxPrice, price);
    }
    pairMap.set(pair, summary);
  }

  return {
    accountId: query.accountId,
    horizonUrl: base,
    count: offers.length,
    distinctPairs: pairMap.size,
    offers,
    pairs: [...pairMap.values()],
  };
}

export async function inspectClaimableBalance(
  horizonUrl: string,
  balanceId: string,
): Promise<ClaimableBalanceReport> {
  const validation = validateClaimableBalanceId(balanceId);
  if (!validation.valid) throw new Error(validation.error);

  const base = normalizeHorizonUrl(horizonUrl);
  const response = await fetch(`${base}/claimable_balances/${encodeURIComponent(balanceId)}`, {
    headers: userAgent(),
  });
  if (response.status === 404) throw new Error(`Claimable balance not found: ${balanceId}`);
  if (!response.ok)
    throw new Error(`Horizon claimable balance request failed: HTTP ${response.status}`);

  const balance = (await response.json()) as Record<string, unknown>;
  const claimants = ((balance.claimants as Array<Record<string, unknown>> | undefined) ?? []).map(
    (claimant) => ({
      destination: String(claimant.destination ?? 'Unknown'),
      predicate: claimant.predicate,
      description: describePredicate(claimant.predicate),
    }),
  );

  return {
    id: String(balance.id ?? balanceId),
    horizonUrl: base,
    asset: String(balance.asset ?? 'Unknown'),
    amount: String(balance.amount ?? '0'),
    sponsor: (balance.sponsor as string | undefined) ?? null,
    lastModifiedLedger:
      typeof balance.last_modified_ledger === 'number' ? balance.last_modified_ledger : null,
    lastModifiedTime: (balance.last_modified_time as string | undefined) ?? null,
    claimants,
  };
}

export function formatOffersReport(report: AccountOffersReport): string {
  const lines = [
    `=== Account Open Offers ===`,
    `Account: ${report.accountId}`,
    `Open offers: ${report.count}`,
    `Distinct pairs: ${report.distinctPairs}`,
  ];
  if (report.count === 0) return `${lines.join('\n')}\nNo active offers found.`;
  lines.push('', 'Pairs:');
  for (const pair of report.pairs) {
    lines.push(
      `- ${pair.pair}: ${pair.count} offer(s), total ${pair.totalAmount}, price ${pair.minPrice ?? 'n/a'} - ${pair.maxPrice ?? 'n/a'}`,
    );
  }
  lines.push('', 'Offers:');
  for (const offer of report.offers) {
    const selling = assetLabel(offer.selling as Record<string, unknown> | undefined);
    const buying = assetLabel(offer.buying as Record<string, unknown> | undefined);
    const priceR = offer.price_r as { n?: unknown; d?: unknown } | undefined;
    lines.push(
      `- #${offer.id ?? 'unknown'} ${offer.amount ?? '0'} ${selling} for ${buying} at ${offer.price ?? 'n/a'} (${priceR?.n ?? '?'}/${priceR?.d ?? '?'}) ledger ${offer.last_modified_ledger ?? 'unknown'} ${offer.last_modified_time ?? ''}`,
    );
  }
  return lines.join('\n');
}

export function formatClaimableBalanceReport(report: ClaimableBalanceReport): string {
  const lines = [
    `=== Claimable Balance ===`,
    `ID: ${report.id}`,
    `Asset: ${report.asset}`,
    `Amount: ${report.amount}`,
    `Sponsor: ${report.sponsor ?? 'None'}`,
    `Last modified ledger: ${report.lastModifiedLedger ?? 'Unknown'}`,
    `Last modified time: ${report.lastModifiedTime ?? 'Unknown'}`,
    `Claimants: ${report.claimants.length}`,
  ];
  for (const claimant of report.claimants) {
    lines.push(`- ${claimant.destination}: ${claimant.description}`);
  }
  return lines.join('\n');
}

function describePredicate(predicate: unknown): string {
  if (!predicate || typeof predicate !== 'object') return 'Unconditional claim';
  const p = predicate as Record<string, unknown>;
  if (p.unconditional === true) return 'Unconditional claim';
  if (p.abs_before) return `Claimable before ${p.abs_before}`;
  if (p.rel_before) return `Claimable within ${p.rel_before} seconds of balance creation`;
  if (Array.isArray(p.and)) return `All conditions: ${p.and.map(describePredicate).join('; ')}`;
  if (Array.isArray(p.or)) return `Any condition: ${p.or.map(describePredicate).join('; ')}`;
  if (p.not) return `Not (${describePredicate(p.not)})`;
  return 'Unknown predicate; raw predicate preserved in JSON output';
}

function assetLabel(asset: Record<string, unknown> | undefined): string {
  if (!asset) return 'Unknown';
  if (asset.asset_type === 'native' || asset.type === 'native') return 'XLM';
  const code = asset.asset_code ?? asset.code ?? 'Unknown';
  const issuer = asset.asset_issuer ?? asset.issuer;
  return issuer ? `${code}:${String(issuer).slice(0, 8)}...` : String(code);
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function userAgent(): Record<string, string> {
  return { 'User-Agent': 'Stellar-API-Inspector/1.0' };
}
