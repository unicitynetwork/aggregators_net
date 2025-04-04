import { DefaultSigningService } from '@alphabill/alphabill-js-sdk/lib/signing/DefaultSigningService.js';
import { createTokenClient, http } from '@alphabill/alphabill-js-sdk/lib/StateApiClientFactory.js';
import { ClientMetadata } from '@alphabill/alphabill-js-sdk/lib/transaction/ClientMetadata.js';
import { AlwaysTruePredicate } from '@alphabill/alphabill-js-sdk/lib/transaction/predicates/AlwaysTruePredicate.js';
import { PayToPublicKeyHashPredicate } from '@alphabill/alphabill-js-sdk/lib/transaction/predicates/PayToPublicKeyHashPredicate.js';
import { PayToPublicKeyHashProofFactory } from '@alphabill/alphabill-js-sdk/lib/transaction/proofs/PayToPublicKeyHashProofFactory.js';
import { TransactionStatus } from '@alphabill/alphabill-js-sdk/lib/transaction/record/TransactionStatus.js';
import { Base16Converter } from '@alphabill/alphabill-js-sdk/lib/util/Base16Converter.js';
import { Authenticator } from '@unicitylabs/commons/lib/api/Authenticator.js';
import { RequestId } from '@unicitylabs/commons/lib/api/RequestId.js';
import { DataHash } from '@unicitylabs/commons/lib/hash/DataHash.js';
import { DataHasher } from '@unicitylabs/commons/lib/hash/DataHasher.js';
import { HashAlgorithm } from '@unicitylabs/commons/lib/hash/HashAlgorithm.js';
import { SigningService } from '@unicitylabs/commons/lib/signing/SigningService.js';
import { HexConverter } from '@unicitylabs/commons/lib/util/HexConverter.js';
import { DockerComposeEnvironment, StartedDockerComposeEnvironment, Wait } from 'testcontainers';

import { AggregatorGateway } from '../../../src/AggregatorGateway.js';
import { SubmitStateTransitionStatus } from '../../../src/SubmitStateTransitionResponse.js';
import { SetFeeCredit } from '@alphabill/alphabill-js-sdk/lib/fees/transactions/SetFeeCredit.js';

