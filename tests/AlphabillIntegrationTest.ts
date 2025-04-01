import assert from 'node:assert';

import { AddFeeCredit } from '@alphabill/alphabill-js-sdk/lib/fees/transactions/AddFeeCredit.js';
import { TransferFeeCredit } from '@alphabill/alphabill-js-sdk/lib/fees/transactions/TransferFeeCredit.js';
import { Bill } from '@alphabill/alphabill-js-sdk/lib/money/Bill.js';
import { DefaultSigningService } from '@alphabill/alphabill-js-sdk/lib/signing/DefaultSigningService.js';
import { createMoneyClient, createTokenClient, http } from '@alphabill/alphabill-js-sdk/lib/StateApiClientFactory.js';
import { ClientMetadata } from '@alphabill/alphabill-js-sdk/lib/transaction/ClientMetadata.js';
import { AlwaysTruePredicate } from '@alphabill/alphabill-js-sdk/lib/transaction/predicates/AlwaysTruePredicate.js';
import {
  PayToPublicKeyHashPredicate
} from '@alphabill/alphabill-js-sdk/lib/transaction/predicates/PayToPublicKeyHashPredicate.js';
import {
  PayToPublicKeyHashProofFactory
} from '@alphabill/alphabill-js-sdk/lib/transaction/proofs/PayToPublicKeyHashProofFactory.js';
import { TransactionStatus } from '@alphabill/alphabill-js-sdk/lib/transaction/record/TransactionStatus.js';
import { Base16Converter } from '@alphabill/alphabill-js-sdk/lib/util/Base16Converter.js';
import { Authenticator } from '@unicitylabs/commons/lib/api/Authenticator.js';
import { RequestId } from '@unicitylabs/commons/lib/api/RequestId.js';
import { DataHash } from '@unicitylabs/commons/lib/hash/DataHash.js';
import { HashAlgorithm } from '@unicitylabs/commons/lib/hash/HashAlgorithm.js';
import { DockerComposeEnvironment, StartedDockerComposeEnvironment, Wait } from 'testcontainers';

import { AggregatorGateway } from '../src/AggregatorGateway.js';

