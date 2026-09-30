import {
  FeeBumpTransaction,
  Networks,
  StrKey,
  Transaction,
  verify,
  xdr,
} from '@stellar/stellar-sdk';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SignatureVerificationStatus = 'valid' | 'invalid' | 'unknown_signer';

export interface VerifiedSignature {
  index: number;
  /** Last 4 bytes of the public key, hex-encoded. */
  hint: string;
  /** base64-encoded raw signature bytes. */
  signature: string;
  /** Whether the cryptographic verification passed. */
  status: SignatureVerificationStatus;
  /** Resolved public key (G-address) when the hint matched a known signer, else null. */
  signerPublicKey: string | null;
  /** Short human-readable explanation. */
  description: string;
}

export interface SignatureVerificationResult {
  /** Type of the outermost envelope. */
  envelopeType: 'transaction' | 'fee_bump';
  /** Network passphrase used for hash reconstruction. */
  networkPassphrase: string;
  /** hex-encoded transaction hash that was signed. */
  transactionHash: string;
  /** For fee-bump: hex-encoded inner transaction hash. */
  innerTransactionHash: string | null;
  /** Verification results for each signature. */
  signatures: VerifiedSignature[];
  /** Verification results for inner-transaction signatures (fee-bump only). */
  innerSignatures: VerifiedSignature[];
  /** Total valid signature count. */
  validCount: number;
  /** Total invalid signature count. */
  invalidCount: number;
  /** Total signatures whose signer could not be resolved. */
  unknownCount: number;
  /** Overall pass/fail: true only when all signatures are valid. */
  allValid: boolean;
  /** Diagnostic messages. */
  diagnostics: string[];
}

// ---------------------------------------------------------------------------
// Network alias resolution (mirrors the pattern used in fee-bump inspector)
// ---------------------------------------------------------------------------

const NETWORK_ALIASES: Record<string, string> = {
  public: Networks.PUBLIC,
  mainnet: Networks.PUBLIC,
  testnet: Networks.TESTNET,
  futurenet: Networks.FUTURENET,
  standalone: Networks.STANDALONE,
};

