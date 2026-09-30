import { xdr } from '@stellar/stellar-sdk';
import { fetchTransaction } from './horizon-client';
import { validateTransactionHash } from './transaction-analyzer';

export type TransactionFailureType = 'success' | 'transaction' | 'operation';

export const RESULT_CODE_REGISTRY: {
  transaction: Record<string, string>;
  operation: Record<string, string>;
  operationSpecific: Record<string, string>;
} = {
  transaction: {
    TX_SUCCESS: 'The transaction succeeded.',
    TX_FEE_BUMP_INNER_SUCCESS: 'The fee-bump transaction succeeded.',
    TX_FAILED: 'An operation failed; the transaction was not applied.',
    TX_TOO_EARLY: 'The transaction was submitted before its minimum time bound.',
    TX_TOO_LATE: 'The transaction was submitted after its maximum time bound.',
    TX_MISSING_OPERATION: 'The transaction contains no operations.',
    TX_BAD_SEQ: 'The transaction sequence number is invalid or out of date.',
    TX_BAD_AUTH: 'The transaction is missing required signatures.',
    TX_INSUFFICIENT_BALANCE: 'The source account cannot cover the transaction fee.',
    TX_NO_ACCOUNT: 'The transaction source account does not exist.',
    TX_INSUFFICIENT_FEE: 'The transaction fee is below the network minimum.',
    TX_BAD_AUTH_EXTRA: 'The transaction contains unnecessary signatures.',
    TX_INTERNAL_ERROR: 'Stellar Core encountered an internal error.',
    TX_NOT_SUPPORTED: 'The transaction uses a feature not supported by this network.',
    TX_FEE_BUMP_INNER_FAILED: 'The inner transaction in the fee-bump failed.',
    TX_BAD_SPONSORSHIP: 'The transaction has an invalid sponsorship sequence.',
    TX_BAD_MIN_SEQ_AGE_OR_GAP:
      'The transaction does not meet the source account sequence-age constraints.',
    TX_MALFORMED: 'The transaction is malformed.',
    TX_SOROBAN_INVALID: 'The Soroban transaction is invalid.',
  },
  operation: {
    OP_INNER: 'The operation returned an operation-specific result.',
    OP_BAD_AUTH: 'The operation is missing required authorization.',
    OP_NO_ACCOUNT: 'An account required by the operation does not exist.',
    OP_NOT_SUPPORTED: 'The operation is not supported by this network.',
    OP_TOO_MANY_SUBENTRIES: 'The operation would exceed the account subentry limit.',
    OP_EXCEEDED_WORK_LIMIT: 'The operation exceeded the network work limit.',
    OP_TOO_MANY_SPONSORING: 'The operation would exceed the sponsorship limit.',
  },
  operationSpecific: {
    PAYMENT_UNDERFUNDED: 'The payment source does not have enough balance.',
    PAYMENT_NO_DESTINATION: 'The payment destination account does not exist.',
    PAYMENT_NO_TRUST: 'The destination has no trustline for the asset.',
    PAYMENT_NOT_AUTHORIZED: 'The destination trustline is not authorized to receive the asset.',
    PAYMENT_LINE_FULL: 'The destination trustline cannot hold the payment amount.',
    CREATE_ACCOUNT_UNDERFUNDED: 'The source account cannot fund the new account.',
    CREATE_ACCOUNT_ALREADY_EXIST: 'The account being created already exists.',
    PATH_PAYMENT_STRICT_RECEIVE_UNDERFUNDED:
      'The path payment source does not have enough balance.',
    PATH_PAYMENT_STRICT_RECEIVE_NO_DESTINATION:
      'The path payment destination account does not exist.',
    PATH_PAYMENT_STRICT_SEND_UNDERFUNDED: 'The path payment source does not have enough balance.',
    PATH_PAYMENT_STRICT_SEND_NO_DESTINATION: 'The path payment destination account does not exist.',
  },
};

export interface OperationResultCode {
  index: number;
  operationType?: string;
  code: string;
  description: string;
}

export interface TransactionResultAnalysis {
  hash: string;
  ledger: number | null;
  successful: boolean;
  failureType: TransactionFailureType;
  transactionResultCode: string;
  resultDescription: string;
  operationResultCodes: OperationResultCode[];
  operationsApplied: boolean;
  feeCharged: string;
  operationCount: number;
  resultXdr: string;
  decodedResult?: {
    feeCharged: string;
    transactionResult: string;
    operationResults: OperationResultCode[];
  };
}

interface HorizonTransactionResult {
  hash: string;
  ledger?: number;
  successful: boolean;
  fee_charged: string | number;
  operation_count: number;
  result_xdr: string;
}

function codeName(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z])([A-Z][a-z])/g, '$1_$2')
    .toUpperCase();
}