describe('Alphabill Client Integration Tests', () => {
  jest.setTimeout(60000);

  const composeFilePath = 'tests/docker';
  const composeAlphabill = 'alphabill/docker-compose.yml';
  const composeMongo = 'storage/mongo/docker-compose.yml';

  const privateKey = '1DE87F189C3C9E42F93C90C95E2AC761BE9D0EB2FD1CA0FF3A9CE165C3DE96A9';
  const signingService = new DefaultSigningService(Base16Converter.decode(privateKey));
  const proofFactory = new PayToPublicKeyHashProofFactory(signingService);
  const publicKey = signingService.publicKey;
  const moneyPartitionUrl = 'http://localhost:8001/rpc';
  const tokenPartitionUrl = 'http://localhost:9001/rpc';
  const networkId = 3;
  const moneyPartitionId = 1;
  const tokenPartitionId = 2;

  const stateHash: DataHash = new DataHash(HashAlgorithm.SHA256, new Uint8Array());
  let requestId: RequestId;
  let aggregatorEnvironment: StartedDockerComposeEnvironment;

  beforeAll(async () => {
    aggregatorEnvironment = await new DockerComposeEnvironment(composeFilePath, [composeAlphabill, composeMongo])
      .withBuild()
      .withWaitStrategy('alphabill-money-1', Wait.forHealthCheck())
      .withWaitStrategy('alphabill-tokens-1', Wait.forHealthCheck())
      .withStartupTimeout(15000)
      .up();
    requestId = await RequestId.create(new Uint8Array(), stateHash);
  });

  afterAll(async () => {
    await aggregatorEnvironment.down();
  });

  it('Add fee credit', async () => {
    const moneyClient = createMoneyClient({
      transport: http(moneyPartitionUrl)
    });
    const tokenClient = createTokenClient({
      transport: http(tokenPartitionUrl)
    });

    const ownerPredicate = PayToPublicKeyHashPredicate.create(publicKey);
    const unitIds = (await moneyClient.getUnitsByOwnerId(publicKey)).bills;
    expect(unitIds.length).toBeGreaterThan(0);

    const bill = await moneyClient.getUnit(unitIds[0], false, Bill);
    expect(bill).not.toBeNull();

    const amountToFeeCredit = 100n;
    expect(bill!.value).toBeGreaterThan(amountToFeeCredit);

    const round = (await tokenClient.getRoundInfo()).roundNumber;

    console.log('Transferring to fee credit...');
    const transferFeeCreditTransactionOrder = await TransferFeeCredit.create({
      version: 1n,
      amount: amountToFeeCredit,
      targetPartitionIdentifier: tokenPartitionId,
      latestAdditionTime: round + 60n,
      feeCreditRecord: {
        ownerPredicate: ownerPredicate
      },
      bill: bill!,
      stateLock: null,
      metadata: new ClientMetadata(round + 60n, 5n, null, new Uint8Array()),
      stateUnlock: new AlwaysTruePredicate(),
      networkIdentifier: networkId,
      partitionIdentifier: moneyPartitionId
    }).sign(proofFactory);

    const transferFeeCreditHash = await moneyClient.sendTransaction(transferFeeCreditTransactionOrder);

    const transferFeeCreditProof = await moneyClient.waitTransactionProof(transferFeeCreditHash, TransferFeeCredit);
    expect(transferFeeCreditProof.transactionRecord.serverMetadata.successIndicator).toEqual(
      TransactionStatus.Successful
    );
    console.log('Transfer to fee credit successful.');
    const feeCreditRecordId = transferFeeCreditTransactionOrder.payload.attributes.targetUnitId;

    console.log('Adding fee credit...');
    const addFeeCreditTransactionOrder = await AddFeeCredit.create({
      version: 1n,
      targetPartitionIdentifier: tokenPartitionId,
      ownerPredicate: ownerPredicate,
      proof: transferFeeCreditProof,
      feeCreditRecord: { unitId: feeCreditRecordId },
      stateLock: null,
      metadata: new ClientMetadata(round + 60n, 5n, null, new Uint8Array()),
      stateUnlock: new AlwaysTruePredicate(),
      networkIdentifier: networkId,
      partitionIdentifier: tokenPartitionId
    }).sign(proofFactory);

    const addFeeCreditHash = await tokenClient.sendTransaction(addFeeCreditTransactionOrder);
    const addFeeCreditProof = await tokenClient.waitTransactionProof(addFeeCreditHash, AddFeeCredit);
    expect(addFeeCreditProof.transactionRecord.serverMetadata.successIndicator).toEqual(
      TransactionStatus.Successful
    );
    console.log('Adding fee credit successful.');
  });

  it('Submit hash and get inclusion proof', async () => {
    const aggregator = new AggregatorGateway({
      alphabillPrivateKey: privateKey,
      alphabillNetworkId: networkId,
      alphabillTokenPartitionUrl: tokenPartitionUrl,
      alphabillTokenPartitionId: tokenPartitionId
    });
    await aggregator.init();
    await aggregator.start();
    const transactionHash: DataHash = new DataHash(HashAlgorithm.SHA256, new Uint8Array());
    const authenticator: Authenticator = new Authenticator(
      signingService.publicKey,
      'SHA-256',
      new Uint8Array(),
      stateHash
    );
    const submitTransactionResponse = await fetch('http://localhost:80', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'submit_transaction',
        params: {
          requestId: requestId.toDto(),
          transactionHash: transactionHash.toDto(),
          authenticator: authenticator.toDto()
        }
      })
    });
    const submitTransactionData = await submitTransactionResponse.json();
    expect(submitTransactionData).not.toBeNull();
    console.log(submitTransactionData);

    const getInclusionProofResponse = await fetch('http://localhost:80', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'get_inclusion_proof',
        params: {
          requestId: requestId.toDto()
        }
      })
    });
    const inclusionProofData = await getInclusionProofResponse.json();
    expect(inclusionProofData).not.toBeNull();
    console.log(inclusionProofData);
  });
});
