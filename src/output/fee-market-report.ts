/**
 * Human-readable formatter for the fee market and surge analysis command.
 *
 * Pure function — no I/O, no side effects, easy to unit-test in isolation.
 */

import chalk from 'chalk';
import { formatTable } from '../utils/formatters';
import type { FeeMarketResult, SurgePressure } from '../services/fee-market';

function pressureColor(pressure: SurgePressure): string {
  switch (pressure) {
    case 'surge':
      return chalk.red(pressure.toUpperCase());
    case 'high':
      return chalk.red(pressure.toUpperCase());
    case 'moderate':
      return chalk.yellow(pressure.toUpperCase());
    case 'low':
      return chalk.green(pressure.toUpperCase());
  }
}

function stroops(value: number | null): string {
  if (value === null) return 'N/A';
  return `${value.toLocaleString()} stroops`;
}

/**
 * Format the full fee market and surge analysis report.
 */
export function formatFeeMarketReport(result: FeeMarketResult): string {
  let text = `\n${chalk.bold.green('=== Stellar Fee Market & Surge Analysis ===')}\n`;
  text += `${chalk.cyan('Horizon:      ')} ${result.horizonUrl}\n`;
  text += `${chalk.cyan('Retrieved At: ')} ${result.retrievedAt}\n`;
  text += `${chalk.cyan('Latency:      ')} ${result.latencyMs}ms\n\n`;

  // ── Surge / capacity indicators ────────────────────────────────────────
  text += `${chalk.bold.cyan('--- Network Capacity & Surge Indicators ---')}\n`;
  const capacityBar = buildCapacityBar(result.surge.capacityUsageRaw);
  text += formatTable([
    ['Indicator', 'Value'],
    ['Ledger Capacity Usage', `${result.surge.capacityUsagePercent}%  ${capacityBar}`],
    ['Pressure Level', pressureColor(result.surge.pressure)],
    ['Surge Pricing Active', result.surge.isSurging ? chalk.red('YES') : chalk.green('NO')],
    ['Recommended Minimum Fee', stroops(result.surge.recommendedMinFee)],
  ]);

  // ── Classic fee distribution ───────────────────────────────────────────
  text += `\n${chalk.bold.cyan('--- Classic Fee Distribution (fee_charged) ---')}\n`;
  text += formatTable([
    ['Percentile / Metric', 'Stroops', 'Notes'],
    ['Base Fee (last ledger)', stroops(result.classic.baseFee), 'Protocol minimum'],
    ['Min Accepted', stroops(result.classic.min), 'Lowest fee included'],
    ['P10', stroops(result.classic.p10), '10% of txns paid this or less'],
    ['P50 (Median)', stroops(result.classic.p50), '50% of txns paid this or less'],
    [
      'P95',
      stroops(result.classic.p95),
      '95% of txns paid this or less',
    ],
    ['P99', stroops(result.classic.p99), '99% of txns paid this or less'],
    ['Max Bid', stroops(result.classic.max), 'Highest fee bid observed'],
    [
      'Mode',
      stroops(result.classic.mode),
      'Most common fee bid',
    ],
  ]);

  // ── Soroban fee data ───────────────────────────────────────────────────
  if (result.soroban) {
    const s = result.soroban;
    text += `\n${chalk.bold.cyan('--- Soroban Resource Fee Rates ---')}\n`;
    text += formatTable([
      ['Resource', 'Rate'],
      ['Fee / 10k Instructions', stroops(s.feePerInstructionIncrement)],
      ['Fee / Ledger Read Entry', stroops(s.feePerReadEntry)],
      ['Fee / Ledger Write Entry', stroops(s.feePerWriteEntry)],
      ['Fee / Read Byte', stroops(s.feePerReadByte)],
      ['Fee / Write Byte', stroops(s.feePerWriteByte)],
      ['Minimum Resource Fee', stroops(s.minResourceFee)],
    ]);
  }

  // ── Inclusion conditions ───────────────────────────────────────────────
  text += `\n${chalk.bold.cyan('--- Inclusion Conditions ---')}\n`;
  for (const condition of result.inclusionConditions) {
    text += `${chalk.cyan('→')} ${condition}\n`;
  }

  // ── Warnings ───────────────────────────────────────────────────────────
  if (result.warnings.length > 0) {
    text += '\n';
    for (const warning of result.warnings) {
      text += chalk.yellow(`⚠ ${warning}\n`);
    }
  }

  return text;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Build a compact ASCII capacity bar (10 characters wide). */
function buildCapacityBar(usage: number): string {
  const width = 10;
  const filled = Math.round(Math.min(Math.max(usage, 0), 1) * width);
  const bar = '█'.repeat(filled) + '░'.repeat(width - filled);
  if (usage >= 0.9) return chalk.red(`[${bar}]`);
  if (usage >= 0.7) return chalk.yellow(`[${bar}]`);
  return chalk.green(`[${bar}]`);
}