export function resolveNetworkPassphrase(passphrase?: string): string {
  if (!passphrase) return Networks.TESTNET;
  return NETWORK_ALIASES[passphrase.toLowerCase()] ?? passphrase;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Build a hint → publicKey lookup table from a list of G-address strings.
 * Only Ed25519 (G-prefix) keys produce a 4-byte hint; other key types are
 * skipped gracefully.
 */
function buildHintMap(accounts: string[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const account of accounts) {
    if (!account) continue;
    try {
      // StrKey.decodeEd25519PublicKey returns the raw 32-byte key; last 4 bytes == hint.
      const rawKey = StrKey.decodeEd25519PublicKey(account);
      const hint = rawKey.subarray(-4).toString('hex');
      map.set(hint, account);
    } catch {
      // Muxed accounts, contract IDs, and hash-signed keys cannot be resolved.
    }
  }
  return map;
}

/**
 * Cryptographically verify a single decorated signature against the supplied
 * signing payload.
 */
function verifySignature(
  decoratedSig: xdr.DecoratedSignature,
  signingPayload: Buffer,
  hintMap: Map<string, string>,
  index: number,
): VerifiedSignature {
  const hint = decoratedSig.hint().toString('hex');
  const sigBytes = decoratedSig.signature();
  const sigBase64 = sigBytes.toString('base64');
  const resolvedPublicKey = hintMap.get(hint) ?? null;

  if (resolvedPublicKey === null) {
    return {
      index,
      hint,
      signature: sigBase64,
      status: 'unknown_signer',
      signerPublicKey: null,
      description: `Hint ${hint} did not match any known signer — cannot verify cryptographically.`,
    };
  }

  // Decode the raw 32-byte public key and call the SDK's verify function.
  let valid = false;
  try {
    const rawPubKey = StrKey.decodeEd25519PublicKey(resolvedPublicKey);
    valid = verify(signingPayload, sigBytes, rawPubKey);
  } catch {
    valid = false;
  }

  return {
    index,
    hint,
    signature: sigBase64,
    status: valid ? 'valid' : 'invalid',
    signerPublicKey: resolvedPublicKey,
    description: valid
      ? `Valid — signature by ${resolvedPublicKey} verified against the transaction hash.`
      : `Invalid — signature hint matched ${resolvedPublicKey} but cryptographic verification failed.`,
  };
}

/**
 * Summarise a list of VerifiedSignature entries.
 */
function summarise(signatures: VerifiedSignature[]): {
  validCount: number;
  invalidCount: number;
  unknownCount: number;
  allValid: boolean;
} {
  const validCount = signatures.filter((s) => s.status === 'valid').length;
  const invalidCount = signatures.filter((s) => s.status === 'invalid').length;
  const unknownCount = signatures.filter((s) => s.status === 'unknown_signer').length;
  return { validCount, invalidCount, unknownCount, allValid: invalidCount === 0 };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export type VerifySignaturesResult =
  | { result: SignatureVerificationResult; error?: undefined }
  | { result: null; error: string };

/**
 * Decode a base64 TransactionEnvelope XDR, reconstruct the signing payload,
 * and verify every signature it carries.
 *
 * @param envelopeXdr   - base64-encoded TransactionEnvelope XDR
 * @param networkPassphrase - network passphrase or alias (testnet, public, …)
 * @param knownSigners  - optional list of G-addresses to resolve signature hints
 */
export function verifyTransactionSignatures(
  envelopeXdr: string,
  networkPassphrase?: string,
  knownSigners: string[] = [],
): VerifySignaturesResult {
  const rawXdr = envelopeXdr.trim();
  if (!rawXdr) {
    return { result: null, error: 'Transaction envelope XDR is required' };
  }

  const passphrase = resolveNetworkPassphrase(networkPassphrase);

  // Parse the envelope XDR directly so we can access the raw decorated
  // signatures without going through the high-level Transaction constructor,
  // which could fail on edge-case preconditions.
  let envelope: xdr.TransactionEnvelope;
  try {
    envelope = xdr.TransactionEnvelope.fromXDR(Buffer.from(rawXdr, 'base64'));
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { result: null, error: `Malformed transaction envelope XDR: ${message}` };
  }

  const envelopeType = envelope.switch();
  const diagnostics: string[] = [];

  // ── Fee-bump envelope ────────────────────────────────────────────────────
  if (envelopeType === xdr.EnvelopeType.envelopeTypeTxFeeBump()) {
    let feeBump: FeeBumpTransaction;
    try {
      feeBump = new FeeBumpTransaction(envelope, passphrase);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return { result: null, error: `Invalid fee-bump envelope: ${message}` };
    }

    const inner = feeBump.innerTransaction;

    // Collect all accounts that might be signers.
    const outerAccounts = [feeBump.feeSource, ...knownSigners];
    const innerAccounts = [inner.source, ...knownSigners];

    const outerHintMap = buildHintMap(outerAccounts);
    const innerHintMap = buildHintMap(innerAccounts);

    const outerPayload = feeBump.hash();
    const innerPayload = inner.hash();

    const outerSigs = feeBump.signatures.map((sig, i) =>
      verifySignature(sig, outerPayload, outerHintMap, i),
    );
    const innerSigs = inner.signatures.map((sig, i) =>
      verifySignature(sig, innerPayload, innerHintMap, i),
    );

    const allSigs = [...outerSigs, ...innerSigs];
    const { validCount, invalidCount, unknownCount } = summarise(allSigs);

    if (unknownCount > 0) {
      diagnostics.push(
        `${unknownCount} signature(s) could not be resolved because no matching public key was found for their hint. ` +
          'Supply additional signers via --signers to improve coverage.',
      );
    }
    if (invalidCount > 0) {
      diagnostics.push(
        `${invalidCount} signature(s) failed cryptographic verification. ` +
          'The transaction may have been tampered with or signed on a different network.',
      );
    }

    return {
      result: {
        envelopeType: 'fee_bump',
        networkPassphrase: passphrase,
        transactionHash: feeBump.hash().toString('hex'),
        innerTransactionHash: inner.hash().toString('hex'),
        signatures: outerSigs,
        innerSignatures: innerSigs,
        validCount,
        invalidCount,
        unknownCount,
        allValid: invalidCount === 0,
        diagnostics,
      },
    };
  }

  // ── Regular transaction (v0 or v1) ───────────────────────────────────────
  if (
    envelopeType === xdr.EnvelopeType.envelopeTypeTx() ||
    envelopeType === xdr.EnvelopeType.envelopeTypeTxV0()
  ) {
    let tx: Transaction;
    try {
      tx = new Transaction(envelope, passphrase);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return { result: null, error: `Invalid transaction envelope: ${message}` };
    }

    const accounts = [tx.source, ...knownSigners];
    const hintMap = buildHintMap(accounts);
    const signingPayload = tx.hash();

    const sigs = tx.signatures.map((sig, i) =>
      verifySignature(sig, signingPayload, hintMap, i),
    );

    const { validCount, invalidCount, unknownCount } = summarise(sigs);

    if (unknownCount > 0) {
      diagnostics.push(
        `${unknownCount} signature(s) could not be resolved. ` +
          'Supply additional signer public keys via --signers to improve coverage.',
      );
    }
    if (invalidCount > 0) {
      diagnostics.push(
        `${invalidCount} signature(s) failed cryptographic verification.`,
      );
    }
    if (sigs.length === 0) {
      diagnostics.push('Transaction carries no signatures.');
    }

    return {
      result: {
        envelopeType: 'transaction',
        networkPassphrase: passphrase,
        transactionHash: tx.hash().toString('hex'),
        innerTransactionHash: null,
        signatures: sigs,
        innerSignatures: [],
        validCount,
        invalidCount,
        unknownCount,
        allValid: invalidCount === 0,
        diagnostics,
      },
    };
  }

  return {
    result: null,
    error: `Unsupported transaction envelope type: ${envelopeType.name}`,
  };
}
