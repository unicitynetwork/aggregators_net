import { HexConverter } from '@unicitylabs/commons/lib/util/HexConverter.js';
import { StartedTestContainer } from 'testcontainers';
import { SparseMerkleTree } from '@unicitylabs/commons/lib/smt/SparseMerkleTree.js';
import { HashAlgorithm } from '@unicitylabs/commons/lib/hash/HashAlgorithm.js';

import logger from '../../src/logger.js';
import { SmtNode } from '../../src/smt/SmtNode.js';
import { SmtStorage, LeafModel } from '../../src/smt/SmtStorage.js';
import { startMongoDb, stopMongoDb } from '../TestContainers.js';

describe('SMT Storage Tests', () => {
  jest.setTimeout(60000);

  let container: StartedTestContainer;

  beforeAll(async () => {
    container = await startMongoDb();
  });

  afterAll(() => {
    stopMongoDb(container);
  });

  it('Store and retrieve nodes', async () => {
    const storage = new SmtStorage();

    const testNodes = [
      new SmtNode(BigInt(1), new Uint8Array([1, 2, 3])),
      new SmtNode(BigInt(2), new Uint8Array([4, 5, 6])),
      // Max 256-bit value: 2^256 - 1
      new SmtNode(2n ** 256n - 1n, new Uint8Array([7, 8, 9])),
    ];

    logger.info('Storing test nodes...');
    for (const node of testNodes) {
      logger.info(`Storing node with path ${node.path} (hex: ${node.path.toString(16)})`);
      const result = await storage.put(node);
      logger.info(`Store result: ${result}`);
    }

    logger.info('Retrieving all nodes...');
    const retrieved = await storage.getAll();
    logger.info(`Retrieved ${retrieved.length} nodes`);

    logger.info('Data comparison:');
    for (let i = 0; i < testNodes.length; i++) {
      const original = testNodes[i];
      const stored = retrieved.find((n) => n.path === original.path);

      if (stored) {
        logger.info(`Node ${original.path}:`);
        expect(stored.path).toEqual(original.path);
        expect(HexConverter.encode(stored.value)).toEqual(HexConverter.encode(original.value));
      } else {
        logger.info(`Node ${original.path} not found!`);
      }
    }
  });

  it('Store and retrieve nodes in batch', async () => {
    await LeafModel.deleteMany({});

    const storage = new SmtStorage();

    const batchTestNodes: SmtNode[] = [];
    for (let i = 0; i < 10; i++) {
      const path = BigInt(1000 + i);
      const value = new Uint8Array([i % 256, (i * 2) % 256, (i * 3) % 256]);
      batchTestNodes.push(new SmtNode(path, value));
    }

    logger.info('Storing test nodes in batch...');
    const result = await storage.putBatch(batchTestNodes);
    expect(result).toBe(true);

    logger.info('Retrieving all nodes...');
    const retrieved = await storage.getAll();
    logger.info(`Retrieved ${retrieved.length} nodes`);

    for (const original of batchTestNodes) {
      const stored = retrieved.find((n) => n.path === original.path);
      expect(stored).toBeDefined();
      expect(stored?.path).toEqual(original.path);
      expect(HexConverter.encode(stored!.value)).toEqual(HexConverter.encode(original.value));
    }
  });

  it('Try to store the same batch of SMT nodes twice', async () => {
    // Clear the collection first
    await LeafModel.deleteMany({});
    
    const storage = new SmtStorage();
    
    // Create test nodes
    const testNodes: SmtNode[] = [];
    for (let i = 0; i < 3; i++) {
      const path = BigInt(2000 + i);
      const value = new Uint8Array([10 + i, 20 + i, 30 + i]);
      testNodes.push(new SmtNode(path, value));
    }
    
    // First insertion should succeed
    logger.info('\nFirst batch insertion of SMT nodes...');
    const firstResult = await storage.putBatch(testNodes);
    expect(firstResult).toBe(true);
    
    // Save original values to verify they don't change
    const originalNodes = testNodes.map(node => ({
      path: node.path,
      value: new Uint8Array(node.value)
    }));
    
    // Second insertion of the same batch should succeed but won't modify the nodes
    logger.info('\nSecond batch insertion of same SMT nodes...');
    const secondResult = await storage.putBatch(testNodes);
    expect(secondResult).toBe(true);
    
    // Now try with modified values for the same paths
    const modifiedNodes: SmtNode[] = [];
    for (let i = 0; i < 3; i++) {
      const path = BigInt(2000 + i);
      // Different values
      const value = new Uint8Array([50 + i, 60 + i, 70 + i]);
      modifiedNodes.push(new SmtNode(path, value));
    }
    
    // This should succeed but won't update the existing nodes due to $setOnInsert
    logger.info('\nThird batch insertion (same paths, new values)...');
    const thirdResult = await storage.putBatch(modifiedNodes);
    expect(thirdResult).toBe(true);
    
    // Verify the nodes still have their original values
    const allNodes = await storage.getAll();
    for (const original of originalNodes) {
      const retrieved = allNodes.find(n => n.path === original.path);
      expect(retrieved).toBeDefined();
      expect(retrieved!.path).toEqual(original.path);
      // Should still match the original values, not the modified ones
      expect(HexConverter.encode(retrieved!.value)).toEqual(HexConverter.encode(original.value));
    }
    
    // Add a new node with a completely new path - this should be inserted
    const newNode = new SmtNode(BigInt(9999), new Uint8Array([99, 99, 99]));
    
    const mixedBatch = [...modifiedNodes, newNode];
    logger.info('\nFourth batch insertion (mix of existing and new nodes)...');
    const fourthResult = await storage.putBatch(mixedBatch);
    expect(fourthResult).toBe(true);
    
    // Get updated list of all nodes after the fourth insertion
    const updatedNodes = await storage.getAll();
    
    // Verify the new node was inserted
    const retrievedNew = updatedNodes.find(n => n.path === newNode.path);
    expect(retrievedNew).toBeDefined();
    if (retrievedNew) {
      expect(retrievedNew.path).toEqual(newNode.path);
      expect(HexConverter.encode(retrievedNew.value)).toEqual(HexConverter.encode(newNode.value));
    }
    
    // Count total nodes - should be 4 (original 3 + new 1)
    expect(updatedNodes.length).toBe(4);
  });

  it('Try adding the same leaf to SMT tree twice', async () => {
    const smt = await SparseMerkleTree.create(HashAlgorithm.SHA256);
    
    // Create a test leaf
    const path = BigInt(12345);
    const value = new Uint8Array([1, 2, 3, 4, 5]);
    
    // Add the leaf the first time
    await smt.addLeaf(path, value);
    const rootHashAfterFirstAddition = smt.rootHash;
    logger.info(`Root hash after first addition: ${rootHashAfterFirstAddition.toString()}`);
    
    // Try to add the same leaf again - this should throw an error
    // with message "Cannot add leaf inside branch"
    try {
      await smt.addLeaf(path, value);
      // If we get here, the test should fail because we expect an error
      expect(false).toBe(true); // This will fail if no error is thrown
    } catch (error) {
      logger.info('Got expected error when adding the same leaf twice:', error);
      // We expect an error with this specific message
      expect((error as Error).message).toContain('Cannot add leaf inside branch');
    }
    
    // Try adding a different path but same value - this should work
    const differentPath = BigInt(54321);
    try {
      await smt.addLeaf(differentPath, value);
      logger.info('Successfully added leaf with same value but different path');
    } catch (error) {
      logger.error('Unexpected error when adding leaf with same value but different path:', error);
      expect(error).toBeUndefined(); // This will fail if an error is thrown
    }
  });
});
