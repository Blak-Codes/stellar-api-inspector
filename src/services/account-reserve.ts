import { Horizon } from '@stellar/stellar-sdk';
import { normalizeHorizonUrl } from '../utils/urls';
import { logger } from '../utils/logger';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Base reserve in XLM per subentry, as defined in the Stellar protocol.
 * Each ledger entry (trustline, offer, signer, data entry, claimable balance
 * sponsorship, etc.) requires 0.5 XLM of reserved balance.
 */
const BASE_RESERVE_XLM = 0.5;

/**
 * The account itself requires 2 base reserves (1 XLM) to exist.
 * Represented here as the multiplier on BASE_RESERVE_XLM.
 */
const ACCOUNT_BASE_MULTIPLIER = 2;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ReserveBreakdown {
  /** XLM reserved for the account's own existence (2 × 0.5 XLM = 1 XLM) */
  accountBase: number;
  /** XLM reserved for all subentries (subentryCount × 0.5 XLM) */
  subentries: number;
  /** XLM reserved for entries sponsored by this account (numSponsoring × 0.5 XLM) */
  sponsoring: number;
  /** Total XLM locked as minimum balance requirement */
  total: number;
}

export interface LiabilityBreakdown {
  /** Sum of all selling liabilities across all XLM offers */
  sellingLiabilities: number;
  /** Sum of all buying liabilities across all XLM offers (informational only) */
  buyingLiabilities: number;
}

export interface BalanceAllocation {
  /** Raw XLM balance string from Horizon */
  rawBalance: string;
  /** Total XLM balance as a number */
  totalBalance: number;
  /** Amount locked by minimum reserve requirements */
  reservedAmount: number;
  /** Amount encumbered by selling liabilities */
  encumberedAmount: number;
  /**
   * Amount that is potentially spendable.
   * = totalBalance - reservedAmount - encumberedAmount
   * May be negative if liabilities exceed available-after-reserve amount.
   */
  availableAmount: number;
  /** True when available amount is negative or zero */
  isOverEncumbered: boolean;
}

export interface AccountReserveResult {
  accountId: string;
  horizonUrl: string;
  /** Sequence number of the account */
  sequence: string;
  /** Total number of subentries on the account */
  subentryCount: number;
  /**
   * Number of entries for which this account is paying reserves as a sponsor.
   * Maps to the `num_sponsoring` field from Horizon.
   */
  numSponsoring: number;
  /**
   * Number of entries whose reserves are covered by a sponsor for this account.
   * Maps to the `num_sponsored` field from Horizon.
   */
  numSponsored: number;
  /** Reserve breakdown explaining each component of the minimum balance */
  reserves: ReserveBreakdown;
  /** Selling and buying liability totals for XLM */
  liabilities: LiabilityBreakdown;
  /** Final balance allocation: reserved, encumbered, available */
  allocation: BalanceAllocation;
  /** Human-readable notes about the account's financial constraints */
  notes: string[];
}

// ---------------------------------------------------------------------------
// Internal helper types matching a minimal Horizon account shape
// ---------------------------------------------------------------------------

interface HorizonBalance {
  asset_type: string;
  balance: string;
  selling_liabilities?: string;
  buying_liabilities?: string;
}

interface HorizonAccountRecord {
  id: string;
  sequence: string;
  subentry_count: number;
  num_sponsoring?: number;
  num_sponsored?: number;
  balances: HorizonBalance[];
}

// ---------------------------------------------------------------------------
// Public inspector
// ---------------------------------------------------------------------------

/**
 * Load a Stellar account from Horizon and compute its reserve requirements,
 * liability encumbrances, and spendable XLM balance.
 *
 * Returns `null` when the account cannot be loaded (not found, network error).
 */
