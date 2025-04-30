import { Authenticator } from '@unicitylabs/commons/lib/api/Authenticator.js';
import { RequestId } from '@unicitylabs/commons/lib/api/RequestId.js';
import { DataHash } from '@unicitylabs/commons/lib/hash/DataHash.js';
import { HashAlgorithm } from '@unicitylabs/commons/lib/hash/HashAlgorithm.js';
import { SigningService } from '@unicitylabs/commons/lib/signing/SigningService.js';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import request from 'supertest';

import { AggregatorGateway } from '../../src/AggregatorGateway.js';
import { Commitment } from '../../src/commitment/Commitment.js';
import logger from '../../src/logger.js';
import { MockAlphabillClient } from '../../tests/consensus/alphabill/MockAlphabillClient.js';

describe('Block API Endpoints', () => {
  let gateway: AggregatorGateway;
  let mongoServer: MongoMemoryServer;
  let port: number;
  let mockAlphabillClient: MockAlphabillClient;

  jest.setTimeout(30000);

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    const mongoUri = mongoServer.getUri();
    logger.info(`Connecting to in-memory MongoDB at ${mongoUri}`);
    await mongoose.connect(mongoUri);

    port = 3100 + Math.floor(Math.random() * 900);

    mockAlphabillClient = new MockAlphabillClient();

    gateway = await AggregatorGateway.create({
      aggregatorConfig: {
        port: port,
        serverId: 'test-server-id',
      },
      alphabill: {
        useMock: true,
      },
      storage: {
        uri: mongoUri,
      },
      highAvailability: {
        enabled: false,
      },
    });

    // Disable the block creation waiting period for tests
    (AggregatorGateway as any).blockCreationActive = false;

    logger.info(`Test gateway started on port ${port}`);
  }, 20000);

  afterAll(async () => {
    logger.info('Shutting down test gateway and MongoDB');

    await gateway.stop();
    logger.info('Gateway stopped');

    if (mongoose.connection.readyState !== 0) {
      logger.info('Closing mongoose connection...');
      await mongoose.disconnect();
      logger.info('Mongoose connection closed');
    }

    if (mongoServer) {
      logger.info('Stopping MongoDB memory server...');
      await mongoServer.stop();
      logger.info('MongoDB memory server stopped');
    }
  }, 15000);

  beforeEach(async () => {
    // Clear all collections before each test
    if (mongoose.connection.db) {
      const collections = await mongoose.connection.db.collections();
      for (const collection of collections) {
        await collection.deleteMany({});
      }
    }
  });

  async function callJsonRpc(method: string, params: any = {}) {
    const response = await request(`http://localhost:${port}`)
      .post('/')
      .set('Content-Type', 'application/json')
      .set('Accept', 'application/json')
      .send({
        jsonrpc: '2.0',
        method,
        params,
        id: 1,
      });

    // Log response for debugging
    logger.info(`Response for ${method}: ${JSON.stringify(response.body)}`);

    return response;
  }

  it('should return current block height 0 when no blocks exist', async () => {
    const response = await callJsonRpc('get_block_height');

    expect(response.status).toBe(200);
    expect(response.body).toHaveProperty('jsonrpc', '2.0');
    expect(response.body.result).toHaveProperty('blockHeight', '0');
  });

  it('should return 404 when requesting non-existent block', async () => {
    const response = await callJsonRpc('get_block', { blockNumber: '999' });

    expect(response.status).toBe(404);
    expect(response.body).toHaveProperty('jsonrpc', '2.0');
    expect(response.body.error).toHaveProperty('code', -32001);
    expect(response.body.error.message).toBe('Block 999 not found');
  });

  it('should return 400 when blockNumber is invalid', async () => {
    const response = await callJsonRpc('get_block', { blockNumber: 'not-a-number' });

    expect(response.status).toBe(400);
    expect(response.body).toHaveProperty('jsonrpc', '2.0');
    expect(response.body.error).toHaveProperty('code', -32602);
  });

  it('should return 404 when block commitments are not found', async () => {
    const response = await callJsonRpc('get_block_commitments', { blockNumber: '999' });

    expect(response.status).toBe(404);
    expect(response.body).toHaveProperty('jsonrpc', '2.0');
    expect(response.body.error).toHaveProperty('code', -32001);
    expect(response.body.error.message).toBe('Block 999 not found');
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

    // Get block height - should be 1 now
    const heightResponse = await callJsonRpc('get_block_height');
    expect(heightResponse.status).toBe(200);
    expect(heightResponse.body.result.blockHeight).toBe('1');

    // Retrieve block by number
    const blockResponse = await callJsonRpc('get_block', { blockNumber: block.index.toString() });
    expect(blockResponse.status).toBe(200);
    expect(blockResponse.body.result).toHaveProperty('index', block.index.toString());
    expect(blockResponse.body.result).toHaveProperty('chainId', block.chainId);
    expect(blockResponse.body.result).toHaveProperty('version', block.version);
    expect(blockResponse.body.result).toHaveProperty('forkId', block.forkId);

    // Retrieve commitments for the block
    const commitmentsResponse = await callJsonRpc('get_block_commitments', { blockNumber: block.index.toString() });
    expect(commitmentsResponse.status).toBe(200);
    expect(commitmentsResponse.body.result).toBeInstanceOf(Array);
    expect(commitmentsResponse.body.result).toHaveLength(3);

    // Verify the commitments have expected structure
    for (const commitment of commitmentsResponse.body.result) {
      expect(commitment).toHaveProperty('requestId');
      expect(commitment).toHaveProperty('transactionHash');
      expect(commitment).toHaveProperty('authenticator');
    }
  });
});
