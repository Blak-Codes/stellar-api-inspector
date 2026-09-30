/**
 * Human-readable formatter for the muxed account address inspection command.
 *
 * Pure function — no I/O, no side effects, easy to unit-test in isolation.
 */

import chalk from 'chalk';
import { formatTable } from '../utils/formatters';
import type { MuxedAccountInspectionResult } from '../inspectors/muxed-account';

/**
 * Format the full muxed account address inspection report.
 */
export function formatMuxedAccountReport(result: MuxedAccountInspectionResult): string {
  let text = `\n${chalk.bold.green('=== Stellar Address Inspection ===')}\n\n`;

  // ── Validity header ────────────────────────────────────────────────────
  const validityLabel = result.isValid
    ? chalk.green('VALID')
    : chalk.red('INVALID');

  const typeLabel =
    result.type === 'muxed'
      ? chalk.cyan('Muxed (M...)')
      : result.type === 'ed25519'
        ? chalk.green('Ed25519 (G...)')
        : chalk.red('Unknown');

  const headerRows: string[][] = [
    ['Property', 'Value'],
    ['Input Address', result.input],
    ['Validity', validityLabel],
    ['Address Type', typeLabel],
  ];

  if (result.canonicalAddress && result.canonicalAddress !== result.input) {
    headerRows.push(['Canonical Form', result.canonicalAddress]);
  }

  text += formatTable(headerRows);

  // ── Address details (valid addresses only) ─────────────────────────────
  if (result.isValid && result.type === 'muxed') {
    text += `\n${chalk.bold.cyan('--- Muxed Account Details ---')}\n`;
    text += formatTable([
      ['Field', 'Value'],
      ['M... Muxed Address', result.canonicalAddress ?? ''],
      ['G... Base Account (on-ledger)', chalk.cyan(result.baseAccountId ?? '')],
      ['Multiplexing ID (mux ID)', chalk.yellow(result.muxId ?? '')],
    ]);
  } else if (result.isValid && result.type === 'ed25519') {
    text += `\n${chalk.bold.cyan('--- Address Details ---')}\n`;
    text += formatTable([
      ['Field', 'Value'],
      ['G... Account Address', result.canonicalAddress ?? ''],
      ['Mux ID', chalk.gray('None — regular account')],
    ]);
  }

  // ── Summary ────────────────────────────────────────────────────────────
  text += `\n${chalk.bold.cyan('--- Summary ---')}\n`;
  text += `${result.isValid ? chalk.cyan('→') : chalk.red('✗')} ${result.summary}\n`;

  // ── Error (invalid addresses) ──────────────────────────────────────────
  if (!result.isValid && result.error) {
    text += chalk.red(`\n⚠ ${result.error}\n`);
  }

  // ── Notes ──────────────────────────────────────────────────────────────
  if (result.notes.length > 0) {
    text += `\n${chalk.bold.cyan('--- Notes ---')}\n`;
    for (const note of result.notes) {
      text += `${chalk.cyan('→')} ${note}\n`;
    }
  }

  return text;
}
