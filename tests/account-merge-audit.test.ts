import { Keypair } from '@stellar/stellar-sdk';
import { auditAccountMerge, validateMergeAccountIds } from '../src/inspectors/account-merge-audit';
import { formatAccountMergeAudit } from '../src/output/account-merge-audit';

const sourceId = Keypair.random().publicKey();
const destinationId = Keypair.random().publicKey();
const horizonUrl = 'https://horizon.example.test';

function account(accountId: string, overrides: Record<string, unknown> = {}) {
  return {
    id: accountId,
    subentry_count: 0,
    num_sponsoring: 0,
    num_sponsored: 0,
    balances: [
      {
        asset_type: 'native',
        balance: '100.0000000',
        selling_liabilities: '0.0000000',
        buying_liabilities: '0.0000000',
      },
    ],
    signers: [{ key: accountId, weight: 1, type: 'ed25519_public_key' }],
    data: {},
    ...overrides,
  };
}

function response(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

function mockHorizon(
  options: {
    source?: unknown;
    destination?: unknown;
    offers?: unknown;
    history?: unknown;
    failSource?: number;
    failDestination?: number;
    failOffers?: number;
  } = {},
) {
  const fetchMock = jest.fn<Promise<Response>, [string | URL, RequestInit?]>(async (input) => {
    const url = String(input);
    if (url.includes(`/accounts/${sourceId}/offers`)) {
      return options.failOffers
        ? response({}, options.failOffers)
        : response(options.offers ?? { _embedded: { records: [] } });
    }
    if (url.includes(`/accounts/${sourceId}/operations`)) {
      return response(options.history ?? { _embedded: { records: [] } });
    }
    if (url.includes(`/accounts/${sourceId}`)) {
      return options.failSource
        ? response({}, options.failSource)
        : response(options.source ?? account(sourceId));
    }
    if (url.includes(`/accounts/${destinationId}`)) {
      return options.failDestination
        ? response({}, options.failDestination)
        : response(options.destination ?? account(destinationId));
    }
    return response({}, 404);
  });
  global.fetch = fetchMock as typeof fetch;
  return fetchMock;
}

describe('account merge safety audit', () => {
  let originalFetch: typeof fetch;

  beforeAll(() => {
    originalFetch = global.fetch;
  });

  afterAll(() => {
    global.fetch = originalFetch;
  });

  beforeEach(() => jest.clearAllMocks());

  it('validates source and destination IDs before network access', async () => {
    expect(validateMergeAccountIds('bad', destinationId).valid).toBe(false);
    expect(validateMergeAccountIds(sourceId, 'bad').valid).toBe(false);
    const fetchMock = mockHorizon();
    await expect(auditAccountMerge(horizonUrl, 'bad', destinationId)).rejects.toThrow('source');
    await expect(auditAccountMerge(horizonUrl, sourceId, 'bad')).rejects.toThrow('destination');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects identical account IDs before network access', async () => {
    const fetchMock = mockHorizon();
    expect(validateMergeAccountIds(sourceId, sourceId).valid).toBe(false);
    await expect(auditAccountMerge(horizonUrl, sourceId, sourceId)).rejects.toThrow('distinct');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('loads both accounts and classifies an account with no observed blockers as ready', async () => {
    const fetchMock = mockHorizon();
    const result = await auditAccountMerge(horizonUrl, sourceId, destinationId);

    expect(result.status).toBe('ready');
    expect(result.sourceAccount.readable).toBe(true);
    expect(result.destinationAccount.readable).toBe(true);
    expect(result.sourceAccount.nativeBalance).toBe('100.0000000');
    expect(result.sourceAccount.estimatedTransferableBalance).toBe('100');
    expect(result.sourceAccount.subentryCount).toBe(0);
    expect(result.sourceAccount.remainingSubentries).toBe(0);
    expect(result.sourceAccount.raw).toEqual(account(sourceId));
    expect(result.sourceAccount.rawOffers).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls.every(([, init]) => !init?.method || init.method === 'GET')).toBe(
      true,
    );
    expect(result.readOnly).toBe(true);
  });

  it('detects trustlines, offers, data entries, extra signers, sponsorship and liabilities', async () => {
    const customSigner = Keypair.random().publicKey();
    mockHorizon({
      source: account(sourceId, {
        subentry_count: 5,
        num_sponsoring: 1,
        num_sponsored: 2,
        balances: [
          {
            asset_type: 'native',
            balance: '100',
            selling_liabilities: '2',
            buying_liabilities: '1',
          },
          {
            asset_type: 'credit_alphanum4',
            asset_code: 'USD',
            asset_issuer: destinationId,
            balance: '5',
            limit: '10',
          },
        ],
        signers: [
          { key: sourceId, weight: 1, type: 'ed25519_public_key' },
          { key: customSigner, weight: 1, type: 'ed25519_public_key' },
        ],
        data: { memo: 'eA==' },
      }),
      offers: { _embedded: { records: [{ id: '1' }, { id: '2' }] } },
    });

    const result = await auditAccountMerge(horizonUrl, sourceId, destinationId);
    const codes = result.findings.map((finding) => finding.code);
    expect(result.status).toBe('requires-cleanup');
    expect(result.sourceAccount.trustlineCount).toBe(1);
    expect(result.sourceAccount.offerCount).toBe(2);
    expect(result.sourceAccount.rawOffers).toEqual([{ id: '1' }, { id: '2' }]);
    expect(result.sourceAccount.dataEntryCount).toBe(1);
    expect(result.sourceAccount.additionalSignerCount).toBe(1);
    expect(result.sourceAccount.sponsorshipRelationships).toBe(3);
    expect(result.sourceAccount.sellingLiabilities).toBe('2');
    expect(result.sourceAccount.buyingLiabilities).toBe('1');
    expect(result.sourceAccount.estimatedTransferableBalance).toBe('98');
    expect(codes).toEqual(
      expect.arrayContaining([
        'active-offers',
        'trustlines',
        'data-entries',
        'additional-signers',
        'sponsorship-relationships',
        'outstanding-liabilities',
      ]),
    );
  });

  it('reports a missing destination separately from source cleanup', async () => {
    mockHorizon({ failDestination: 404 });
    const result = await auditAccountMerge(horizonUrl, sourceId, destinationId);
    expect(result.status).toBe('destination-unavailable');
    expect(result.destinationAccount.exists).toBe(false);
    expect(result.findings.map((finding) => finding.code)).toContain('destination-unavailable');
  });

  it('does not assume readiness when the source is missing or offers cannot be read', async () => {
    mockHorizon({ failSource: 404 });
    const missingSource = await auditAccountMerge(horizonUrl, sourceId, destinationId);
    expect(missingSource.status).toBe('insufficient-information');
    expect(missingSource.sourceAccount.exists).toBe(false);

    mockHorizon({ failOffers: 503 });
    const partial = await auditAccountMerge(horizonUrl, sourceId, destinationId);
    expect(partial.status).toBe('insufficient-information');
    expect(partial.sourceAccount.offerCount).toBeNull();
    expect(partial.findings.map((finding) => finding.code)).toContain('offers-unavailable');
  });

  it('reports missing sponsorship values as insufficient information', async () => {
    mockHorizon({ source: account(sourceId, { num_sponsoring: undefined }) });
    const result = await auditAccountMerge(horizonUrl, sourceId, destinationId);
    expect(result.status).toBe('insufficient-information');
    expect(result.findings.map((finding) => finding.code)).toContain('sponsorship-unknown');
  });

  it('optionally inspects relevant historical activity and remains JSON serializable', async () => {
    const fetchMock = mockHorizon({
      history: {
        _embedded: {
          records: [
            { id: 'op-1', type: 'begin_sponsoring_future' },
            { id: 'op-2', type: 'payment' },
            { id: 'op-3', type: 'set_options' },
          ],
        },
      },
    });
    const result = await auditAccountMerge(horizonUrl, sourceId, destinationId, {
      historyDepth: 20,
    });
    expect(result.historicalInspection.inspected).toBe(true);
    expect(result.historicalInspection.records).toHaveLength(2);
    expect(
      fetchMock.mock.calls.some(([url]) => String(url).includes('/operations?order=desc&limit=20')),
    ).toBe(true);
    expect(JSON.parse(JSON.stringify(result)).status).toBe('ready');
  });

  it('formats observations separately from the derived classification and actions', async () => {
    mockHorizon({
      source: account(sourceId, { subentry_count: 1, data: { memo: 'eA==' } }),
    });
    const result = await auditAccountMerge(horizonUrl, sourceId, destinationId);
    const text = formatAccountMergeAudit(result);
    expect(text).toContain('Classification:');
    expect(text).toContain('--- Source Observations ---');
    expect(text).toContain('--- Findings and Actions ---');
    expect(text).toContain('REQUIRES-CLEANUP');
    expect(text).toContain('Remove account data entries before merging.');
    expect(JSON.stringify(result)).toContain('selling_liabilities');
  });
});
