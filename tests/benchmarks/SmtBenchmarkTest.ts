import { performance } from 'perf_hooks';
import { v4 as uuidv4 } from 'uuid';
import { SparseMerkleTree } from '@unicitylabs/commons/lib/smt/SparseMerkleTree.js';
import { HashAlgorithm } from '@unicitylabs/commons/lib/hash/HashAlgorithm.js';
import { DataHash } from '@unicitylabs/commons/lib/hash/DataHash.js';
import { RequestId } from '@unicitylabs/commons/lib/api/RequestId.js';

interface SmtBenchmarkResult {
  testDescription: string;
  treeSize: number;
  operationCount: number;
  totalTimeMs: number;
  operationsPerSecond: number;
  averageTimePerOpMs: number;
}

describe('Sparse Merkle Tree Performance Benchmarks', () => {
  jest.setTimeout(600000);
  
  async function generateUniqueRequestId(index: number): Promise<RequestId> {
    const idStr = `state-${index}-${uuidv4()}`;
    const stateHashBytes = new TextEncoder().encode(idStr);
    const stateHash = new DataHash(HashAlgorithm.SHA256, stateHashBytes);
    
    return RequestId.create(
      new Uint8Array(32),
      stateHash
    );
  }
  
  function generateHashValue(index: number): Uint8Array {
    const txStr = `tx-${index}-${uuidv4()}`;
    return new TextEncoder().encode(txStr);
  }
  
  async function runSmtBenchmark(
    existingTreeSize: number,
    newOperationsCount: number,
    description: string
  ): Promise<SmtBenchmarkResult> {
    console.log(`\nRunning benchmark: ${description}`);
    console.log(`Pre-populating tree with ${existingTreeSize} leaves...`);
    
    const smt = await SparseMerkleTree.create(HashAlgorithm.SHA256);
    
    // Pre-populate the tree with existingTreeSize leaves
    for (let i = 0; i < existingTreeSize; i++) {
      const requestId = await generateUniqueRequestId(i);
      const value = generateHashValue(i);
      const path = requestId.toBigInt();
      
      await smt.addLeaf(path, value);
      
      // Log progress for large trees
      if (i > 0 && i % 10000 === 0) {
        console.log(`  Added ${i} leaves to the tree...`);
      }
    }
    
    console.log(`Tree populated with ${existingTreeSize} leaves. Starting benchmark...`);
    
    // Generate new leaves for the benchmark
    const newLeaves: { path: bigint, value: Uint8Array }[] = [];
    for (let i = 0; i < newOperationsCount; i++) {
      const requestId = await generateUniqueRequestId(existingTreeSize + i);
      const value = generateHashValue(existingTreeSize + i);
      newLeaves.push({ path: requestId.toBigInt(), value });
    }
    
    console.log(`Adding ${newOperationsCount} new leaves...`);
    const startTime = performance.now();
    
    for (const leaf of newLeaves) {
      await smt.addLeaf(leaf.path, leaf.value);
    }
    
    const totalTime = performance.now() - startTime;
    const operationsPerSecond = (newOperationsCount / totalTime) * 1000;
    
    const result: SmtBenchmarkResult = {
      testDescription: description,
      treeSize: existingTreeSize + newOperationsCount,
      operationCount: newOperationsCount,
      totalTimeMs: totalTime,
      operationsPerSecond: operationsPerSecond,
      averageTimePerOpMs: totalTime / newOperationsCount
    };
    
    printResults(result);
    return result;
  }
  
  function printResults(result: SmtBenchmarkResult): void {
    console.log('\n----- SMT Benchmark Results -----');
    console.log(`Test: ${result.testDescription}`);
    console.log(`Final tree size: ${result.treeSize} leaves`);
    console.log(`Operations: Added ${result.operationCount} new leaves`);
    console.log(`Total time: ${result.totalTimeMs.toFixed(2)}ms`);
    console.log(`Operations per second: ${result.operationsPerSecond.toFixed(2)}`);
    console.log(`Average time per operation: ${result.averageTimePerOpMs.toFixed(4)}ms`);
    console.log('---------------------------\n');
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