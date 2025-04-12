import { SetFeeCredit } from '@alphabill/alphabill-js-sdk/lib/fees/transactions/SetFeeCredit.js';
import { DefaultSigningService } from '@alphabill/alphabill-js-sdk/lib/signing/DefaultSigningService.js';
import { createTokenClient, http } from '@alphabill/alphabill-js-sdk/lib/StateApiClientFactory.js';
import { ClientMetadata } from '@alphabill/alphabill-js-sdk/lib/transaction/ClientMetadata.js';
import { AlwaysTruePredicate } from '@alphabill/alphabill-js-sdk/lib/transaction/predicates/AlwaysTruePredicate.js';
import { PayToPublicKeyHashPredicate } from '@alphabill/alphabill-js-sdk/lib/transaction/predicates/PayToPublicKeyHashPredicate.js';
import { PayToPublicKeyHashProofFactory } from '@alphabill/alphabill-js-sdk/lib/transaction/proofs/PayToPublicKeyHashProofFactory.js';
import { TransactionStatus } from '@alphabill/alphabill-js-sdk/lib/transaction/record/TransactionStatus.js';
import { Base16Converter } from '@alphabill/alphabill-js-sdk/lib/util/Base16Converter.js';
import { MongoDBContainer, StartedMongoDBContainer } from '@testcontainers/mongodb';
import { Authenticator } from '@unicitylabs/commons/lib/api/Authenticator.js';
import { InclusionProof } from '@unicitylabs/commons/lib/api/InclusionProof.js';
import { RequestId } from '@unicitylabs/commons/lib/api/RequestId.js';
import { DataHash } from '@unicitylabs/commons/lib/hash/DataHash.js';
import { DataHasher } from '@unicitylabs/commons/lib/hash/DataHasher.js';
import { HashAlgorithm } from '@unicitylabs/commons/lib/hash/HashAlgorithm.js';
import { SigningService } from '@unicitylabs/commons/lib/signing/SigningService.js';
import { HexConverter } from '@unicitylabs/commons/lib/util/HexConverter.js';
import { DockerComposeEnvironment, StartedDockerComposeEnvironment, Wait } from 'testcontainers';

import { AggregatorGateway } from '../../../src/AggregatorGateway.js';
import { SubmitCommitmentStatus } from '../../../src/SubmitCommitmentResponse.js';

describe('Alphabill Client Integration Tests', () => {
  jest.setTimeout(60000);

  const composeFilePath = 'tests';
  const composeAlphabill = 'consensus/alphabill/docker/alphabill-docker-compose.yml';

  const privateKey = '1DE87F189C3C9E42F93C90C95E2AC761BE9D0EB2FD1CA0FF3A9CE165C3DE96A9';
  const alphabillSigningService = new DefaultSigningService(Base16Converter.decode(privateKey));
  const proofFactory = new PayToPublicKeyHashProofFactory(alphabillSigningService);
  const tokenPartitionUrl = 'http://localhost:8003/rpc';
  const networkId = 3;
  const tokenPartitionId = 2;

  let mongoContainer: StartedMongoDBContainer;
  let stateHash: DataHash;
  let transactionHash: DataHash;
  let requestId: RequestId;
  let aggregatorEnvironment: StartedDockerComposeEnvironment;
  let aggregator: AggregatorGateway;
  let unicitySigningService: SigningService;

  beforeAll(async () => {
    console.log(
      'Setting up test environment with Alphabill root node, permissioned token partition node and MongoDB...',
    );
    mongoContainer = await new MongoDBContainer('mongo:7').start();
    aggregatorEnvironment = await new DockerComposeEnvironment(composeFilePath, composeAlphabill)
      .withBuild()
      .withWaitStrategy('alphabill-tokens-1', Wait.forHealthCheck())
      .withStartupTimeout(15000)
      .up();
    console.log('Setup successful.');

    // Wait for Alphabill nodes to start up
    await new Promise((resolve) => setTimeout(resolve, 5000));

    // Set fee credit
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
    console.log('Setting fee credit successful.');

    console.log('Starting aggregator...');
    aggregator = await AggregatorGateway.create({
      alphabill: {
        privateKey: privateKey,
        networkId: networkId,
        tokenPartitionUrl: tokenPartitionUrl,
        tokenPartitionId: tokenPartitionId,
      },
      storage: {
        uri: mongoContainer.getConnectionString() + '?directConnection=true',
      },
    });
    console.log('Aggregator running.');
    stateHash = await new DataHasher(HashAlgorithm.SHA256).update(new Uint8Array([1, 2])).digest();
    transactionHash = await new DataHasher(HashAlgorithm.SHA256).update(new Uint8Array([1, 2])).digest();
    unicitySigningService = new SigningService(HexConverter.decode(privateKey));
    requestId = await RequestId.create(unicitySigningService.publicKey, stateHash);
  });

  afterAll(() => {
    aggregatorEnvironment.down();
    aggregator.stop();
    mongoContainer.stop({ timeout: 10 });
  });

  it('Submit commitment to aggregator and wait for inclusion proof', async () => {
    const authenticator: Authenticator = await Authenticator.create(unicitySigningService, transactionHash, stateHash);
    const submitCommitmentResponse = await fetch('http://localhost:80', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'submit_commitment',
        params: {
          requestId: requestId.toDto(),
          transactionHash: transactionHash.toDto(),
          authenticator: authenticator.toDto(),
        },
      }),
    });
    expect(submitCommitmentResponse.status).toEqual(200);
    const submitCommitmentData = await submitCommitmentResponse.json();
    expect(submitCommitmentData).not.toBeNull();
    console.log('Submit commitment response: ' + JSON.stringify(submitCommitmentData, null, 2));

    await new Promise((resolve) => setTimeout(resolve, 5000));

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
    const inclusionProofData = await getInclusionProofResponse.text();
    const inclusionProof = InclusionProof.fromDto(JSON.parse(inclusionProofData));
    const verificationResult = await inclusionProof.verify(requestId.toBigInt());
    expect(verificationResult).toBeTruthy();
  });

  it('Re-submit commitment to aggregator with same requestID but different state, expect error', async () => {
    const newStateHash = await new DataHasher(HashAlgorithm.SHA256).update(new Uint8Array([3, 4])).digest();
    const authenticator: Authenticator = await Authenticator.create(
      unicitySigningService,
      transactionHash,
      newStateHash,
    );
    const submitCommitmentResponse = await fetch('http://localhost:80', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'submit_commitment',
        params: {
          requestId: requestId.toDto(),
          transactionHash: transactionHash.toDto(),
          authenticator: authenticator.toDto(),
        },
      }),
    });
    expect(submitCommitmentResponse.status).toEqual(400);
    const submitCommitmentData = await submitCommitmentResponse.json();
    expect(submitCommitmentData).not.toBeNull();
    expect(submitCommitmentData.status).toEqual(SubmitCommitmentStatus.REQUEST_ID_MISMATCH);
    console.log('Submit commitment response: ' + JSON.stringify(submitCommitmentData, null, 2));
  });
});
