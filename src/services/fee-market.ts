/**
 * Fee Market & Surge Analysis Service
 *
 * Retrieves and normalises fee statistics from Horizon (classic Stellar)
 * and optionally from a Soroban RPC endpoint (Soroban resource fees).
 * Computes surge indicators and inclusion-condition summaries without
 * submitting any transaction.
 */

import { Horizon } from '@stellar/stellar-sdk';
import { normalizeHorizonUrl } from '../utils/urls';
import { logger } from '../utils/logger';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Capacity pressure level derived from ledger_capacity_usage */
export type SurgePressure = 'low' | 'moderate' | 'high' | 'surge';

export interface FeeDistribution {
  /** Base fee set in the most recent ledger header (stroops) */
  baseFee: number;
  /** Minimum fee accepted in the recent sample (stroops) */
  min: number;
  /** Mode (most common) fee in the recent sample, if available (stroops) */
  mode: number | null;
  /** Maximum fee bid in the recent sample (stroops) */
  max: number;
  /** 10th-percentile fee (stroops) */
  p10: number;
  /** 50th-percentile / median fee (stroops) */
  p50: number;
  /** 95th-percentile fee (stroops) */
  p95: number | null;
  /** 99th-percentile fee (stroops) */
  p99: number;
}

export interface SurgeIndicators {
  /** Raw decimal from Horizon (0.0–1.0) */
  capacityUsageRaw: number;
  /** Rounded percentage for display */
  capacityUsagePercent: number;
  /** Qualitative pressure label */
  pressure: SurgePressure;
  /**
   * Estimated minimum fee likely to be included at the current pressure level.
   * During surge conditions this is p50; otherwise it equals the base fee.
   */
  recommendedMinFee: number;
  /** Whether the network appears to be in a fee-surge state */
  isSurging: boolean;
}

export interface SorobanFeeInfo {
  /** Fee per instruction (in stroops per 10k instructions), if reported */
  feePerInstructionIncrement: number | null;
  /** Fee per ledger read (stroops), if reported */
  feePerReadEntry: number | null;
  /** Fee per ledger write (stroops), if reported */
  feePerWriteEntry: number | null;
  /** Fee per byte of read bandwidth (stroops), if reported */
  feePerReadByte: number | null;
  /** Fee per byte of write bandwidth (stroops), if reported */
  feePerWriteByte: number | null;
  /** Current minimum resource fee floor (stroops), if reported */
  minResourceFee: number | null;
  /** Raw response from getFeeStats RPC method for full transparency */
  raw: Record<string, unknown> | null;
}

