import { HashAlgorithm } from '@unicitylabs/commons/lib/hash/HashAlgorithm.js';
import { SparseMerkleTree } from '@unicitylabs/commons/lib/smt/SparseMerkleTree.js';
import { SigningService } from '@unicitylabs/commons/lib/signing/SigningService.js';
import { HexConverter } from '@unicitylabs/commons/lib/util/HexConverter.js';
import axios from 'axios';
import mongoose from 'mongoose';

import { AggregatorGateway } from '../../src/AggregatorGateway.js';
import logger from '../../src/logger.js';
import { SmtNode } from '../../src/smt/SmtNode.js';
import { SmtStorage } from '../../src/smt/SmtStorage.js';
import { IReplicaSet, setupReplicaSet, delay } from '../TestUtils.js';

describe('SMT Chunked Loading Tests', () => {
  jest.setTimeout(300000);

  let replicaSet: IReplicaSet;
  let mongoUri: string;
  let gateway: AggregatorGateway;

  beforeAll(async () => {
    logger.info('=========== STARTING SMT CHUNKED LOADING TEST ===========');
    
    replicaSet = await setupReplicaSet('smt-chunked-test-');
    mongoUri = replicaSet.uri;
    logger.info(`Connecting to MongoDB replica set at ${mongoUri}`);
    await mongoose.connect(mongoUri);
    
    try {
      if (mongoose.connection.db) {
        await mongoose.connection.db.dropDatabase();
        logger.info('Cleaned up existing test database');
      }
    } catch (error) {
      logger.info('No existing test database to clean up');
    }
  });

  beforeEach(async () => {
    try {
      if (mongoose.connection.db) {
        await mongoose.connection.db.dropDatabase();
        logger.info('Cleaned database before test');
      }
    } catch (error) {
      logger.debug('Error cleaning database before test:', error);
    }
  });

  afterAll(async () => {
    logger.info('=========== CLEANING UP SMT CHUNKED LOADING TEST ===========');

    if (gateway) {
      logger.info('Stopping AggregatorGateway...');
      await gateway.stop();
    }

    if (mongoose.connection.readyState !== 0) {
      logger.info('Closing MongoDB connection...');
      await mongoose.connection.close();
    }

    if (replicaSet?.containers) {
      logger.info('Stopping replica set containers...');
      for (const container of replicaSet.containers) {
        await container.stop();
      }
    }

    logger.info('=========== FINISHED SMT CHUNKED LOADING TEST ===========');
  });

  it('should successfully load 10K leaves using chunked loading', async () => {
    const leafCount = 10000;
    const port = 3200 + Math.floor(Math.random() * 100);
    
    logger.info(`Preparing to insert ${leafCount} SMT leaves into storage...`);
    
    const storage = new SmtStorage();
    const testLeaves: SmtNode[] = [];
    const referenceTree = new SparseMerkleTree(HashAlgorithm.SHA256);
    
    for (let i = 0; i < leafCount; i++) {
      const path = BigInt(i + 1000000);
      const value = new Uint8Array([
        (i >> 24) & 0xFF,
        (i >> 16) & 0xFF, 
        (i >> 8) & 0xFF,
        i & 0xFF,
        0x01, 0x02, 0x03
      ]);
      
      const leaf = new SmtNode(path, value);
      testLeaves.push(leaf);
      
      referenceTree.addLeaf(path, value);
      
      if ((i + 1) % 2000 === 0) {
        logger.info(`Generated ${i + 1}/${leafCount} test leaves...`);
      }
    }
    
    logger.info(`Inserting ${leafCount} leaves into storage using batch operations...`);
    const batchSize = 1000;
    for (let i = 0; i < testLeaves.length; i += batchSize) {
      const batch = testLeaves.slice(i, i + batchSize);
      await storage.putBatch(batch);
      
      if ((i + batchSize) % 2000 === 0 || i + batchSize >= testLeaves.length) {
        const inserted = Math.min(i + batchSize, testLeaves.length);
        logger.info(`Inserted ${inserted}/${leafCount} leaves into storage...`);
      }
    }
    
    const expectedRootHash = await referenceTree.root.calculateHash();
    logger.info(`Expected root hash: ${expectedRootHash.toString()}`);
    
    logger.info('Creating AggregatorGateway to test chunked SMT loading...');
    const startTime = Date.now();
    
    gateway = await AggregatorGateway.create({
      aggregatorConfig: {
        port: port,
        serverId: 'chunked-loading-test',
      },
      alphabill: {
        useMock: true,
        privateKey: HexConverter.encode(SigningService.generatePrivateKey()),
      },
      storage: {
        uri: mongoUri,
      },
      highAvailability: {
        enabled: false,
      },
    });
    
    const loadTime = Date.now() - startTime;
    logger.info(`AggregatorGateway created successfully in ${loadTime}ms`);
    
    logger.info('Waiting for gateway to be ready...');
    let isReady = false;
    let attempts = 0;
    const maxAttempts = 30;
    
    while (!isReady && attempts < maxAttempts) {
      try {
        const response = await axios.get(`http://localhost:${port}/health`);
        if (response.status === 200) {
          isReady = true;
          logger.info('Gateway health check successful:', response.data);
        }
      } catch (error) {
        logger.debug(`Health check attempt ${attempts + 1} failed:`, (error as Error).message);
      }
      
      if (!isReady) {
        await delay(1000);
        attempts++;
      }
    }
    
    expect(isReady).toBe(true);
    
    logger.info('Verifying SMT root hash through round manager...');
    
    const roundManager = gateway.getRoundManager();
    const actualRootHash = await roundManager.smt.rootHash();
    
    logger.info(`Actual root hash from gateway: ${actualRootHash.toString()}`);
    logger.info(`Expected root hash: ${expectedRootHash.toString()}`);
    
    expect(actualRootHash.equals(expectedRootHash)).toBe(true);
    logger.info('✅ Root hash verification successful');
    
    logger.info('=== PERFORMANCE METRICS ===');
    logger.info(`Leaves processed: ${leafCount}`);
    logger.info(`Total loading time: ${loadTime}ms`);
    logger.info(`Average time per leaf: ${(loadTime / leafCount).toFixed(4)}ms`);
    logger.info(`Leaves per second: ${(leafCount / (loadTime / 1000)).toFixed(2)}`);
  });
}); 