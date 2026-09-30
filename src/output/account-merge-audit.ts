import chalk from 'chalk';
import { formatTable } from '../utils/formatters';
import { AccountMergeAuditReport } from '../inspectors/account-merge-audit';

export function formatAccountMergeAudit(report: AccountMergeAuditReport): string {
  let text = `\n${chalk.bold('=== Stellar Account Merge Safety Audit ===')}\n`;
  text += `${chalk.cyan('Classification:')} ${chalk.bold(report.status.toUpperCase())}\n`;
  text += `${chalk.cyan('Source:')} ${report.sourceAccount.accountId} (${report.sourceAccount.readable ? 'readable' : 'unavailable'})\n`;
  text += `${chalk.cyan('Destination:')} ${report.destinationAccount.accountId} (${report.destinationAccount.readable ? 'readable' : 'unavailable'})\n`;
  text += `${chalk.cyan('Read-only:')} Yes; no transaction was constructed, signed, or submitted.\n\n`;
  text += `${chalk.bold.cyan('--- Source Observations ---')}\n`;
  text += formatTable([
    ['Observation', 'Value'],
    ['Native XLM balance', report.sourceAccount.nativeBalance ?? 'Unknown'],
    ['Estimated transferable XLM', report.sourceAccount.estimatedTransferableBalance ?? 'Unknown'],
    ['Selling liabilities (XLM)', report.sourceAccount.sellingLiabilities ?? 'Unknown'],
    ['Buying liabilities (XLM)', report.sourceAccount.buyingLiabilities ?? 'Unknown'],
    [
      'Subentries / unclassified',
      `${report.sourceAccount.subentryCount ?? 'Unknown'} / ${report.sourceAccount.remainingSubentries ?? 'Unknown'}`,
    ],
    [
      'Offers / trustlines / data entries',
      `${report.sourceAccount.offerCount ?? 'Unknown'} / ${report.sourceAccount.trustlineCount ?? 'Unknown'} / ${report.sourceAccount.dataEntryCount ?? 'Unknown'}`,
    ],
    [
      'Signers / additional signers',
      `${report.sourceAccount.signerCount ?? 'Unknown'} / ${report.sourceAccount.additionalSignerCount ?? 'Unknown'}`,
    ],
    [
      'Sponsoring / sponsored',
      `${report.sourceAccount.numSponsoring ?? 'Unknown'} / ${report.sourceAccount.numSponsored ?? 'Unknown'}`,
    ],
  ]);
  if (report.sourceAccount.liabilities) {
    const liabilities = report.sourceAccount.liabilities.filter(
      (item) => item.selling !== null || item.buying !== null,
    );
    text += `\n${chalk.bold.cyan('--- Balance Liabilities ---')}\n`;
    text += formatTable([
      ['Asset', 'Selling', 'Buying'],
      ...liabilities.map((item) => [
        item.assetType === 'native'
          ? 'XLM'
          : `${item.assetCode ?? item.assetType}${item.assetIssuer ? `:${item.assetIssuer}` : ''}`,
        item.selling ?? 'Unknown',
        item.buying ?? 'Unknown',
      ]),
    ]);
  }
  text += `\n${chalk.bold.cyan('--- Findings and Actions ---')}\n`;
  if (report.findings.length === 0) {
    text += `${chalk.green('No merge-blocking state was observed by the implemented checks. This is not a guarantee that a merge will succeed.')}\n`;
  } else {
    for (const finding of report.findings) {
      text += `${chalk.yellow(`[${finding.code}]`)} ${finding.message}\n  Action: ${finding.action}\n`;
    }
  }
  if (report.historicalInspection.inspected) {
    text += `\nHistorical activity: inspected ${report.historicalInspection.records.length} relevant record(s) from up to ${report.historicalInspection.requestedDepth} recent operations. Historical activity does not prove current sponsorship state.\n`;
  }
  return text;
}
