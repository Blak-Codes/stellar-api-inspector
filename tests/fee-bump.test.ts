import {
  Account,
  Asset,
  FeeBumpTransaction,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
  xdr,
} from '@stellar/stellar-sdk';
import { analyzeFeeBumpTransaction } from '../src/inspectors/fee-bump';

function buildEnvelope(
  operationCount = 1,
  sameSigner = false,
  useLedgerBounds = false,
): {
  xdr: string;
  source: Keypair;
  feeSource: Keypair;
} {
  const source = Keypair.random();
  const feeSource = sameSigner ? source : Keypair.random();
  const builder = new TransactionBuilder(new Account(source.publicKey(), '41'), {
    fee: '100',
    networkPassphrase: Networks.TESTNET,
  });

  for (let index = 0; index < operationCount; index += 1) {
    builder.addOperation(
      Operation.payment({
        destination: Keypair.random().publicKey(),
        asset: Asset.native(),
        amount: '1',
      }),
    );
  }

  builder.setTimeout(300);
  if (useLedgerBounds) builder.setLedgerbounds(1, 100);
  const inner = builder.build();
  inner.sign(source);
  const feeBump = TransactionBuilder.buildFeeBumpTransaction(
    feeSource,
    '300',
    inner,
    Networks.TESTNET,
  );
  feeBump.sign(feeSource);
  return { xdr: feeBump.toEnvelope().toXDR('base64'), source, feeSource };
}