export async function analyzeAccountReserve(
  horizonUrl: string,
  accountId: string,
): Promise<AccountReserveResult | null> {
  const base = normalizeHorizonUrl(horizonUrl);

  let acc: HorizonAccountRecord;
  try {
    const server = new Horizon.Server(base);
    // loadAccount returns a full AccountResponse; we cast to our minimal shape
    acc = (await server.loadAccount(accountId)) as unknown as HorizonAccountRecord;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.debug(`analyzeAccountReserve failed for ${accountId}: ${message}`);
    return null;
  }

  // ── Reserve calculation ────────────────────────────────────────────────
  const numSponsoring = acc.num_sponsoring ?? 0;
  const numSponsored = acc.num_sponsored ?? 0;
  const subentryCount = acc.subentry_count;

  const accountBase = ACCOUNT_BASE_MULTIPLIER * BASE_RESERVE_XLM;
  const subentriesReserve = subentryCount * BASE_RESERVE_XLM;
  const sponsoringReserve = numSponsoring * BASE_RESERVE_XLM;
  const totalReserve = accountBase + subentriesReserve + sponsoringReserve;

  const reserves: ReserveBreakdown = {
    accountBase,
    subentries: subentriesReserve,
    sponsoring: sponsoringReserve,
    total: totalReserve,
  };

  // ── Liability extraction (XLM / native only) ──────────────────────────
  const nativeBalance = acc.balances.find((b) => b.asset_type === 'native');
  const rawBalance = nativeBalance?.balance ?? '0';
  const totalBalance = parseFloat(rawBalance) || 0;
  const sellingLiabilities = parseFloat(nativeBalance?.selling_liabilities ?? '0') || 0;
  const buyingLiabilities = parseFloat(nativeBalance?.buying_liabilities ?? '0') || 0;

  const liabilities: LiabilityBreakdown = {
    sellingLiabilities,
    buyingLiabilities,
  };

  // ── Balance allocation ─────────────────────────────────────────────────
  const availableAmount = totalBalance - totalReserve - sellingLiabilities;
  const allocation: BalanceAllocation = {
    rawBalance,
    totalBalance,
    reservedAmount: totalReserve,
    encumberedAmount: sellingLiabilities,
    availableAmount,
    isOverEncumbered: availableAmount <= 0,
  };

  // ── Explanatory notes ──────────────────────────────────────────────────
  const notes = buildNotes({
    subentryCount,
    numSponsoring,
    numSponsored,
    sellingLiabilities,
    availableAmount,
    totalBalance,
    totalReserve,
  });

  return {
    accountId: acc.id,
    horizonUrl: base,
    sequence: acc.sequence,
    subentryCount,
    numSponsoring,
    numSponsored,
    reserves,
    liabilities,
    allocation,
    notes,
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function buildNotes(ctx: {
  subentryCount: number;
  numSponsoring: number;
  numSponsored: number;
  sellingLiabilities: number;
  availableAmount: number;
  totalBalance: number;
  totalReserve: number;
}): string[] {
  const notes: string[] = [];

  notes.push(
    `The account base reserve (${ACCOUNT_BASE_MULTIPLIER} × ${BASE_RESERVE_XLM} XLM = ${ACCOUNT_BASE_MULTIPLIER * BASE_RESERVE_XLM} XLM) is always locked regardless of account activity.`,
  );

  if (ctx.subentryCount > 0) {
    notes.push(
      `${ctx.subentryCount} subentrie(s) (trustlines, offers, data entries, signers) each lock ${BASE_RESERVE_XLM} XLM, totalling ${(ctx.subentryCount * BASE_RESERVE_XLM).toFixed(1)} XLM.`,
    );
  } else {
    notes.push('No subentries are present; only the account base reserve applies.');
  }

  if (ctx.numSponsoring > 0) {
    notes.push(
      `This account is sponsoring ${ctx.numSponsoring} ledger entr${ctx.numSponsoring === 1 ? 'y' : 'ies'}, each requiring an additional ${BASE_RESERVE_XLM} XLM reserve paid by this account.`,
    );
  }

  if (ctx.numSponsored > 0) {
    notes.push(
      `${ctx.numSponsored} entr${ctx.numSponsored === 1 ? 'y' : 'ies'} belonging to this account ${ctx.numSponsored === 1 ? 'has its reserve' : 'have their reserves'} covered by a sponsor — these do not contribute to the reserve cost shown above.`,
    );
  }

  if (ctx.sellingLiabilities > 0) {
    notes.push(
      `${ctx.sellingLiabilities.toFixed(7)} XLM is encumbered by open selling liabilities (active XLM offers) and cannot be spent until those offers are cancelled or filled.`,
    );
  }

  if (ctx.availableAmount <= 0) {
    notes.push(
      `⚠ The account is over-encumbered: reserve requirements and liabilities exceed the current balance by ${Math.abs(ctx.availableAmount).toFixed(7)} XLM. No XLM can be freely spent.`,
    );
  } else if (ctx.availableAmount < 1) {
    notes.push(
      `Only ${ctx.availableAmount.toFixed(7)} XLM is freely available — consider maintaining a larger buffer to absorb fee fluctuations.`,
    );
  }

  return notes;
}
