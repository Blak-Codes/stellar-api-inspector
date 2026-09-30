import { StrKey } from '@stellar/stellar-sdk';
import { normalizeHorizonUrl } from '../utils/urls';

export type MergeAuditStatus =
  | 'ready'
  | 'requires-cleanup'
  | 'destination-unavailable'
  | 'insufficient-information';

export interface MergeAuditOptions {
  historyDepth?: number;
}

export interface MergeAuditFinding {
  code: string;
  message: string;
  action: string;
}

export interface MergeAuditLiability {
  assetType: string;
  assetCode: string | null;
  assetIssuer: string | null;
  selling: string | null;
  buying: string | null;
}

export interface MergeAuditAccountState {
  accountId: string;
  exists: boolean | null;
  readable: boolean;
  error: string | null;
  nativeBalance: string | null;
  estimatedTransferableBalance: string | null;
  sellingLiabilities: string | null;
  buyingLiabilities: string | null;
  subentryCount: number | null;
  remainingSubentries: number | null;
  offerCount: number | null;
  trustlineCount: number | null;
  dataEntryCount: number | null;
  signerCount: number | null;
  additionalSignerCount: number | null;
  numSponsoring: number | null;
  numSponsored: number | null;
  sponsorshipRelationships: number | null;
  liabilities: MergeAuditLiability[] | null;
  raw: Record<string, unknown> | null;
  rawOffers: Record<string, unknown>[] | null;
}

export interface AccountMergeAuditReport {
  sourceAccount: MergeAuditAccountState;
  destinationAccount: MergeAuditAccountState;
  status: MergeAuditStatus;
  findings: MergeAuditFinding[];
  historicalInspection: {
    requestedDepth: number;
    inspected: boolean;
    records: Record<string, unknown>[];
    error: string | null;
  };
  readOnly: true;
}

interface HorizonCollection {
  _embedded?: { records?: Record<string, unknown>[] };
  _links?: { next?: { href?: string } };
}

const MAX_HISTORY_DEPTH = 200;
const MAX_OFFER_PAGES = 100;

export function validateMergeAccountIds(
  sourceAccount: string,
  destinationAccount: string,
): { valid: boolean; error?: string } {
  if (!StrKey.isValidEd25519PublicKey(sourceAccount)) {
    return { valid: false, error: 'Invalid source Stellar account ID' };
  }
  if (!StrKey.isValidEd25519PublicKey(destinationAccount)) {
    return { valid: false, error: 'Invalid destination Stellar account ID' };
  }
  if (sourceAccount === destinationAccount) {
    return { valid: false, error: 'Source and destination accounts must be distinct' };
  }
  return { valid: true };
}

export async function auditAccountMerge(
  horizonUrl: string,
  sourceAccountId: string,
  destinationAccountId: string,
  options: MergeAuditOptions = {},
): Promise<AccountMergeAuditReport> {
  const validation = validateMergeAccountIds(sourceAccountId, destinationAccountId);
  if (!validation.valid) throw new Error(validation.error);

  const baseUrl = normalizeHorizonUrl(horizonUrl);
  const source = await inspectAccount(baseUrl, sourceAccountId, true);
  const destination = await inspectAccount(baseUrl, destinationAccountId, false);
  const requestedDepth = clampHistoryDepth(options.historyDepth ?? 0);
  const historicalInspection =
    requestedDepth > 0
      ? await inspectHistory(baseUrl, sourceAccountId, requestedDepth)
      : { requestedDepth, inspected: false, records: [], error: null };
  const findings: MergeAuditFinding[] = [];

  if (!source.readable) {
    findings.push({
      code: 'source-unavailable',
      message: `Source account could not be read: ${source.error ?? 'unknown Horizon error'}`,
      action: 'Verify the source account ID and Horizon endpoint, then retry.',
    });
  }

  if (!destination.readable) {
    findings.push({
      code: 'destination-unavailable',
      message: `Destination account is missing or unreadable: ${destination.error ?? 'unknown Horizon error'}`,
      action:
        'Fund or restore the destination account, or verify Horizon access before considering a merge.',
    });
  }

  if (source.readable) {
    addStateFindings(source, findings);
    if (historicalInspection.error) {
      findings.push({
        code: 'history-unavailable',
        message: `Historical account activity could not be fully inspected: ${historicalInspection.error}`,
        action:
          'Retry with a reachable Horizon history archive or treat sponsorship history as unknown.',
      });
    }
    if (source.raw && hasMissingDecisionFields(source.raw)) {
      findings.push({
        code: 'missing-account-fields',
        message: 'Horizon omitted account fields required to establish merge readiness.',
        action:
          'Use a Horizon version that exposes account balances, signers, data, subentry, liabilities, and sponsorship counters.',
      });
    }
  }

  let status: MergeAuditStatus;
  if (!destination.readable) {
    status = 'destination-unavailable';
  } else if (
    !source.readable ||
    findings.some((finding) =>
      [
        'history-unavailable',
        'missing-account-fields',
        'unclassified-subentries',
        'inconsistent-subentries',
        'invalid-account-values',
        'offers-unavailable',
        'sponsorship-unknown',
        'liabilities-unknown',
        'master-signer-unknown',
      ].includes(finding.code),
    )
  ) {
    status = 'insufficient-information';
  } else if (findings.some((finding) => finding.code !== 'destination-unavailable')) {
    status = 'requires-cleanup';
  } else {
    status = 'ready';
  }

  return {
    sourceAccount: source,
    destinationAccount: destination,
    status,
    findings,
    historicalInspection,
    readOnly: true,
  };
}

