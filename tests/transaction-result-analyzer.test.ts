import { xdr } from '@stellar/stellar-sdk';
import * as horizonClient from '../src/services/horizon-client';
import {
  analyzeTransactionResult,
  decodeTransactionResult,
  RESULT_CODE_REGISTRY,
} from '../src/services/transaction-result-analyzer';

const HASH = 'a'.repeat(64);

function resultXdr(result: InstanceType<typeof xdr.TransactionResultResult>): string {
  return new xdr.TransactionResult({
    feeCharged: xdr.Int64.fromString('100'),
    result,
    ext: xdr.TransactionResultExt.fromXDR('AAAAAA==', 'base64'),
  }).toXDR('base64');
}

function transaction(result: InstanceType<typeof xdr.TransactionResultResult>) {
  return {
    hash: HASH,
    ledger: 123,
    successful: result.switch().name === 'txSuccess',
    fee_charged: '100',
    operation_count: 2,
    result_xdr: resultXdr(result),
  };
}

describe('transaction result analysis', () => {
  afterEach(() => jest.restoreAllMocks());

  it('decodes successful results and preserves the raw XDR', () => {
    const analysis = decodeTransactionResult(
      transaction(xdr.TransactionResultResult.txSuccess([])),
    );

    expect(analysis.successful).toBe(true);
    expect(analysis.failureType).toBe('success');
    expect(analysis.transactionResultCode).toBe('TX_SUCCESS');
    expect(analysis.operationsApplied).toBe(true);
    expect(analysis.resultXdr).toBeTruthy();
    expect(analysis.operationCount).toBe(2);
  });

  it.each([
    ['txBadSeq', 'TX_BAD_SEQ'],
    ['txBadAuth', 'TX_BAD_AUTH'],
    ['txInsufficientBalance', 'TX_INSUFFICIENT_BALANCE'],
    ['txInsufficientFee', 'TX_INSUFFICIENT_FEE'],
    ['txTooEarly', 'TX_TOO_EARLY'],
    ['txTooLate', 'TX_TOO_LATE'],
  ] as const)('explains the transaction-level code %s', (arm, expectedCode) => {
    const result = xdr.TransactionResultResult[arm]();
    const analysis = decodeTransactionResult(transaction(result));

    expect(analysis.transactionResultCode).toBe(expectedCode);
    expect(analysis.failureType).toBe('transaction');
    expect(analysis.operationsApplied).toBe(false);
    expect(analysis.resultDescription).not.toMatch(/^Unknown/);
  });

  it('decodes multiple operation-level result codes', () => {
    const failedPayment = xdr.OperationResult.opInner(
      xdr.OperationResultTr.payment(xdr.PaymentResult.paymentUnderfunded()),
    );
    const failedAccount = xdr.OperationResult.opInner(
      xdr.OperationResultTr.createAccount(xdr.CreateAccountResult.createAccountAlreadyExist()),
    );
    const analysis = decodeTransactionResult(
      transaction(xdr.TransactionResultResult.txFailed([failedPayment, failedAccount])),
    );

    expect(analysis.failureType).toBe('operation');
    expect(analysis.transactionResultCode).toBe('TX_FAILED');
    expect(analysis.operationsApplied).toBe(false);
    expect(analysis.operationResultCodes).toEqual([
      expect.objectContaining({
        index: 0,
        operationType: 'payment',
        code: 'PAYMENT_UNDERFUNDED',
      }),
      expect.objectContaining({
        index: 1,
        operationType: 'createAccount',
        code: 'CREATE_ACCOUNT_ALREADY_EXIST',
      }),
    ]);
  });

  it('retains result codes when no human-readable registry entry exists', () => {
    const previous = RESULT_CODE_REGISTRY.transaction.TX_BAD_SEQ;
    delete RESULT_CODE_REGISTRY.transaction.TX_BAD_SEQ;
    try {
      const analysis = decodeTransactionResult(transaction(xdr.TransactionResultResult.txBadSeq()));
      expect(analysis.transactionResultCode).toBe('TX_BAD_SEQ');
      expect(analysis.resultDescription).toContain('Unknown');
    } finally {
      RESULT_CODE_REGISTRY.transaction.TX_BAD_SEQ = previous;
    }
  });

  it('preserves a future transaction-result discriminant unknown to the SDK', () => {
    const bytes = Buffer.alloc(16);
    bytes.writeBigInt64BE(100n, 0);
    bytes.writeInt32BE(99, 8);
    bytes.writeInt32BE(0, 12);
    const raw = {
      ...transaction(xdr.TransactionResultResult.txBadSeq()),
      successful: false,
      result_xdr: bytes.toString('base64'),
    };
    const analysis = decodeTransactionResult(raw);

    expect(analysis.transactionResultCode).toBe('TX_UNKNOWN_99');
    expect(analysis.resultDescription).toContain('Unknown');
    expect(analysis.resultXdr).toBe(raw.result_xdr);
  });

  it('adds decoded result details only in verbose mode', () => {
    const raw = transaction(xdr.TransactionResultResult.txSuccess([]));
    expect(decodeTransactionResult(raw).decodedResult).toBeUndefined();
    expect(decodeTransactionResult(raw, true).decodedResult?.feeCharged).toBe('100');
  });

  it('rejects malformed result XDR with a useful error', () => {
    const raw = transaction(xdr.TransactionResultResult.txSuccess([]));
    expect(() => decodeTransactionResult({ ...raw, result_xdr: 'not-xdr' })).toThrow(
      /Unable to decode transaction result XDR/,
    );
  });

  it('validates hashes before making a Horizon request', async () => {
    const fetch = jest.spyOn(horizonClient, 'fetchTransaction');
    await expect(
      analyzeTransactionResult({ horizonUrl: 'https://horizon.example', hash: 'bad' }),
    ).rejects.toThrow(/64-character hexadecimal/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('reports Horizon lookup failures to the caller', async () => {
    jest.spyOn(horizonClient, 'fetchTransaction').mockRejectedValue(new Error('404 Not Found'));
    await expect(
      analyzeTransactionResult({ horizonUrl: 'https://horizon.example', hash: HASH }),
    ).rejects.toThrow('404 Not Found');
  });

  it('explains when Horizon omits the transaction result XDR', async () => {
    jest.spyOn(horizonClient, 'fetchTransaction').mockResolvedValue({
      hash: HASH,
      successful: false,
      fee_charged: '100',
      operation_count: 1,
    });
    await expect(
      analyzeTransactionResult({ horizonUrl: 'https://horizon.example', hash: HASH }),
    ).rejects.toThrow(/no result_xdr/i);
  });

  it('includes decoded details and raw XDR in JSON-compatible output', () => {
    const analysis = decodeTransactionResult(
      transaction(xdr.TransactionResultResult.txSuccess([])),
      true,
    );
    const json = JSON.parse(JSON.stringify(analysis));

    expect(json.resultXdr).toBe(analysis.resultXdr);
    expect(json.decodedResult.transactionResult).toBeTruthy();
  });
});
