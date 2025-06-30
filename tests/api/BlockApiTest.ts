import { Authenticator } from '@unicitylabs/commons/lib/api/Authenticator.js';
import { RequestId } from '@unicitylabs/commons/lib/api/RequestId.js';
import { DataHash } from '@unicitylabs/commons/lib/hash/DataHash.js';
import { HashAlgorithm } from '@unicitylabs/commons/lib/hash/HashAlgorithm.js';
import { SigningService } from '@unicitylabs/commons/lib/signing/SigningService.js';

import { AggregatorGateway } from '../../src/AggregatorGateway.js';
import { Commitment } from '../../src/commitment/Commitment.js';
import logger from '../../src/logger.js';
import { clearAllCollections, connectToSharedMongo, createGatewayConfig, disconnectFromSharedMongo, getBlockHeight, getBlock, getBlockCommitments } from '../TestUtils.js';

describe('Block API Endpoints', () => {
  let gateway: AggregatorGateway;
  let mongoUri: string;
  let port: number;

  jest.setTimeout(120000);

  beforeAll(async () => {
    mongoUri = await connectToSharedMongo(false);

    port = 3100 + Math.floor(Math.random() * 900);

    const gatewayConfig = createGatewayConfig(port, 'test-server', mongoUri, {
      highAvailability: {
        enabled: false,
      },
    });
    gateway = await AggregatorGateway.create(gatewayConfig);
    

    // Stop automatic block creation for controlled testing
    (gateway as any).blockCreationActive = false;
    if ((gateway as any).blockCreationTimer) {
      clearTimeout((gateway as any).blockCreationTimer);
      (gateway as any).blockCreationTimer = null;
    }

    logger.info(`Test gateway started on port ${port}`);
  }, 40000);

  afterAll(async () => {
    await gateway.stop();
    await disconnectFromSharedMongo();
  }, 30000);

  beforeEach(async () => {
    await clearAllCollections();
  });

  it('should return current block height 0 when no blocks exist', async () => {
    const response = await getBlockHeight(port, 1);

    expect(response.status).toBe(200);
    expect(response.data).toHaveProperty('jsonrpc', '2.0');
    expect(response.data.result).toHaveProperty('blockNumber', '0');
  });

  it('should return 404 when requesting non-existent block', async () => {
    const response = await getBlock(port, '999', 1);

    expect(response.status).toBe(404);
    expect(response.data).toHaveProperty('jsonrpc', '2.0');
    expect(response.data).toHaveProperty('error');
    expect(response.data.error).toHaveProperty('code', -32001);
    expect(response.data.error).toHaveProperty('message', 'Block 999 not found');
  });

  it('should return 400 when blockNumber is invalid', async () => {
    const response = await getBlock(port, 'not-a-number', 1);

    expect(response.status).toBe(400);
    expect(response.data).toHaveProperty('jsonrpc', '2.0');
    expect(response.data).toHaveProperty('error');
    expect(response.data.error).toHaveProperty('code', -32602);
  });

  it('should return 404 when block commitments are not found', async () => {
    const response = await getBlockCommitments(port, '999', 1);

    expect(response.status).toBe(404);
    expect(response.data).toHaveProperty('jsonrpc', '2.0');
    expect(response.data).toHaveProperty('error');
    expect(response.data.error).toHaveProperty('code', -32001);
    expect(response.data.error).toHaveProperty('message', 'Block 999 not found');
  });

  it('should create and retrieve a block and its commitments', async () => {
    const roundManager = gateway.getRoundManager();
    const signingService = await SigningService.createFromSecret(SigningService.generatePrivateKey());

    const commitments: Commitment[] = [];

    // Create and submit 3 test commitments
    for (let i = 0; i < 3; i++) {
      const stateHash = new DataHash(HashAlgorithm.SHA256, new TextEncoder().encode(`state-${i}`));
      const txHash = new DataHash(HashAlgorithm.SHA256, new TextEncoder().encode(`tx-${i}`));
      const requestId = await RequestId.create(signingService.publicKey, stateHash);

      const authenticator = await Authenticator.create(signingService, txHash, stateHash);

      const commitment = new Commitment(requestId, txHash, authenticator);
      await roundManager.submitCommitment(commitment);
      commitments.push(commitment);
    }

    // Create a block with our commitments
    const block = await roundManager.createBlock();
    logger.info(`Created test block with number ${block.index}`);

    // Get block height - should match the created block
    const heightResponse = await getBlockHeight(port, 1);
    expect(heightResponse.status).toBe(200);
    expect(heightResponse.data.result).toHaveProperty('blockNumber', block.index.toString());

    // Retrieve block by number
    const blockResponse = await getBlock(port, block.index.toString(), 1);
    expect(blockResponse.status).toBe(200);
    expect(blockResponse.data.result).toHaveProperty('index', block.index.toString());
    expect(blockResponse.data.result).toHaveProperty('chainId', block.chainId);
    expect(blockResponse.data.result).toHaveProperty('version', block.version);
    expect(blockResponse.data.result).toHaveProperty('forkId', block.forkId);

    // Retrieve commitments for the block
    const commitmentsResponse = await getBlockCommitments(port, block.index.toString(), 1);
    expect(commitmentsResponse.status).toBe(200);
    
    // Verify result is an array with expected length
    expect(Array.isArray(commitmentsResponse.data.result)).toBe(true);
    if (Array.isArray(commitmentsResponse.data.result)) {
      expect(commitmentsResponse.data.result).toHaveLength(3);

      // Verify the commitments have expected structure
      for (const commitment of commitmentsResponse.data.result) {
        expect(commitment).toHaveProperty('requestId');
        expect(commitment).toHaveProperty('transactionHash');
        expect(commitment).toHaveProperty('authenticator');
      }
    }
  });

  it('should retrieve the latest block using "latest" as block identifier', async () => {
    const roundManager = gateway.getRoundManager();
    const signingService = await SigningService.createFromSecret(SigningService.generatePrivateKey());

    for (let blockIndex = 0; blockIndex < 3; blockIndex++) {
      for (let i = 0; i < 2; i++) {
        const stateHash = new DataHash(
          HashAlgorithm.SHA256,
          new TextEncoder().encode(`block-${blockIndex}-state-${i}`),
        );
        const txHash = new DataHash(HashAlgorithm.SHA256, new TextEncoder().encode(`block-${blockIndex}-tx-${i}`));
        const requestId = await RequestId.create(signingService.publicKey, stateHash);
        const authenticator = await Authenticator.create(signingService, txHash, stateHash);
        const commitment = new Commitment(requestId, txHash, authenticator);
        await roundManager.submitCommitment(commitment);
      }

      await roundManager.createBlock();
    }

    const heightResponse = await getBlockHeight(port, 1);
    expect(heightResponse.status).toBe(200);
    expect(heightResponse.data.result).toHaveProperty('blockNumber', '3');

    const latestBlockResponse = await getBlock(port, 'latest', 1);

    expect(latestBlockResponse.status).toBe(200);
    expect(latestBlockResponse.data).toHaveProperty('jsonrpc', '2.0');

    expect(latestBlockResponse.data.result).toHaveProperty('index', '3');
    expect(latestBlockResponse.data.result).toHaveProperty('chainId');
    expect(latestBlockResponse.data.result).toHaveProperty('version');
    expect(latestBlockResponse.data.result).toHaveProperty('rootHash');
    expect(latestBlockResponse.data.result).toHaveProperty('previousBlockHash');
  });
});