async function inspectAccount(
  baseUrl: string,
  accountId: string,
  inspectOffers: boolean,
): Promise<MergeAuditAccountState> {
  const empty: MergeAuditAccountState = {
    accountId,
    exists: null,
    readable: false,
    error: null,
    nativeBalance: null,
    estimatedTransferableBalance: null,
    sellingLiabilities: null,
    buyingLiabilities: null,
    subentryCount: null,
    remainingSubentries: null,
    offerCount: null,
    trustlineCount: null,
    dataEntryCount: null,
    signerCount: null,
    additionalSignerCount: null,
    numSponsoring: null,
    numSponsored: null,
    sponsorshipRelationships: null,
    liabilities: null,
    raw: null,
    rawOffers: null,
  };

  let raw: Record<string, unknown>;
  try {
    raw = await fetchJson(`${baseUrl}/accounts/${encodeURIComponent(accountId)}`);
  } catch (error) {
    return { ...empty, exists: isNotFound(error) ? false : null, error: errorMessage(error) };
  }

  const balances = Array.isArray(raw.balances) ? (raw.balances as Record<string, unknown>[]) : null;
  const signers = Array.isArray(raw.signers) ? (raw.signers as Record<string, unknown>[]) : null;
  const data = isRecord(raw.data) ? raw.data : null;
  const native = balances?.find((balance) => balance.asset_type === 'native');
  let offerCount: number | null = 0;
  let rawOffers: Record<string, unknown>[] | null = [];
  let offersError: string | null = null;
  if (inspectOffers) {
    try {
      rawOffers = await fetchOffers(baseUrl, accountId);
      offerCount = rawOffers.length;
    } catch (error) {
      offerCount = null;
      rawOffers = null;
      offersError = errorMessage(error);
    }
  }

  const nativeBalance = stringField(native, 'balance');
  const sellingLiabilities = stringField(native, 'selling_liabilities');
  const buyingLiabilities = stringField(native, 'buying_liabilities');
  const liabilities =
    balances?.map((balance) => ({
      assetType: typeof balance.asset_type === 'string' ? balance.asset_type : 'unknown',
      assetCode: typeof balance.asset_code === 'string' ? balance.asset_code : null,
      assetIssuer: typeof balance.asset_issuer === 'string' ? balance.asset_issuer : null,
      selling: stringField(balance, 'selling_liabilities'),
      buying: stringField(balance, 'buying_liabilities'),
    })) ?? null;
  const additionalSignerCount = signers
    ? signers.filter((signer) => signer.key !== accountId).length
    : null;
  const trustlineCount = balances
    ? balances.filter(
        (balance) =>
          typeof balance.asset_type === 'string' &&
          balance.asset_type !== 'native' &&
          balance.asset_type !== 'liquidity_pool_shares',
      ).length
    : null;
  const subentryCount = numberField(raw, 'subentry_count');
  const dataEntryCount = data ? Object.keys(data).length : null;
  const knownSubentries =
    offerCount === null ||
    trustlineCount === null ||
    dataEntryCount === null ||
    additionalSignerCount === null
      ? null
      : offerCount + trustlineCount + dataEntryCount + additionalSignerCount;
  const remainingSubentries =
    subentryCount !== null && knownSubentries !== null ? subentryCount - knownSubentries : null;
  const numSponsoring = numberField(raw, 'num_sponsoring');
  const numSponsored = numberField(raw, 'num_sponsored');

  return {
    ...empty,
    exists: true,
    readable: true,
    error: offersError,
    nativeBalance,
    estimatedTransferableBalance: calculateTransferableBalance(nativeBalance, sellingLiabilities),
    sellingLiabilities,
    buyingLiabilities,
    subentryCount,
    remainingSubentries,
    offerCount,
    trustlineCount,
    dataEntryCount,
    signerCount: signers?.length ?? null,
    additionalSignerCount,
    numSponsoring,
    numSponsored,
    sponsorshipRelationships:
      numSponsoring !== null && numSponsored !== null ? numSponsoring + numSponsored : null,
    liabilities,
    raw,
    rawOffers,
  };
}