describe('Alphabill Client Integration Tests', () => {
  jest.setTimeout(60000);

  const composeFilePath = 'tests';
  const composeAlphabill = 'consensus/alphabill/docker/alphabill-docker-compose.yml';
  const composeMongo = 'docker/mongodb-docker-compose.yml';

  const privateKey = '1DE87F189C3C9E42F93C90C95E2AC761BE9D0EB2FD1CA0FF3A9CE165C3DE96A9';
  const alphabillSigningService = new DefaultSigningService(Base16Converter.decode(privateKey));
  const proofFactory = new PayToPublicKeyHashProofFactory(alphabillSigningService);
  const tokenPartitionUrl = 'http://localhost:9001/rpc';
  const networkId = 3;
  const tokenPartitionId = 2;

  let stateHash: DataHash;
  let transactionHash: DataHash;
  let requestId: RequestId;
  let aggregatorEnvironment: StartedDockerComposeEnvironment;
  let aggregator: AggregatorGateway;
  let unicitySigningService: SigningService;

  beforeAll(async () => {
    console.log('Setting up test environment with Alphabill root nodes, permissioned token partition and MongoDB...');
    aggregatorEnvironment = await new DockerComposeEnvironment(composeFilePath, [composeAlphabill, composeMongo])
      .withBuild()
      .withWaitStrategy('alphabill-tokens-1', Wait.forHealthCheck())
      .withStartupTimeout(15000)
      .up();
    console.log('Setup successful.');

    console.log('Starting aggregator...');
    aggregator = await AggregatorGateway.create({
      alphabill: {
        privateKey: privateKey,
        networkId: networkId,
        tokenPartitionUrl: tokenPartitionUrl,
        tokenPartitionId: tokenPartitionId,
      },
    });
    console.log('Aggregator running.');
    stateHash = await new DataHasher(HashAlgorithm.SHA256).update(new Uint8Array([1, 2])).digest();
    transactionHash = await new DataHasher(HashAlgorithm.SHA256).update(new Uint8Array([1, 2])).digest()
    requestId = await RequestId.create(alphabillSigningService.publicKey, stateHash);
    unicitySigningService = new SigningService(HexConverter.decode(privateKey));
  });

  afterAll(async () => {
    await aggregator.stop();
    await aggregatorEnvironment.down();
  });

  // Can be skipped as docker script already assigns fee credit to admin key. Leaving it here for reference.
  it.skip('Set fee credit on permissioned Alphabill token partition', async () => {
    console.log('Setting fee credit...');
    const tokenClient = createTokenClient({ transport: http(tokenPartitionUrl) });
    const ownerPredicate = PayToPublicKeyHashPredicate.create(alphabillSigningService.publicKey);
    const round = (await tokenClient.getRoundInfo()).roundNumber;
    const setFeeCreditTransactionOrder = await SetFeeCredit.create({
      targetPartitionIdentifier: tokenPartitionId,
      ownerPredicate: ownerPredicate,
      amount: 100n,
      feeCreditRecord: { unitId: null, counter: null },
      version: 1n,
      networkIdentifier: networkId,
      partitionIdentifier: tokenPartitionId,
      stateLock: null,
      metadata: new ClientMetadata(round + 60n, 5n, null, null),
      stateUnlock: new AlwaysTruePredicate(),
    }).sign(proofFactory);
    const setFeeCreditHash = await tokenClient.sendTransaction(setFeeCreditTransactionOrder);
    const setFeeCreditProof = await tokenClient.waitTransactionProof(setFeeCreditHash, SetFeeCredit);
    expect(setFeeCreditProof.transactionRecord.serverMetadata.successIndicator).toEqual(TransactionStatus.Successful);
    console.log('Setting fee credit successful.')
  });

  it('Submit transaction to aggregator', async () => {
    const authenticator: Authenticator = await Authenticator.create(unicitySigningService, transactionHash, stateHash);
    const submitTransactionResponse = await fetch('http://localhost:80', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'submit_transaction',
        params: {
          requestId: requestId.toDto(),
          transactionHash: transactionHash.toDto(),
          authenticator: authenticator.toDto(),
        },
      }),
    });
    expect(submitTransactionResponse.status).toEqual(200);
    const submitTransactionData = await submitTransactionResponse.json();
    expect(submitTransactionData).not.toBeNull();
    console.log('Submit transaction response: ' + JSON.stringify(submitTransactionData, null, 2));
  });

  it('Get inclusion proof', async () => {
    const getInclusionProofResponse = await fetch('http://localhost:80', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'get_inclusion_proof',
        params: {
          requestId: requestId.toDto(),
        },
      }),
    });
    expect(getInclusionProofResponse.status).toEqual(200);
    const inclusionProofData = await getInclusionProofResponse.json();
    expect(inclusionProofData).not.toBeNull();
    console.log('Get inclusion proof response: ' + JSON.stringify(inclusionProofData, null, 2));
  });

  it('Re-submit transaction to aggregator with non-unique requestID', async () => {
    const authenticator: Authenticator = await Authenticator.create(unicitySigningService, transactionHash, stateHash);
    const submitTransactionResponse = await fetch('http://localhost:80', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'submit_transaction',
        params: {
          requestId: requestId.toDto(),
          transactionHash: transactionHash.toDto(),
          authenticator: authenticator.toDto(),
        },
      }),
    });
    expect(submitTransactionResponse.status).toEqual(400);
    const submitTransactionData = await submitTransactionResponse.json();
    expect(submitTransactionData).not.toBeNull();
    expect(submitTransactionData.status).toEqual(SubmitStateTransitionStatus.REQUEST_ID_EXISTS);
    console.log('Submit transaction response: ' + JSON.stringify(submitTransactionData, null, 2));
  });
});