describe('offline fee-bump transaction analysis', () => {
  it('distinguishes and normalizes a regular transaction envelope', () => {
    const keypair = Keypair.random();
    const regular = new TransactionBuilder(new Account(keypair.publicKey(), '9'), {
      fee: '100',
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(
        Operation.payment({
          destination: Keypair.random().publicKey(),
          asset: Asset.native(),
          amount: '1',
        }),
      )
      .setTimeout(300)
      .build();
    regular.sign(keypair);

    const xdr = regular.toEnvelope().toXDR('base64');
    const result = analyzeFeeBumpTransaction(xdr, 'testnet');
    expect(result.analysis?.envelopeType).toBe('transaction');
    expect(result.analysis?.rawXdr).toBe(xdr);
    expect(result.analysis?.normalized.inner).toBeNull();
    expect(result.analysis?.outerSignatures).toHaveLength(1);
  });

  it('extracts separate outer and inner fees, sources, operations, and signatures', () => {
    const fixture = buildEnvelope(1);
    const result = analyzeFeeBumpTransaction(fixture.xdr, Networks.TESTNET);
    const analysis = result.analysis!;

    expect(analysis.envelopeType).toBe('fee_bump');
    expect(analysis.normalized.outer.feeSource).toBe(fixture.feeSource.publicKey());
    expect(analysis.normalized.inner?.sourceAccount).toBe(fixture.source.publicKey());
    expect(analysis.feeRelationship?.outerFee).toBe('600');
    expect(analysis.feeRelationship?.innerFee).toBe('100');
    expect(analysis.feeRelationship?.difference).toBe('500');
    expect(analysis.feeRelationship?.effectiveMaximumFeePerOperation).toBe('300');
    expect(analysis.normalized.inner?.operationCount).toBe(1);
    expect(analysis.outerSignatures).toHaveLength(1);
    expect(analysis.innerSignatures).toHaveLength(1);
    expect(analysis.normalized.inner?.hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('calculates effective fee per operation for multi-operation transactions', () => {
    const fixture = buildEnvelope(2);
    const result = analyzeFeeBumpTransaction(fixture.xdr, 'testnet');
    expect(result.analysis?.normalized.inner?.operationCount).toBe(2);
    expect(result.analysis?.feeRelationship?.innerFee).toBe('200');
    expect(result.analysis?.feeRelationship?.effectiveMaximumFeePerOperation).toBe('300');
  });

  it('identifies duplicate signer identities when source keys resolve', () => {
    const fixture = buildEnvelope(1, true);
    const result = analyzeFeeBumpTransaction(fixture.xdr, 'testnet');
    expect(result.analysis?.duplicateSigners).toEqual([fixture.source.publicKey()]);
    expect(result.analysis?.outerSignatures[0].signerIdentity).toBe(fixture.source.publicKey());
    expect(result.analysis?.innerSignatures[0].signerIdentity).toBe(fixture.source.publicKey());
  });

  it('preserves inner time bounds and reports precondition version', () => {
    const fixture = buildEnvelope(1);
    const result = analyzeFeeBumpTransaction(fixture.xdr, 'testnet');
    const conditions = result.analysis?.normalized.inner?.preconditions as Record<string, unknown>;
    expect(conditions.version).toBe(1);
    expect(conditions.timeBounds).toEqual({ minTime: '0', maxTime: expect.any(String) });
  });

  it('preserves inner ledger bounds and identifies version 2 preconditions', () => {
    const fixture = buildEnvelope(1, false, true);
    const result = analyzeFeeBumpTransaction(fixture.xdr, 'testnet');
    const conditions = result.analysis?.normalized.inner?.preconditions as Record<string, unknown>;
    expect(conditions.version).toBe(2);
    expect(conditions.ledgerBounds).toEqual({ minLedger: 1, maxLedger: 100 });
  });

  it('diagnoses an outer fee that does not exceed the inner fee ceiling', () => {
    const fixture = buildEnvelope(1);
    const envelope = xdr.TransactionEnvelope.fromXDR(Buffer.from(fixture.xdr, 'base64'));
    envelope.feeBump().tx().fee(xdr.Int64.fromString('50'));
    const result = analyzeFeeBumpTransaction(envelope.toXDR('base64'), 'testnet');
    expect(result.analysis?.feeRelationship?.outerExceedsInner).toBe(false);
    expect(result.analysis?.diagnostics[0]).toMatch(/does not exceed/i);
  });

  it('does not report an equal fee rate as an increase over the inner ceiling', () => {
    const fixture = buildEnvelope(1);
    const envelope = xdr.TransactionEnvelope.fromXDR(Buffer.from(fixture.xdr, 'base64'));
    envelope.feeBump().tx().fee(xdr.Int64.fromString('200'));
    const result = analyzeFeeBumpTransaction(envelope.toXDR('base64'), 'testnet');
    expect(result.analysis?.feeRelationship?.outerFeeRateExceedsInnerFeeRate).toBe(false);
    expect(result.analysis?.diagnostics[0]).toMatch(/does not exceed/i);
  });

  it('reports regular envelopes without a fee-bump relationship', () => {
    const keypair = Keypair.random();
    const tx = new TransactionBuilder(new Account(keypair.publicKey(), '1'), {
      fee: '100',
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(
        Operation.payment({
          destination: Keypair.random().publicKey(),
          asset: Asset.native(),
          amount: '1',
        }),
      )
      .setTimeout(300)
      .build();
    const result = analyzeFeeBumpTransaction(tx.toEnvelope().toXDR('base64'));
    expect(result.analysis?.envelopeType).toBe('transaction');
    expect(result.analysis?.feeRelationship).toBeNull();
  });

  it('returns useful errors for malformed envelopes and invalid base64', () => {
    expect(analyzeFeeBumpTransaction('%%%').error).toMatch(/base64/i);
    expect(analyzeFeeBumpTransaction('AAAA').error).toMatch(/malformed transaction envelope/i);
    expect(analyzeFeeBumpTransaction('').error).toMatch(/required/i);
  });

  it('omits hashes without explicit network context and retains raw XDR in JSON data', () => {
    const fixture = buildEnvelope(1);
    const result = analyzeFeeBumpTransaction(fixture.xdr);
    expect(result.analysis?.networkPassphrase).toBeNull();
    expect(result.analysis?.normalized.inner?.hash).toBeNull();
    expect(JSON.stringify(result.analysis)).toContain(fixture.xdr);
  });

  it('parses SDK-built fee-bump envelope fixtures', () => {
    const fixture = buildEnvelope();
    expect(new FeeBumpTransaction(fixture.xdr, Networks.TESTNET).feeSource).toBe(
      fixture.feeSource.publicKey(),
    );
  });
});