function describe(code: string, category: keyof typeof RESULT_CODE_REGISTRY): string {
  return RESULT_CODE_REGISTRY[category][code] ?? `Unknown ${category} result code: ${code}`;
}

function decodeUnknownTransactionResult(
  transaction: HorizonTransactionResult,
  verbose: boolean,
): TransactionResultAnalysis | undefined {
  const encoded = transaction.result_xdr;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) return undefined;

  const bytes = Buffer.from(encoded, 'base64');
  if (
    bytes.length < 12 ||
    bytes.toString('base64').replace(/=+$/, '') !== encoded.replace(/=+$/, '')
  ) {
    return undefined;
  }

  const resultCodeValue = bytes.readInt32BE(8);
  if (resultCodeValue >= -17 && resultCodeValue <= 1) return undefined;

  const transactionResultCode = `TX_UNKNOWN_${resultCodeValue}`;
  const successful = transaction.successful;
  const analysis: TransactionResultAnalysis = {
    hash: transaction.hash,
    ledger: transaction.ledger ?? null,
    successful,
    failureType: successful ? 'success' : 'transaction',
    transactionResultCode,
    resultDescription: describe(transactionResultCode, 'transaction'),
    operationResultCodes: [],
    operationsApplied: successful,
    feeCharged: String(transaction.fee_charged),
    operationCount: transaction.operation_count,
    resultXdr: encoded,
  };

  if (verbose) {
    analysis.decodedResult = {
      feeCharged: bytes.readBigInt64BE(0).toString(),
      transactionResult: transactionResultCode,
      operationResults: [],
    };
  }

  return analysis;
}

function decodeOperationResults(
  result: InstanceType<typeof xdr.TransactionResult>,
): OperationResultCode[] {
  const transactionResult = result.result();
  if (transactionResult.switch().name !== 'txFailed') return [];

  return transactionResult.results().map((operationResult, index) => {
    const operationResultCode = codeName(operationResult.switch().name);
    if (operationResultCode !== 'OP_INNER') {
      return {
        index,
        code: operationResultCode,
        description: describe(operationResultCode, 'operation'),
      };
    }

    const innerResult = operationResult.tr();
    const operationType = innerResult.switch().name;
    const resultAccessor =
      operationType === 'bumpSequence' ? 'bumpSeqResult' : `${operationType}Result`;
    const specificResult = (
      innerResult as unknown as Record<string, () => { switch(): { name: string } }>
    )[resultAccessor]();
    const code = codeName(specificResult.switch().name);
    return {
      index,
      operationType,
      code,
      description: describe(code, 'operationSpecific'),
    };
  });
}

export function decodeTransactionResult(
  transaction: HorizonTransactionResult,
  verbose = false,
): TransactionResultAnalysis {
  let decoded: InstanceType<typeof xdr.TransactionResult>;
  try {
    decoded = xdr.TransactionResult.fromXDR(transaction.result_xdr, 'base64');
  } catch (error) {
    const unknownResult = decodeUnknownTransactionResult(transaction, verbose);
    if (unknownResult) return unknownResult;

    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Unable to decode transaction result XDR: ${detail}`);
  }

  const transactionResult = decoded.result();
  const transactionResultCode = codeName(transactionResult.switch().name);
  const successful =
    transactionResultCode === 'TX_SUCCESS' || transactionResultCode === 'TX_FEE_BUMP_INNER_SUCCESS';
  const failureType: TransactionFailureType = successful
    ? 'success'
    : transactionResultCode === 'TX_FAILED'
      ? 'operation'
      : 'transaction';
  const operationResultCodes = decodeOperationResults(decoded);
  const feeCharged = decoded.feeCharged().toString();

  const analysis: TransactionResultAnalysis = {
    hash: transaction.hash,
    ledger: transaction.ledger ?? null,
    successful,
    failureType,
    transactionResultCode,
    resultDescription: describe(transactionResultCode, 'transaction'),
    operationResultCodes,
    operationsApplied: successful,
    feeCharged: String(transaction.fee_charged),
    operationCount: transaction.operation_count,
    resultXdr: transaction.result_xdr,
  };

  if (verbose) {
    analysis.decodedResult = {
      feeCharged,
      transactionResult: transactionResultCode,
      operationResults: operationResultCodes,
    };
  }

  return analysis;
}

export async function analyzeTransactionResult(options: {
  horizonUrl: string;
  hash: string;
  verbose?: boolean;
}): Promise<TransactionResultAnalysis> {
  const validation = validateTransactionHash(options.hash);
  if (!validation.valid) throw new Error(validation.error);

  const transaction = (await fetchTransaction(
    options.horizonUrl,
    options.hash,
  )) as HorizonTransactionResult;
  if (!transaction.result_xdr) {
    throw new Error(
      'Horizon returned no result_xdr for this transaction. Confirm the transaction is included in ledger history.',
    );
  }

  return decodeTransactionResult(transaction, options.verbose);
}