function addStateFindings(state: MergeAuditAccountState, findings: MergeAuditFinding[]): void {
  const add = (code: string, message: string, action: string) =>
    findings.push({ code, message, action });
  if (state.offerCount === null) {
    add(
      'offers-unavailable',
      'Active offers could not be enumerated.',
      'Retry against a Horizon endpoint with offer access.',
    );
  } else if (state.offerCount > 0) {
    add(
      'active-offers',
      `Source account has ${state.offerCount} active offer(s).`,
      'Cancel or otherwise resolve all offers before merging.',
    );
  }
  if (state.trustlineCount !== null && state.trustlineCount > 0) {
    add(
      'trustlines',
      `Source account has ${state.trustlineCount} trustline(s).`,
      'Remove or resolve trustlines and associated balances before merging.',
    );
  }
  if (state.dataEntryCount !== null && state.dataEntryCount > 0) {
    const entryLabel = state.dataEntryCount === 1 ? 'entry' : 'entries';
    add(
      'data-entries',
      `Source account has ${state.dataEntryCount} account data ${entryLabel}.`,
      'Remove account data entries before merging.',
    );
  }
  if (state.additionalSignerCount !== null && state.additionalSignerCount > 0) {
    add(
      'additional-signers',
      `Source account has ${state.additionalSignerCount} additional signer(s).`,
      'Remove additional signers before merging.',
    );
  }
  if (state.numSponsoring === null || state.numSponsored === null) {
    add(
      'sponsorship-unknown',
      'Horizon did not provide both sponsorship counters.',
      'Inspect current sponsorship relationships with a Horizon version that exposes num_sponsoring and num_sponsored.',
    );
  } else if (state.sponsorshipRelationships! > 0) {
    add(
      'sponsorship-relationships',
      `Source account participates in ${state.sponsorshipRelationships} sponsorship relationship(s) (${state.numSponsoring} sponsoring, ${state.numSponsored} sponsored).`,
      'Resolve sponsored entries and sponsorship links before merging.',
    );
  }
  if (state.sellingLiabilities === null || state.buyingLiabilities === null) {
    add(
      'liabilities-unknown',
      'Native selling or buying liabilities are unavailable.',
      'Use a Horizon response that includes native balance liabilities.',
    );
  } else if (isPositive(state.sellingLiabilities) || isPositive(state.buyingLiabilities)) {
    add(
      'outstanding-liabilities',
      `Native liabilities remain (selling ${state.sellingLiabilities}, buying ${state.buyingLiabilities} XLM).`,
      'Cancel offers or otherwise resolve liabilities before merging.',
    );
  }
  const liabilitiesByAsset =
    state.liabilities?.filter(
      (liability) =>
        liability.assetType !== 'native' &&
        (isPositive(liability.selling ?? '0') || isPositive(liability.buying ?? '0')),
    ) ?? [];
  if (
    liabilitiesByAsset.length > 0 &&
    !findings.some((item) => item.code === 'outstanding-liabilities')
  ) {
    add(
      'outstanding-liabilities',
      'Non-native balance liabilities remain on the source account.',
      'Cancel offers or otherwise resolve all asset liabilities before merging.',
    );
  }
  if (
    state.nativeBalance === null ||
    state.estimatedTransferableBalance === null ||
    state.subentryCount === null ||
    state.signerCount === null ||
    state.dataEntryCount === null ||
    state.trustlineCount === null ||
    state.offerCount === null
  ) {
    add(
      'invalid-account-values',
      'One or more account fields could not be parsed.',
      'Inspect the raw account response and retry with complete Horizon data.',
    );
  }
  if (
    state.raw &&
    Array.isArray(state.raw.signers) &&
    !state.raw.signers.some((signer) => isRecord(signer) && signer.key === state.accountId)
  ) {
    add(
      'master-signer-unknown',
      'The account master signer was not present in the Horizon signer list.',
      'Inspect the raw signer list; signer counts cannot be interpreted safely without the master signer.',
    );
  }
  if (state.remainingSubentries === null) {
    add(
      'unclassified-subentries',
      'The account subentry count could not be reconciled with the observed offers, trustlines, data entries, and additional signers.',
      'Inspect all ledger entries and retry; readiness cannot be established from this response.',
    );
  } else if (state.remainingSubentries < 0) {
    add(
      'inconsistent-subentries',
      'Observed subentries exceed the account subentry count.',
      'Retry against a consistent Horizon snapshot and inspect the raw fields.',
    );
  } else if (state.remainingSubentries > 0) {
    add(
      'unclassified-subentries',
      `There are ${state.remainingSubentries} unclassified subentry/subentries.`,
      'Identify and remove the remaining ledger entries before merging.',
    );
  }
}

