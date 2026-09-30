/**
 * Human-readable formatter for the account reserve and liability analysis command.
 *
 * Pure function — no I/O, no side effects, easy to unit-test in isolation.
 */

import chalk from 'chalk';
import { formatTable, formatXlm } from '../utils/formatters';
import type { AccountReserveResult } from '../services/account-reserve';

/**
 * Format the full account reserve and liability analysis report.
 */
export function formatAccountReserveReport(result: AccountReserveResult): string {
  let text = `\n${chalk.bold.green('=== Account Reserve & Liability Analysis ===')}\n`;
  text += `${chalk.cyan('Account ID:')} ${result.accountId}\n`;
  text += `${chalk.cyan('Horizon:   ')} ${result.horizonUrl}\n`;
  text += `${chalk.cyan('Sequence:  ')} ${result.sequence}\n\n`;

  // ── Reserve breakdown ──────────────────────────────────────────────────
  text += `${chalk.bold.cyan('--- Reserve Requirements ---')}\n`;
  text += formatTable([
    ['Component', 'Calculation', 'Amount (XLM)'],
    [
      'Account Base',
      '2 × 0.5 XLM',
      formatXlm(result.reserves.accountBase),
    ],
    [
      `Subentries (${result.subentryCount})`,
      `${result.subentryCount} × 0.5 XLM`,
      formatXlm(result.reserves.subentries),
    ],
    [
      `Sponsoring (${result.numSponsoring})`,
      `${result.numSponsoring} × 0.5 XLM`,
      formatXlm(result.reserves.sponsoring),
    ],
    ['', '', ''],
    [
      chalk.bold('Total Reserved'),
      '',
      chalk.yellow(formatXlm(result.reserves.total)),
    ],
  ]);

  // ── Sponsorship context ────────────────────────────────────────────────
  if (result.numSponsored > 0 || result.numSponsoring > 0) {
    text += `\n${chalk.bold.cyan('--- Sponsorship Context ---')}\n`;
    text += formatTable([
      ['Metric', 'Value'],
      ['Entries sponsored by others (free reserves)', String(result.numSponsored)],
      ['Entries this account sponsors (paid reserves)', String(result.numSponsoring)],
    ]);
  }

  // ── Liabilities ────────────────────────────────────────────────────────
  text += `\n${chalk.bold.cyan('--- XLM Liabilities ---')}\n`;
  const sellingColor =
    result.liabilities.sellingLiabilities > 0
      ? chalk.yellow(formatXlm(result.liabilities.sellingLiabilities))
      : formatXlm(0);

  text += formatTable([
    ['Type', 'Amount'],
    ['Selling Liabilities (open XLM offers)', sellingColor],
    ['Buying Liabilities (informational)', formatXlm(result.liabilities.buyingLiabilities)],
  ]);

  // ── Balance allocation ─────────────────────────────────────────────────
  text += `\n${chalk.bold.cyan('--- Balance Allocation ---')}\n`;
  const availableColor = result.allocation.isOverEncumbered
    ? chalk.red(formatXlm(result.allocation.availableAmount))
    : result.allocation.availableAmount < 1
      ? chalk.yellow(formatXlm(result.allocation.availableAmount))
      : chalk.green(formatXlm(result.allocation.availableAmount));

  text += formatTable([
    ['Allocation', 'Amount (XLM)'],
    ['Total XLM Balance', formatXlm(result.allocation.totalBalance)],
    ['  − Reserved (minimum balance)', chalk.yellow(formatXlm(result.allocation.reservedAmount))],
    ['  − Encumbered (selling liabilities)', chalk.yellow(formatXlm(result.allocation.encumberedAmount))],
    ['', ''],
    [chalk.bold('Potentially Available'), availableColor],
  ]);

  if (result.allocation.isOverEncumbered) {
    text += chalk.red(
      `\n⚠ Account is over-encumbered. Reserve + liabilities exceed the current XLM balance.\n`,
    );
  }

  // ── Notes ──────────────────────────────────────────────────────────────
  if (result.notes.length > 0) {
    text += `\n${chalk.bold.cyan('--- Analysis Notes ---')}\n`;
    for (const note of result.notes) {
      const prefix = note.startsWith('⚠') ? '' : chalk.cyan('→') + ' ';
      text += `${prefix}${note}\n`;
    }
  }

  return text;
}
