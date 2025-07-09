import { performance } from 'perf_hooks';

import { RequestId } from '@unicitylabs/commons/lib/api/RequestId.js';
import { DataHash } from '@unicitylabs/commons/lib/hash/DataHash.js';
import { HashAlgorithm } from '@unicitylabs/commons/lib/hash/HashAlgorithm.js';
import { v4 as uuidv4 } from 'uuid';

import logger from '../../src/logger.js';
import { SparseMerkleTreeBuilder } from '@unicitylabs/commons/lib/smt/SparseMerkleTreeBuilder.js';
import { NodeDataHasher } from '@unicitylabs/commons/lib/hash/NodeDataHasher.js';
import { DataHasherFactory } from '@unicitylabs/commons/lib/hash/DataHasherFactory.js';

interface ISmtBenchmarkResult {
  testDescription: string;
  treeSize: number;
  operationCount: number;
  totalTimeMs: number;
  operationsPerSecond: number;
  averageTimePerOpMs: number;
}

describe('Sparse Merkle Tree Performance Benchmarks', () => {
  jest.setTimeout(600000);

  function generateUniqueRequestId(index: number): Promise<RequestId> {
    const idStr = `state-${index}-${uuidv4()}`;
    const stateHashBytes = new TextEncoder().encode(idStr);
    const stateHash = new DataHash(HashAlgorithm.SHA256, stateHashBytes);

    return RequestId.create(new Uint8Array(32), stateHash);
  }

  function generateHashValue(index: number): Uint8Array {
    const txStr = `tx-${index}-${uuidv4()}`;
    return new TextEncoder().encode(txStr);
  }

  async function runSmtBenchmark(
    existingTreeSize: number,
    newOperationsCount: number,
    description: string,
  ): Promise<ISmtBenchmarkResult> {
    logger.info(`Running benchmark: ${description}`);
    logger.info(`Pre-populating tree with ${existingTreeSize} leaves...`);

    const smt = new SparseMerkleTreeBuilder(new DataHasherFactory(HashAlgorithm.SHA256, NodeDataHasher));

    // Pre-populate the tree with existingTreeSize leaves
    for (let i = 0; i < existingTreeSize; i++) {
      const requestId = await generateUniqueRequestId(i);
      const value = generateHashValue(i);
      const path = requestId.toBitString().toBigInt();

      await smt.addLeaf(path, value);

      // Log progress for large trees
      if (i > 0 && i % 10000 === 0) {
        logger.info(`  Added ${i} leaves to the tree...`);
      }
    }
    await smt.calculateRoot();

    logger.info(`Tree populated with ${existingTreeSize} leaves. Starting benchmark...`);

    // Generate new leaves for the benchmark
    const newLeaves: { path: bigint; value: Uint8Array }[] = [];
    for (let i = 0; i < newOperationsCount; i++) {
      const requestId = await generateUniqueRequestId(existingTreeSize + i);
      const value = generateHashValue(existingTreeSize + i);
      newLeaves.push({ path: requestId.toBitString().toBigInt(), value });
    }

    logger.info(`Adding ${newOperationsCount} new leaves...`);
    const startTime = performance.now();

    for (const leaf of newLeaves) {
      await smt.addLeaf(leaf.path, leaf.value);
    }
    await smt.calculateRoot();

    const totalTime = performance.now() - startTime;
    const operationsPerSecond = (newOperationsCount / totalTime) * 1000;

    const result: ISmtBenchmarkResult = {
      testDescription: description,
      treeSize: existingTreeSize + newOperationsCount,
      operationCount: newOperationsCount,
      totalTimeMs: totalTime,
      operationsPerSecond: operationsPerSecond,
      averageTimePerOpMs: totalTime / newOperationsCount,
    };

    printResults(result);
    return result;
  }

  function printResults(result: ISmtBenchmarkResult): void {
    logger.info('----- SMT Benchmark Results -----');
    logger.info(`Test: ${result.testDescription}`);
    logger.info(`Final tree size: ${result.treeSize} leaves`);
    logger.info(`Operations: Added ${result.operationCount} new leaves`);
    logger.info(`Total time: ${result.totalTimeMs.toFixed(2)}ms`);
    logger.info(`Operations per second: ${result.operationsPerSecond.toFixed(2)}`);
    logger.info(`Average time per operation: ${result.averageTimePerOpMs.toFixed(4)}ms`);
    logger.info('---------------------------');
  }

  test('SMT with empty tree and 1,000 operations', async () => {
    const result = await runSmtBenchmark(0, 1000, 'Empty tree + 1,000 operations');
    expect(result.totalTimeMs).toBeGreaterThan(0);
  }, 60000);

  test('SMT with 1,000 existing leaves and 1,000 operations', async () => {
    const result = await runSmtBenchmark(1000, 1000, '1K tree + 1,000 operations');
    expect(result.totalTimeMs).toBeGreaterThan(0);
  }, 60000);

  test('SMT with 10,000 existing leaves and 1,000 operations', async () => {
    const result = await runSmtBenchmark(10000, 1000, '10K tree + 1,000 operations');
    expect(result.totalTimeMs).toBeGreaterThan(0);
  }, 120000);

  test('SMT with 100,000 existing leaves and 1,000 operations', async () => {
    const result = await runSmtBenchmark(100000, 1000, '100K tree + 1,000 operations');
    expect(result.totalTimeMs).toBeGreaterThan(0);
  }, 300000);
});
