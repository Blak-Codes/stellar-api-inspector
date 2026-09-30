import { FeeBumpTransaction, Networks, StrKey, Transaction, xdr } from '@stellar/stellar-sdk';

export interface FeeBumpSignature {
  index: number;
  hint: string;
  signature: string;
  signerIdentity: string | null;
}

export interface FeeBumpTransactionAnalysis {
  envelopeType: 'transaction' | 'fee_bump';
  rawXdr: string;
  networkPassphrase: string | null;
  normalized: {
    outer: Record<string, unknown>;
    inner: Record<string, unknown> | null;
  };
  feeRelationship: {
    outerFee: string;
    innerFee: string;
    difference: string;
    outerExceedsInner: boolean;
    outerFeeRateExceedsInnerFeeRate: boolean | null;
    innerMaximumFeePerOperation: string | null;
    effectiveMaximumFeePerOperation: string | null;
  } | null;
  outerSignatures: FeeBumpSignature[];
  innerSignatures: FeeBumpSignature[];
  duplicateSigners: string[];
  diagnostics: string[];
}

export type FeeBumpAnalysisResult =
  | { analysis: FeeBumpTransactionAnalysis; error?: undefined }
  | { analysis: null; error: string };

const NETWORK_ALIASES: Record<string, string> = {
  public: Networks.PUBLIC,
  mainnet: Networks.PUBLIC,
  testnet: Networks.TESTNET,
  futurenet: Networks.FUTURENET,
  standalone: Networks.STANDALONE,
};

function resolveNetworkPassphrase(passphrase?: string): string | undefined {
  if (!passphrase) return undefined;
  return NETWORK_ALIASES[passphrase.toLowerCase()] || passphrase;
}

function signatureList(
  signatures: xdr.DecoratedSignature[],
  knownAccounts: string[],
): FeeBumpSignature[] {
  const identitiesByHint = new Map<string, string>();
  for (const account of knownAccounts) {
    try {
      const hint = StrKey.decodeEd25519PublicKey(account).subarray(-4).toString('hex');
      identitiesByHint.set(hint, account);
    } catch {
      // Muxed accounts and non-Ed25519 signer keys cannot be resolved from a hint.
    }
  }

  return signatures.map((signature, index) => {
    const hint = signature.hint().toString('hex');
    return {
      index,
      hint,
      signature: signature.signature().toString('base64'),
      signerIdentity: identitiesByHint.get(hint) ?? null,
    };
  });
}

function transactionStructure(tx: Transaction, includeHash: boolean): Record<string, unknown> {
  const operationSummary = tx.operations.map((operation, index) => ({
    index,
    type: operation.type,
    source: operation.source ?? null,
  }));

  return {
    sourceAccount: tx.source,
    sequence: tx.sequence,
    fee: tx.fee,
    hash: includeHash ? tx.hash().toString('hex') : null,
    operationCount: tx.operations.length,
    operations: operationSummary,
    memo: { type: tx.memo.type, value: tx.memo.value ?? null },
    preconditions: {
      version:
        tx.ledgerBounds ||
        tx.minAccountSequence !== undefined ||
        tx.minAccountSequenceAge !== undefined ||
        tx.minAccountSequenceLedgerGap !== undefined ||
        (tx.extraSigners?.length ?? 0) > 0
          ? 2
          : tx.timeBounds
            ? 1
            : 0,
      timeBounds: tx.timeBounds ?? null,
      ledgerBounds: tx.ledgerBounds ?? null,
      minAccountSequence: tx.minAccountSequence ?? null,
      minAccountSequenceAge: tx.minAccountSequenceAge ?? null,
      minAccountSequenceLedgerGap: tx.minAccountSequenceLedgerGap ?? null,
      extraSigners: tx.extraSigners ?? [],
    },
  };
}

function isStrictBase64(value: string): boolean {
  return (
    value.length > 0 &&
    value.length % 4 === 0 &&
    /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  );
}

