import { SmtStorage } from '../src/database/mongo/SmtStorage.js';
import { SmtNode } from '../src/smt/SmtNode.js';
import { setupTestDatabase, teardownTestDatabase } from '../src/database/mongo/tests/TestUtils.js';

async function testStorage() {
    const { container } = await setupTestDatabase();

    try {
        const storage = new SmtStorage();

        const testNodes = [
            new SmtNode(BigInt(1), new Uint8Array([1, 2, 3])),
            new SmtNode(BigInt(2), new Uint8Array([4, 5, 6])),
            // Max 256-bit value: 2^256 - 1
            new SmtNode(2n ** 256n - 1n, new Uint8Array([7, 8, 9]))
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
            const stored = retrieved.find(n => n.path === original.path);
            
            if (stored) {
                console.log(`Node ${original.path}:`);
                console.log('Path matches:', stored.path === original.path);
                console.log('Value matches:', 
                    Buffer.compare(stored.value, original.value) === 0);
            } else {
                console.log(`Node ${original.path} not found!`);
            }
        }

    } catch (error) {
        console.error('Test failed:', error);
        if (error instanceof Error) {
            console.error('Error stack:', error.stack);
        }
        throw error;
    } finally {
        await teardownTestDatabase(container);
    }
}

testStorage().catch(error => {
    console.error('Test failed:', error);
    process.exit(1);
});