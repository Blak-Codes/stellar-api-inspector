/**
 * Muxed Account Address Inspection
 *
 * Offline analysis of Stellar account address strings.
 * Distinguishes regular G... Ed25519 addresses from M... muxed
 * (multiplexed) addresses defined in CAP-27 / SEP-23, extracts
 * the underlying base account and multiplexing identifier, and
 * normalises the canonical form — all without any network calls.
 */

import { MuxedAccount, StrKey } from '@stellar/stellar-sdk';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type AddressType = 'ed25519' | 'muxed';

export interface MuxedAccountInspectionResult {
  /** The raw input string provided by the caller */
  input: string;
  /** Whether the input is a valid Stellar address of any supported type */
  isValid: boolean;
  /** Address type detected, or null when the input is invalid */
  type: AddressType | null;
  /** Canonical form of the address (trimmed, no trailing whitespace) */
  canonicalAddress: string | null;
  /**
   * The underlying Ed25519 G... account that exists on the ledger.
   * - For a G... address this equals `canonicalAddress`.
   * - For an M... address this is the base account the mux ID is attached to.
   */
  baseAccountId: string | null;
  /**
   * The numeric multiplexing identifier embedded in the M... address.
   * Null for regular G... addresses.
   */
  muxId: string | null;
  /**
   * Human-readable summary of what was detected.
   */
  summary: string;
  /**
   * Notes explaining the address format and any relevant observations.
   */
  notes: string[];
  /**
   * Error message when `isValid` is false.
   */
  error?: string;
}

// ---------------------------------------------------------------------------
// Public inspector
// ---------------------------------------------------------------------------

/**
 * Inspect a Stellar address string offline.
 *
 * Accepts both regular Ed25519 public keys (G...) and muxed account
 * addresses (M...). Returns a fully-typed result regardless of validity.
 */
export function inspectMuxedAccount(input: string): MuxedAccountInspectionResult {
  const trimmed = input.trim();

  if (!trimmed) {
    return invalidResult(input, 'Address is empty or contains only whitespace.');
  }

  // ── Ed25519 public key (G...) ──────────────────────────────────────────
  if (StrKey.isValidEd25519PublicKey(trimmed)) {
    return buildEd25519Result(trimmed);
  }

  // ── Muxed account address (M...) ──────────────────────────────────────
  if (StrKey.isValidMed25519PublicKey(trimmed)) {
    return buildMuxedResult(trimmed);
  }

  // ── Invalid ────────────────────────────────────────────────────────────
  return invalidResult(
    trimmed,
    buildInvalidError(trimmed),
  );
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function buildEd25519Result(address: string): MuxedAccountInspectionResult {
  return {
    input: address,
    isValid: true,
    type: 'ed25519',
    canonicalAddress: address,
    baseAccountId: address,
    muxId: null,
    summary: 'Regular Ed25519 Stellar account address (G...).',
    notes: [
      'This is a standard Stellar account address that maps directly to a single ledger account.',
      'No multiplexing identifier is present.',
      'It can be used as the base account for creating muxed addresses by attaching any numeric ID.',
    ],
  };
}

function buildMuxedResult(muxedAddress: string): MuxedAccountInspectionResult {
  try {
    // MuxedAccount.fromAddress requires a sequence number argument but we
    // only need structural parsing — use '0' as a placeholder.
    const parsed = MuxedAccount.fromAddress(muxedAddress, '0');
    const baseAccountId = parsed.baseAccount().accountId();
    const muxId = parsed.id();

    return {
      input: muxedAddress,
      isValid: true,
      type: 'muxed',
      canonicalAddress: muxedAddress,
      baseAccountId,
      muxId,
      summary: `Muxed (multiplexed) account address (M...) with ID ${muxId}.`,
      notes: buildMuxedNotes(baseAccountId, muxId),
    };
  } catch (err: unknown) {
    // StrKey validated the checksum; a parsing failure here is unexpected
    // but we degrade gracefully.
    const message = err instanceof Error ? err.message : String(err);
    return invalidResult(muxedAddress, `Address passed checksum but could not be decoded: ${message}`);
  }
}

function buildMuxedNotes(baseAccountId: string, muxId: string): string[] {
  const notes: string[] = [
    'Muxed accounts (CAP-27 / SEP-23) allow a single on-ledger account to be ' +
      'logically subdivided into many virtual sub-accounts using a numeric ID.',
    `The underlying ledger account is ${baseAccountId}. Only this G... address ` +
      'exists on the Stellar ledger; the M... address is an off-ledger routing hint.',
    `The multiplexing ID is ${muxId}. IDs are 64-bit unsigned integers (0 – 18,446,744,073,709,551,615).`,
    'Operations sent to or from this M... address will be recorded against the ' +
      'base account on the ledger. Clients that support SEP-23 preserve the mux ID ' +
      'in transaction metadata for off-chain accounting.',
    'To verify whether the underlying base account exists and is funded, run: ' +
      `account ${baseAccountId}`,
  ];
  return notes;
}

function buildInvalidError(input: string): string {
  if (input.startsWith('G') || input.startsWith('g')) {
    return 'Input looks like a G... address but failed Ed25519 public key validation. Check for typos or truncation.';
  }
  if (input.startsWith('M') || input.startsWith('m')) {
    return 'Input looks like an M... muxed address but failed Med25519 checksum validation. Check for typos or truncation.';
  }
  if (input.startsWith('S') || input.startsWith('s')) {
    return 'Input appears to be a Stellar secret key (S...). Secret keys are not accepted — provide a public key or muxed address.';
  }
  return (
    `"${input.slice(0, 20)}${input.length > 20 ? '…' : ''}" is not a recognised Stellar address format. ` +
    'Expected a G... Ed25519 public key (56 characters) or an M... muxed account address.'
  );
}

function invalidResult(
  input: string,
  error: string,
): MuxedAccountInspectionResult {
  return {
    input,
    isValid: false,
    type: null,
    canonicalAddress: null,
    baseAccountId: null,
    muxId: null,
    summary: 'Invalid or unrecognised Stellar address.',
    notes: [],
    error,
  };
}
