import chalk from 'chalk';
import { formatTable } from '../utils/formatters';
import type { ContractEnvMetaArtifact, ContractEnvMetaResult } from '../services/contract-env-meta';

export function formatContractEnvMetaReport(result: ContractEnvMetaResult): string {
  let text = `\n${chalk.bold.green('=== Soroban Contract Environment Metadata ===')}\n\n`;
  text += formatArtifact(result.artifact, 'Artifact');
  if (result.comparison) {
    text += `\n${chalk.bold.cyan('--- Comparison ---')}\n`;
    text += formatArtifact(result.comparison.artifact, 'Compared Artifact');
    const comparison = result.comparison.result;
    const rows = [
      ['Comparison', 'Result'],
      ['Same Environment Metadata', comparison.sameMetadata ? 'YES' : 'NO'],
      ['Compatibility', 'Not assessed (no explicit compatibility rule configured)'],
      ['Added Entries', comparison.added.map((entry) => entry.key).join(', ') || 'None'],
      ['Removed Entries', comparison.removed.map((entry) => entry.key).join(', ') || 'None'],
      [
        'Changed Entries',
        comparison.changed
          .map((entry) => `${entry.key}: ${jsonValue(entry.before)} -> ${jsonValue(entry.after)}`)
          .join('; ') || 'None',
      ],
    ];
    text += formatTable(rows);
  }
  text += `\n${chalk.gray(
    'Observed metadata is descriptive; compatibility is not inferred from version differences.',
  )}\n`;
  return text;
}

function formatArtifact(artifact: ContractEnvMetaArtifact, title: string): string {
  const version = artifact.normalized?.interfaceVersion;
  const rows = [
    ['Property', 'Value'],
    [title, `${artifact.source.type}: ${artifact.source.value}`],
    ['Metadata Status', statusLabel(artifact.status)],
    ['WASM Hash', artifact.wasmHash ?? 'Unavailable'],
    [
      'WASM Size',
      artifact.wasmSizeBytes !== undefined ? `${artifact.wasmSizeBytes} bytes` : 'Unavailable',
    ],
    [
      'Environment Interface Version',
      version ? `${version.protocol}.${version.preRelease}` : 'Not reported',
    ],
    ['Protocol Compatibility Value', version ? String(version.protocol) : 'Not reported'],
    [
      'Metadata Entries',
      artifact.normalized?.entries
        .map((entry) => `${entry.key}=${jsonValue(entry.value)}`)
        .join(', ') || 'None',
    ],
    ['Metadata Fingerprint', artifact.fingerprint ?? 'Unavailable'],
    ['Raw Metadata XDR', artifact.rawMetadata?.value ?? 'Unavailable'],
  ];
  let text = `${chalk.bold(title)}\n` + formatTable(rows);
  if (artifact.diagnostic) text += `${chalk.yellow(`Diagnostic: ${artifact.diagnostic}`)}\n`;
  return text;
}

function statusLabel(status: ContractEnvMetaArtifact['status']): string {
  switch (status) {
    case 'decoded':
      return 'Present and decoded';
    case 'partially-unsupported':
      return 'Present, partially unsupported';
    case 'absent':
      return 'Absent';
    case 'artifact-unavailable':
      return 'Artifact unavailable';
    case 'malformed':
      return 'Malformed';
  }
}

function jsonValue(value: unknown): string {
  return JSON.stringify(value);
}