async function fetchOffers(baseUrl: string, accountId: string): Promise<Record<string, unknown>[]> {
  let nextUrl: string | undefined =
    `${baseUrl}/accounts/${encodeURIComponent(accountId)}/offers?limit=200`;
  const offers: Record<string, unknown>[] = [];
  let pages = 0;
  while (nextUrl && pages < MAX_OFFER_PAGES) {
    pages += 1;
    const collection = (await fetchJson(nextUrl)) as HorizonCollection;
    offers.push(...(collection._embedded?.records ?? []));
    nextUrl = collection._links?.next?.href;
  }
  if (nextUrl) throw new Error(`Offer history exceeded ${MAX_OFFER_PAGES} pages`);
  return offers;
}

async function inspectHistory(
  baseUrl: string,
  accountId: string,
  depth: number,
): Promise<AccountMergeAuditReport['historicalInspection']> {
  try {
    const response = (await fetchJson(
      `${baseUrl}/accounts/${encodeURIComponent(accountId)}/operations?order=desc&limit=${depth}`,
    )) as HorizonCollection;
    const records = response._embedded?.records ?? [];
    return {
      requestedDepth: depth,
      inspected: true,
      records: records.filter(
        (record) =>
          typeof record.type === 'string' &&
          /sponsor|trustline|data|offer|signer|set_options|account_merge/.test(record.type),
      ),
      error:
        response._links?.next?.href && records.length < depth
          ? 'Horizon returned a partial history page'
          : null,
    };
  } catch (error) {
    return { requestedDepth: depth, inspected: false, records: [], error: errorMessage(error) };
  }
}

async function fetchJson(url: string): Promise<Record<string, unknown>> {
  const response = await fetch(url, { headers: { 'User-Agent': 'Stellar-API-Inspector/1.0' } });
  if (!response.ok) {
    throw Object.assign(new Error(`Horizon request failed: HTTP ${response.status}`), {
      status: response.status,
    });
  }
  return (await response.json()) as Record<string, unknown>;
}

function calculateTransferableBalance(
  balance: string | null,
  sellingLiabilities: string | null,
): string | null {
  const balanceStroops = toStroops(balance);
  const liabilitiesStroops = toStroops(sellingLiabilities);
  if (balanceStroops === null || liabilitiesStroops === null) return null;
  return fromStroops(balanceStroops - liabilitiesStroops);
}

function toStroops(value: string | null): bigint | null {
  if (value === null || !/^\d+(?:\.\d{1,7})?$/.test(value)) return null;
  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole) * 10000000n + BigInt(fraction.padEnd(7, '0'));
}

function fromStroops(value: bigint): string {
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const whole = absolute / 10000000n;
  const fraction = String(absolute % 10000000n)
    .padStart(7, '0')
    .replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`;
}

function hasMissingDecisionFields(raw: Record<string, unknown>): boolean {
  const balances = Array.isArray(raw.balances) ? (raw.balances as Record<string, unknown>[]) : [];
  const native = balances.find((balance) => balance.asset_type === 'native');
  return (
    !native ||
    typeof native.balance !== 'string' ||
    typeof native.selling_liabilities !== 'string' ||
    typeof native.buying_liabilities !== 'string' ||
    !Array.isArray(raw.signers) ||
    !isRecord(raw.data) ||
    typeof raw.subentry_count !== 'number' ||
    typeof raw.num_sponsoring !== 'number' ||
    typeof raw.num_sponsored !== 'number'
  );
}

function isPositive(value: string): boolean {
  return Number(value) > 0;
}

function stringField(value: Record<string, unknown> | undefined, key: string): string | null {
  return typeof value?.[key] === 'string' ? (value[key] as string) : null;
}

function numberField(value: Record<string, unknown>, key: string): number | null {
  return typeof value[key] === 'number' && Number.isFinite(value[key])
    ? (value[key] as number)
    : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function clampHistoryDepth(depth: number): number {
  if (!Number.isFinite(depth)) return 0;
  return Math.max(0, Math.min(MAX_HISTORY_DEPTH, Math.floor(depth)));
}

function isNotFound(error: unknown): boolean {
  return isRecord(error) && error.status === 404;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