export interface FeeMarketResult {
  /** Normalised Horizon URL used for the request */
  horizonUrl: string;
  /** ISO-8601 timestamp of when the analysis was performed */
  retrievedAt: string;
  /** Round-trip latency for the Horizon fee stats call (ms) */
  latencyMs: number;
  /** Classic Stellar fee distribution from Horizon fee_stats */
  classic: FeeDistribution;
  /** Network surge indicators */
  surge: SurgeIndicators;
  /** Soroban fee info, populated when an RPC URL is provided and the method is supported */
  soroban: SorobanFeeInfo | null;
  /** Human-readable inclusion condition summary */
  inclusionConditions: string[];
  /** Non-fatal warnings (e.g. Soroban endpoint unreachable) */
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Internal Horizon fee-stats shape (broader than the SDK type)
// ---------------------------------------------------------------------------

interface RawFeeStats {
  last_ledger_base_fee?: string | number;
  ledger_capacity_usage?: string | number;
  fee_charged?: {
    min?: string | number;
    mode?: string | number;
    max?: string | number;
    p10?: string | number;
    p50?: string | number;
    p95?: string | number;
    p99?: string | number;
  };
  max_fee?: {
    min?: string | number;
    mode?: string | number;
    max?: string | number;
    p10?: string | number;
    p50?: string | number;
    p95?: string | number;
    p99?: string | number;
  };
}

// ---------------------------------------------------------------------------
// Internal JSON-RPC helper (mirrors the pattern in soroban.ts)
// ---------------------------------------------------------------------------

interface JsonRpcResponse<T> {
  jsonrpc: string;
  id: number | string;
  result?: T;
  error?: { code: number; message: string };
}

async function sendJsonRpc<T>(
  url: string,
  method: string,
  params: Record<string, unknown> = {},
): Promise<T> {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'Stellar-API-Inspector/1.0',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText}`);
  }

  const json = (await response.json()) as JsonRpcResponse<T>;

  if (json.error) {
    throw new Error(`JSON-RPC error ${json.error.code}: ${json.error.message}`);
  }

  if (json.result === undefined) {
    throw new Error(`JSON-RPC response for "${method}" contained no result`);
  }

  return json.result;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toNumber(value: string | number | undefined | null): number {
  if (value === undefined || value === null) return 0;
  const n = typeof value === 'number' ? value : parseFloat(value);
  return Number.isFinite(n) ? n : 0;
}

function toNumberOrNull(value: string | number | undefined | null): number | null {
  if (value === undefined || value === null) return null;
  const n = typeof value === 'number' ? value : parseFloat(value);
  return Number.isFinite(n) ? n : null;
}

function derivePressure(capacityUsage: number): SurgePressure {
  if (capacityUsage >= 0.9) return 'surge';
  if (capacityUsage >= 0.7) return 'high';
  if (capacityUsage >= 0.4) return 'moderate';
  return 'low';
}

function buildInclusionConditions(
  classic: FeeDistribution,
  surge: SurgeIndicators,
): string[] {
  const conditions: string[] = [];

  conditions.push(
    `Network capacity usage is ${surge.capacityUsagePercent}% (${surge.pressure.toUpperCase()}).`,
  );

  if (surge.isSurging) {
    conditions.push(
      `The network is in surge-pricing mode. Fee bids are competitive; ` +
        `submitting at the base fee (${classic.baseFee} stroops) is likely to be deprioritised.`,
    );
    conditions.push(
      `At current pressure, a fee around the median (${classic.p50} stroops) improves inclusion probability.`,
    );
  } else {
    conditions.push(
      `Normal fee conditions. The base fee (${classic.baseFee} stroops) is likely sufficient for timely inclusion.`,
    );
  }

  conditions.push(
    `Fee spread: min ${classic.min} → p10 ${classic.p10} → p50 ${classic.p50} → p99 ${classic.p99} → max ${classic.max} stroops.`,
  );

  if (classic.p99 > classic.baseFee * 10) {
    conditions.push(
      `High-fee bids (p99 = ${classic.p99} stroops) are significantly above base fee, ` +
        `suggesting competitive activity or large batch transactions.`,
    );
  }

  return conditions;
}

// ---------------------------------------------------------------------------
// Soroban getFeeStats
// ---------------------------------------------------------------------------

async function fetchSorobanFeeStats(rpcUrl: string): Promise<SorobanFeeInfo> {
  const raw = await sendJsonRpc<Record<string, unknown>>(rpcUrl, 'getFeeStats');

  // Soroban fee stats structure varies across implementations.
  // We normalise common field names defensively.
  const soroban = (raw.sorobanInclusionFee ?? raw.soroban ?? {}) as Record<string, unknown>;
  const resource = (raw.resourceFees ?? raw.resource ?? {}) as Record<string, unknown>;

  return {
    feePerInstructionIncrement:
      toNumberOrNull(soroban.feePerInstructionIncrement as string | number | undefined) ??
      toNumberOrNull(resource.feePerInstructionIncrement as string | number | undefined),
    feePerReadEntry:
      toNumberOrNull(soroban.feePerReadEntry as string | number | undefined) ??
      toNumberOrNull(resource.feePerReadEntry as string | number | undefined),
    feePerWriteEntry:
      toNumberOrNull(soroban.feePerWriteEntry as string | number | undefined) ??
      toNumberOrNull(resource.feePerWriteEntry as string | number | undefined),
    feePerReadByte:
      toNumberOrNull(soroban.feePerReadByte as string | number | undefined) ??
      toNumberOrNull(resource.feePerReadByte as string | number | undefined),
    feePerWriteByte:
      toNumberOrNull(soroban.feePerWriteByte as string | number | undefined) ??
      toNumberOrNull(resource.feePerWriteByte as string | number | undefined),
    minResourceFee:
      toNumberOrNull(soroban.minResourceFee as string | number | undefined) ??
      toNumberOrNull(raw.minResourceFee as string | number | undefined),
    raw,
  };
}

// ---------------------------------------------------------------------------
// Public analyser
// ---------------------------------------------------------------------------

/**
 * Analyse the current Stellar fee market.
 *
 * @param horizonUrl  Horizon endpoint to query for classic fee stats.
 * @param sorobanUrl  Optional Soroban RPC endpoint for Soroban fee data.
 */
export async function analyzeFeeMarket(
  horizonUrl: string,
  sorobanUrl?: string,
): Promise<FeeMarketResult> {
  const base = normalizeHorizonUrl(horizonUrl);
  const warnings: string[] = [];
  const retrievedAt = new Date().toISOString();

  // ── Classic fee stats via Horizon SDK ─────────────────────────────────
  const start = Date.now();
  let rawStats: RawFeeStats;
  try {
    const server = new Horizon.Server(base);
    rawStats = (await server.feeStats()) as unknown as RawFeeStats;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.debug(`analyzeFeeMarket: Horizon feeStats failed: ${message}`);
    throw new Error(`Failed to retrieve fee statistics from Horizon: ${message}`);
  }
  const latencyMs = Date.now() - start;

  // Prefer fee_charged (actual fees paid); fall back to max_fee (bids)
  const feeSource = rawStats.fee_charged ?? rawStats.max_fee ?? {};
  const baseFee = toNumber(rawStats.last_ledger_base_fee);
  const capacityRaw = toNumber(rawStats.ledger_capacity_usage);

  const classic: FeeDistribution = {
    baseFee,
    min: toNumber(feeSource.min),
    mode: toNumberOrNull(feeSource.mode),
    max: toNumber(feeSource.max),
    p10: toNumber(feeSource.p10),
    p50: toNumber(feeSource.p50),
    p95: toNumberOrNull(feeSource.p95),
    p99: toNumber(feeSource.p99),
  };

  const pressure = derivePressure(capacityRaw);
  const isSurging = pressure === 'surge' || pressure === 'high';
  const recommendedMinFee = isSurging ? classic.p50 : baseFee;

  const surge: SurgeIndicators = {
    capacityUsageRaw: capacityRaw,
    capacityUsagePercent: Math.round(capacityRaw * 100),
    pressure,
    recommendedMinFee,
    isSurging,
  };

  const inclusionConditions = buildInclusionConditions(classic, surge);

  // ── Optional Soroban fee stats ─────────────────────────────────────────
  let soroban: SorobanFeeInfo | null = null;
  if (sorobanUrl) {
    const normalizedRpc = normalizeHorizonUrl(sorobanUrl);
    try {
      soroban = await fetchSorobanFeeStats(normalizedRpc);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.debug(`analyzeFeeMarket: Soroban getFeeStats failed: ${message}`);
      warnings.push(`Soroban fee data unavailable: ${message}`);
    }
  }

  return {
    horizonUrl: base,
    retrievedAt,
    latencyMs,
    classic,
    surge,
    soroban,
    inclusionConditions,
    warnings,
  };
}
