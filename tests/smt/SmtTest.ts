import { DataHasherFactory } from '@unicitylabs/commons/lib/hash/DataHasherFactory.js';
import { HashAlgorithm } from '@unicitylabs/commons/lib/hash/HashAlgorithm.js';
import { NodeDataHasher } from '@unicitylabs/commons/lib/hash/NodeDataHasher.js';
import { SparseMerkleTree } from '@unicitylabs/commons/lib/smt/SparseMerkleTree.js';

import logger from '../../src/logger.js';
import { Smt } from '../../src/smt/Smt.js';
import { delay } from '../TestUtils.js';

describe('SMT Wrapper Tests', () => {
  jest.setTimeout(30000);

  let smt: SparseMerkleTree;
  let smtWrapper: Smt;

  beforeEach(async () => {
    smt = new SparseMerkleTree(new DataHasherFactory(HashAlgorithm.SHA256, NodeDataHasher));
    smtWrapper = await Smt.create(smt);
  });

  const createAddLeafOperation =
    (id: number, duration: number) => async (): Promise<{ id: number; status: string }> => {
      try {
        const startTime = Date.now();
        logger.info(`Operation ${id}: Starting addLeaf (with ${duration}ms simulated processing)`);

        const path = BigInt(1000 + id);
        const value = new Uint8Array([id % 256, (id * 2) % 256]);

        await smtWrapper.withSmtLock(async () => {
          await delay(duration);
          await smt.addLeaf(path, value);
        });

        const totalTime = Date.now() - startTime;
        logger.info(`Operation ${id}: Completed addLeaf in ${totalTime}ms`);

        return { id, status: 'success' };
      } catch (error) {
        logger.error(`Operation ${id}: Failed:`, error);
        return { id, status: 'error' };
      }
    };

  const createReadOperation = (id: number, duration: number) => async (): Promise<{ id: number; status: string }> => {
    try {
      const startTime = Date.now();
      logger.info(`Operation ${id}: Starting read (with ${duration}ms simulated processing)`);

      const path = BigInt(id);

      await smtWrapper.withSmtLock(async () => {
        await delay(duration);
        return smt.calculateRoot().then((root) => root.getPath(path));
      });

      const totalTime = Date.now() - startTime;
      logger.info(`Operation ${id}: Completed read in ${totalTime}ms`);

      return { id, status: 'success' };
    } catch (error) {
      logger.error(`Operation ${id}: Failed:`, error);
      return { id, status: 'error' };
    }
  };

  it('should properly lock during concurrent operations', async () => {
    const operations = [
      createAddLeafOperation(1, 300),
      createReadOperation(2, 100),
      createAddLeafOperation(3, 500),
      createReadOperation(4, 200),
      createAddLeafOperation(5, 150),
    ];

    const startTime = Date.now();
    const results = await Promise.all(operations.map((op) => op()));
    const totalTime = Date.now() - startTime;

    logger.info(`All operations completed in ${totalTime}ms`);
    logger.info('Results:', results);

    expect(results.every((r) => r.status === 'success')).toBe(true);

    const sumOfOperationTimes = 300 + 100 + 500 + 200 + 150;
    expect(totalTime).toBeGreaterThanOrEqual(sumOfOperationTimes);

    expect(smtWrapper.rootHash).toBeDefined();
  });

  it('should execute operations in FIFO order when waiting for lock', async () => {
    const executionOrder: number[] = [];

    const createTrackedOperation = (id: number, duration: number) => async (): Promise<void> => {
      await smtWrapper.withSmtLock(async () => {
        executionOrder.push(id);
        await delay(duration);
      });
    };

    const longOperation = createTrackedOperation(1, 500);
    const longOperationPromise = longOperation();

    await delay(50);

    const op2Promise = createTrackedOperation(2, 50)();
    const op3Promise = createTrackedOperation(3, 50)();
    const op4Promise = createTrackedOperation(4, 50)();

    await Promise.all([longOperationPromise, op2Promise, op3Promise, op4Promise]);

    expect(executionOrder).toEqual([1, 2, 3, 4]);
  });

  it('should timeout if lock acquisition takes too long', async () => {
    Object.defineProperty(smtWrapper, 'LOCK_TIMEOUT_MS', { value: 100 });

    const longOperation = async (): Promise<void> => {
      await smtWrapper.withSmtLock(async () => {
        await delay(1000);
      });
    };

    const longOperationPromise = longOperation();
    await delay(50);

    try {
      await smtWrapper.withSmtLock(() => {
        fail('Should not reach this point');
      });
      fail('Expected lock acquisition to timeout');
    } catch (error) {
      expect((error as Error).message).toContain('lock acquisition timed out');
    }

    await longOperationPromise;
  });

  it('should process batch addLeaves atomically', async () => {
    const leavesToAdd = [
      { path: BigInt(1), value: new Uint8Array([1]) },
      { path: BigInt(2), value: new Uint8Array([2]) },
    ];

    await smtWrapper.addLeaves(leavesToAdd);
    const readRootDuringAdd = smtWrapper.rootHash;

    const tempSmt = new SparseMerkleTree(new DataHasherFactory(HashAlgorithm.SHA256, NodeDataHasher));
    await Promise.all([
      tempSmt.addLeaf(BigInt(1), new Uint8Array([1])),
      tempSmt.addLeaf(BigInt(2), new Uint8Array([2])),
    ]);
    const expectedRoot = await tempSmt.calculateRoot();

    expect(readRootDuringAdd).toBeDefined();
    expect(readRootDuringAdd!.equals(expectedRoot.hash)).toBe(true);
    expect(smtWrapper.rootHash.equals(expectedRoot.hash)).toBe(true);
  });

  it('should skip duplicate leaves when using addLeaves batch function', async () => {
    // Add initial leaf directly
    const path = BigInt(42);
    const value = new Uint8Array([1, 2, 3]);

    await smtWrapper.addLeaf(path, value);
    const rootAfterFirstAdd = smtWrapper.rootHash;

    // Adding the same leaf with addLeaf should throw an error
    try {
      await smtWrapper.addLeaf(path, value);
      fail('Expected error when adding duplicate leaf with addLeaf');
    } catch (error) {
      expect((error as Error).message).toContain('Cannot add leaf inside branch');
    }

    // Root should remain unchanged after error
    expect(smtWrapper.rootHash.equals(rootAfterFirstAdd)).toBe(true);

    // Now add a batch containing the duplicate leaf and a new leaf
    const newPath = BigInt(43);
    const newValue = new Uint8Array([4, 5, 6]);

    // This should succeed, skipping the duplicate but adding the new leaf
    await smtWrapper.addLeaves([
      { path, value },
      { path: newPath, value: newValue },
    ]);

    // Root should change after adding the new leaf (duplicate was skipped)
    const rootAfterBatchAdd = smtWrapper.rootHash;
    expect(rootAfterBatchAdd.equals(rootAfterFirstAdd)).toBe(false);

    // Verify both leaves exist by getting their paths
    const path1 = await smtWrapper.getPath(path);
    const path2 = await smtWrapper.getPath(newPath);

    expect(path1).toBeDefined();
    expect(path2).toBeDefined();
  });
});
