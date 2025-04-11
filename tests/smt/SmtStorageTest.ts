import { HexConverter } from '@unicitylabs/commons/lib/util/HexConverter.js';
import { StartedTestContainer } from 'testcontainers';

import { SmtNode } from '../../src/smt/SmtNode.js';
import { SmtStorage } from '../../src/smt/SmtStorage.js';
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

    console.log('\nStoring test nodes...');
    for (const node of testNodes) {
      console.log(`Storing node with path ${node.path} (hex: ${node.path.toString(16)})`);
      const result = await storage.put(node);
      console.log(`Store result: ${result}`);
    }

    console.log('\nRetrieving all nodes...');
    const retrieved = await storage.getAll();
    console.log(`Retrieved ${retrieved.length} nodes`);

    console.log('\nData comparison:');
    for (let i = 0; i < testNodes.length; i++) {
      const original = testNodes[i];
      const stored = retrieved.find((n) => n.path === original.path);

      if (stored) {
        console.log(`Node ${original.path}:`);
        expect(stored.path).toEqual(original.path);
        expect(HexConverter.encode(stored.value)).toEqual(HexConverter.encode(original.value));
      } else {
        console.log(`Node ${original.path} not found!`);
      }
    }
  });
});
