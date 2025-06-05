import { Authenticator } from '@unicitylabs/commons/lib/api/Authenticator.js';
import { RequestId } from '@unicitylabs/commons/lib/api/RequestId.js';
import { DataHasher } from '@unicitylabs/commons/lib/hash/DataHasher.js';
import { HashAlgorithm } from '@unicitylabs/commons/lib/hash/HashAlgorithm.js';
import { SigningService } from '@unicitylabs/commons/lib/signing/SigningService.js';
import { HexConverter } from '@unicitylabs/commons/lib/util/HexConverter.js';
import mongoose from 'mongoose';

import { IReplicaSet, setupReplicaSet } from './TestUtils.js';
import { AggregatorGateway } from '../src/AggregatorGateway.js';
import { Commitment } from '../src/commitment/Commitment.js';
import logger from '../src/logger.js';

describe('Round Manager Integration Tests', () => {
  jest.setTimeout(120000); // Increased timeout for replica set setup

  let replicaSet: IReplicaSet;
  let mongoUri: string;
  let aggregator: AggregatorGateway;

  beforeAll(async () => {
    // Set up MongoDB replica set for transaction support
    replicaSet = await setupReplicaSet('rm-integration-');
    mongoUri = replicaSet.uri;
    logger.info(`Connecting to MongoDB replica set at ${mongoUri}`);
    await mongoose.connect(mongoUri);

    logger.info('Starting aggregator...');
    aggregator = await AggregatorGateway.create({
      aggregatorConfig: {
        port: 1111,
      },
      alphabill: { useMock: true, privateKey: HexConverter.encode(SigningService.generatePrivateKey()) },
      storage: {
        uri: mongoUri,
      },
    });
    logger.info('Aggregator running.');
  });

  afterAll(async () => {
    await aggregator.stop();

    if (mongoose.connection.readyState !== 0) {
      logger.info('Closing mongoose connection...');
      await mongoose.connection.close();
    }

    if (replicaSet?.containers) {
      logger.info('Stopping replica set containers...');
      for (const container of replicaSet.containers) {
        await container.stop();
      }
    }

    logger.info('Disconnected from MongoDB replica set');
  });

  it('Submit commitment and create block', async () => {
    const unicitySigningService = new SigningService(
      HexConverter.decode('1DE87F189C3C9E42F93C90C95E2AC761BE9D0EB2FD1CA0FF3A9CE165C3DE96A9'),
    );
    const stateHash = await new DataHasher(HashAlgorithm.SHA256).update(new Uint8Array([1, 2])).digest();
    const notSubmittedStateHash = await new DataHasher(HashAlgorithm.SHA256).update(new Uint8Array([3, 4])).digest();
    const transactionHash = await new DataHasher(HashAlgorithm.SHA256).update(new Uint8Array([1, 2])).digest();
    const requestId = await RequestId.create(unicitySigningService.publicKey, stateHash);
    const notSubmittedRequestId = await RequestId.create(unicitySigningService.publicKey, notSubmittedStateHash);
    const authenticator = await Authenticator.create(unicitySigningService, transactionHash, stateHash);
    const commitment = new Commitment(requestId, transactionHash, authenticator);
    const roundManager = aggregator.getRoundManager();
    await roundManager.submitCommitment(commitment);

    // Check if commitment is included in next few blocks
    let commitmentFound = false;
    let notSubmittedCommitmentFound = false;

    const latestBlockBeforeCheck = await roundManager.getBlockRecordsStorage().getLatest();
    const startBlockNumber = latestBlockBeforeCheck ? latestBlockBeforeCheck.blockNumber : 0n;

    await new Promise((resolve) => setTimeout(resolve, 2000));

    for (let i = 0; i < 5; i++) {
      const latestBlock = await roundManager.getBlockRecordsStorage().getLatest();
      if (!latestBlock) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        continue;
      }

      if (latestBlock.requestIds.find((rid) => rid.hash.equals(requestId.hash))) {
        commitmentFound = true;
        break;
      }

      if (latestBlock.requestIds.find((rid) => rid.hash.equals(notSubmittedRequestId.hash))) {
        notSubmittedCommitmentFound = true;
      }

      // Also check previous blocks in case we missed it
      const currentBlockNum = latestBlock.blockNumber;
      for (let blockNum = startBlockNumber; blockNum < currentBlockNum; blockNum++) {
        const block = await roundManager.getBlockRecordsStorage().get(blockNum);
        if (block && block.requestIds.find((rid) => rid.hash.equals(requestId.hash))) {
          commitmentFound = true;
          break;
        }
        if (block && block.requestIds.find((rid) => rid.hash.equals(notSubmittedRequestId.hash))) {
          notSubmittedCommitmentFound = true;
        }
      }

      if (commitmentFound) {
        break;
      }

      await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    expect(commitmentFound).toBeTruthy();
    expect(notSubmittedCommitmentFound).toBeFalsy();
  });
});