export function analyzeFeeBumpTransaction(
  suppliedXdr: string,
  networkPassphrase?: string,
): FeeBumpAnalysisResult {
  const rawXdr = suppliedXdr.trim();
  if (!rawXdr) return { analysis: null, error: 'Transaction envelope XDR is required' };
  if (!isStrictBase64(rawXdr))
    return { analysis: null, error: 'Invalid base64 transaction envelope XDR' };

  let envelope: xdr.TransactionEnvelope;
  try {
    envelope = xdr.TransactionEnvelope.fromXDR(Buffer.from(rawXdr, 'base64'));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { analysis: null, error: `Malformed transaction envelope XDR: ${message}` };
  }

  const envelopeType = envelope.switch();
  const normalizedXdr = envelope.toXDR('base64');
  if (envelopeType === xdr.EnvelopeType.envelopeTypeTxFeeBump()) {
    const resolvedPassphrase = resolveNetworkPassphrase(networkPassphrase);
    const passphrase = resolvedPassphrase || Networks.TESTNET;
    try {
      const feeBump = new FeeBumpTransaction(envelope, passphrase);
      const inner = feeBump.innerTransaction;
      const outerSignatures = signatureList(feeBump.signatures, [feeBump.feeSource]);
      const innerSignatures = signatureList(inner.signatures, [
        inner.source,
        ...(inner.extraSigners ?? []),
      ]);
      const outerFee = BigInt(feeBump.fee);
      const innerFee = BigInt(inner.fee);
      const operationCount = inner.operations.length;
      const feeRateExceedsInner =
        operationCount > 0
          ? outerFee * BigInt(operationCount) > innerFee * BigInt(operationCount + 1)
          : null;
      const duplicateSigners = outerSignatures
        .filter((outer) => outer.signerIdentity !== null)
        .filter((outer) =>
          innerSignatures.some(
            (innerSignature) => innerSignature.signerIdentity === outer.signerIdentity,
          ),
        )
        .map((signature) => signature.signerIdentity as string);
      const diagnostics: string[] = [];
      if (operationCount === 0) {
        diagnostics.push(
          'The inner transaction has no operations; an effective fee rate cannot be determined.',
        );
      } else if (!feeRateExceedsInner) {
        diagnostics.push('The outer fee rate does not exceed the inner transaction fee ceiling.');
      }

      return {
        analysis: {
          envelopeType: 'fee_bump',
          rawXdr: suppliedXdr,
          networkPassphrase: networkPassphrase ?? null,
          normalized: {
            outer: {
              feeSource: feeBump.feeSource,
              fee: feeBump.fee,
              hash: resolvedPassphrase ? feeBump.hash().toString('hex') : null,
              innerTransaction: transactionStructure(inner, !!resolvedPassphrase),
              signatures: outerSignatures,
              envelopeXdr: normalizedXdr,
            },
            inner: {
              ...transactionStructure(inner, !!resolvedPassphrase),
              signatures: innerSignatures,
              envelopeXdr: xdr.TransactionEnvelope.envelopeTypeTx(inner.toEnvelope().v1()).toXDR(
                'base64',
              ),
            },
          },
          feeRelationship: {
            outerFee: outerFee.toString(),
            innerFee: innerFee.toString(),
            difference: (outerFee - innerFee).toString(),
            outerExceedsInner: outerFee > innerFee,
            outerFeeRateExceedsInnerFeeRate: feeRateExceedsInner,
            innerMaximumFeePerOperation:
              operationCount > 0 ? (innerFee / BigInt(operationCount)).toString() : null,
            effectiveMaximumFeePerOperation:
              operationCount > 0 ? (outerFee / BigInt(operationCount + 1)).toString() : null,
          },
          outerSignatures,
          innerSignatures,
          duplicateSigners: [...new Set(duplicateSigners)],
          diagnostics,
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { analysis: null, error: `Invalid fee-bump envelope: ${message}` };
    }
  }

  if (
    envelopeType === xdr.EnvelopeType.envelopeTypeTx() ||
    envelopeType === xdr.EnvelopeType.envelopeTypeTxV0()
  ) {
    try {
      const tx = new Transaction(
        envelope,
        resolveNetworkPassphrase(networkPassphrase) || Networks.TESTNET,
      );
      const signatures = signatureList(tx.signatures, [tx.source]);
      return {
        analysis: {
          envelopeType: 'transaction',
          rawXdr: suppliedXdr,
          networkPassphrase: networkPassphrase ?? null,
          normalized: {
            outer: {
              ...transactionStructure(tx, !!networkPassphrase),
              signatures,
              envelopeXdr: normalizedXdr,
            },
            inner: null,
          },
          feeRelationship: null,
          outerSignatures: signatures,
          innerSignatures: [],
          duplicateSigners: [],
          diagnostics: ['This is a regular transaction envelope, not a fee-bump transaction.'],
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { analysis: null, error: `Invalid transaction envelope: ${message}` };
    }
  }

  return {
    analysis: null,
    error: `Unsupported transaction envelope type: ${envelopeType.name}`,
  };
}
