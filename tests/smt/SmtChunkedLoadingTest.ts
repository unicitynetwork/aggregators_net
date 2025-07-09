import { DataHasherFactory } from '@unicitylabs/commons/lib/hash/DataHasherFactory.js';
import { HashAlgorithm } from '@unicitylabs/commons/lib/hash/HashAlgorithm.js';
import { NodeDataHasher } from '@unicitylabs/commons/lib/hash/NodeDataHasher.js';
import { SparseMerkleTreeBuilder } from '@unicitylabs/commons/lib/smt/SparseMerkleTreeBuilder.js';
import axios from 'axios';

import { AggregatorGateway } from '../../src/AggregatorGateway.js';
import logger from '../../src/logger.js';
import { SmtNode } from '../../src/smt/SmtNode.js';
import { SmtStorage } from '../../src/smt/SmtStorage.js';
import { connectToSharedMongo, disconnectFromSharedMongo, delay, clearAllCollections, createGatewayConfig } from '../TestUtils.js';


describe('SMT Chunked Loading Tests', () => {
  jest.setTimeout(300000);

  let mongoUri: string;
  let gateway: AggregatorGateway;

  beforeAll(async () => {
    mongoUri = await connectToSharedMongo();
  });

  afterAll(async () => {
    if (gateway) {
      await gateway.stop();
    }

    await clearAllCollections();
    await disconnectFromSharedMongo();
  });

  it('should successfully load 10K leaves using chunked loading', async () => {
    const leafCount = 10000;
    const port = 3200 + Math.floor(Math.random() * 100);
    
    logger.info(`Preparing to insert ${leafCount} SMT leaves into storage...`);
    
    const storage = new SmtStorage();
    const testLeaves: SmtNode[] = [];
    const referenceTree = new SparseMerkleTreeBuilder(new DataHasherFactory(HashAlgorithm.SHA256, NodeDataHasher));
    
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
    
    const expectedRootHash = (await referenceTree.calculateRoot()).hash;
    logger.info(`Expected root hash: ${expectedRootHash.toString()}`);
    
    logger.info('Creating AggregatorGateway to test chunked SMT loading...');
    const startTime = Date.now();
    
    const gatewayConfig = createGatewayConfig(port, 'chunked-loading-test', mongoUri, {
      highAvailability: {
        enabled: false,
      },
    }); 
    gateway = await AggregatorGateway.create(gatewayConfig);
    
    
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
    const actualRootHash = roundManager.smt.rootHash;
    
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