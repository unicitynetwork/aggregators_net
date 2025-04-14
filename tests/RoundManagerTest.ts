import { RequestId } from '@unicitylabs/commons/lib/api/RequestId.js';
import { HashAlgorithm } from '@unicitylabs/commons/lib/hash/HashAlgorithm.js';

import { startMongoDb, stopMongoDb } from './TestContainers.js';
import logger from '../src/logger.js';
import { AggregatorGateway } from '../src/AggregatorGateway.js';
import { StartedMongoDBContainer } from '@testcontainers/mongodb';
import { Commitment } from '../src/commitment/Commitment.js';
import { SigningService } from '@unicitylabs/commons/lib/signing/SigningService.js';
import { HexConverter } from '@unicitylabs/commons/lib/util/HexConverter.js';
import { DataHasher } from '@unicitylabs/commons/lib/hash/DataHasher.js';
import { Authenticator } from '@unicitylabs/commons/lib/api/Authenticator.js';

describe('Round Manager Tests', () => {
  jest.setTimeout(60000);

  let container: StartedMongoDBContainer;

  beforeAll(async () => {
    container = (await startMongoDb()) as StartedMongoDBContainer;
  });

  afterAll(() => {
    stopMongoDb(container);
  });

  it('Submit commitment and create block', async () => {
    logger.info('Starting aggregator...');
    const aggregator = await AggregatorGateway.create({
      alphabill: { useMock: true },
      storage: {
        uri: container.getConnectionString() + '?directConnection=true',
      },
    });
    logger.info('Aggregator running.');

    const unicitySigningService = new SigningService(HexConverter.decode('1DE87F189C3C9E42F93C90C95E2AC761BE9D0EB2FD1CA0FF3A9CE165C3DE96A9'));
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
    for (let i = 0; i < 5; i++) {
      const blockRecords = await roundManager.getBlockRecordsStorage().getLatest();
      if (blockRecords?.requestIds.find((requestId) => requestId.hash.equals(requestId.hash))) {
        commitmentFound = true;
      }
      if (blockRecords?.requestIds.find((requestId) => requestId.hash.equals(notSubmittedRequestId.hash))) {
        notSubmittedCommitmentFound = true;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    expect(commitmentFound).toBeTruthy();
    expect(notSubmittedCommitmentFound).toBeFalsy();
  });
});
