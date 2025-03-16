import { GenericContainer } from 'testcontainers';
import mongoose from 'mongoose';
import { AggregatorRecordStorage } from './../AggregatorRecordStorage.js';
import { AggregatorRecord } from '../../../records/AggregatorRecord.js';
import { TransactionOrder } from "@alphabill/alphabill-js-sdk/lib/transaction/TransactionOrder.js";
import { TransactionRecordWithProof } from '@alphabill/alphabill-js-sdk/lib/transaction/record/TransactionRecordWithProof.js';
import { TransactionRecord } from '@alphabill/alphabill-js-sdk/lib/transaction/record/TransactionRecord.js';
import { TransactionProof } from '@alphabill/alphabill-js-sdk/lib/transaction/record/TransactionProof.js';
import { UnicityCertificate, InputRecord, ShardTreeCertificate, UnicityTreeCertificate, UnicitySeal } from '@alphabill/alphabill-js-sdk/lib/unit/UnicityCertificate.js';
import { BitString } from '@alphabill/alphabill-js-sdk/lib/codec/cbor/BitString.js';
import { UpdateNonFungibleTokenAttributes } from '@alphabill/alphabill-js-sdk/lib/tokens/attributes/UpdateNonFungibleTokenAttributes.js';
import { TypeDataUpdateProofsAuthProof } from '@alphabill/alphabill-js-sdk/lib/transaction/proofs/TypeDataUpdateProofsAuthProof.js';
import { Authenticator } from '@unicitylabs/commons/lib/api/Authenticator';
import { TransactionStatus } from '@alphabill/alphabill-js-sdk/lib/transaction/record/TransactionStatus.js';
import { ServerMetadata } from '@alphabill/alphabill-js-sdk/lib/transaction/record/ServerMetadata.js';
import { UnitId } from "@alphabill/alphabill-js-sdk/lib/UnitId.js";
import { TransactionPayload } from "@alphabill/alphabill-js-sdk/lib/transaction/TransactionPayload.js";
import { StateLock } from "@alphabill/alphabill-js-sdk/lib/transaction/StateLock.js";
import { ClientMetadata } from "@alphabill/alphabill-js-sdk/lib/transaction/ClientMetadata.js";
import { setupTestDatabase, teardownTestDatabase } from './TestUtils.js';

async function testStorage() {
    const { container } = await setupTestDatabase();

    try {
        const storage = new AggregatorRecordStorage();
        const testRequestId = BigInt('0x' + Math.floor(Math.random() * 1000000).toString(16));
        console.log('Using requestId:', testRequestId.toString(16));

        const attributes = new UpdateNonFungibleTokenAttributes(
            { bytes: new Uint8Array([1, 2, 3]) },
            BigInt(1)
        );

        const payload = new TransactionPayload<UpdateNonFungibleTokenAttributes>(
            1, 1, new UnitId(new Uint8Array([0, 0, 0, 0]), new Uint8Array([0, 0, 0, 0])),
            1, attributes,
            new StateLock({ bytes: new Uint8Array([1]) }, { bytes: new Uint8Array([1]) }),
            new ClientMetadata(0b11n, 0b11n, null, null)
        );

        const transactionOrder = new TransactionOrder<UpdateNonFungibleTokenAttributes, TypeDataUpdateProofsAuthProof>(
            0b11n,
            payload,
            null,
            new TypeDataUpdateProofsAuthProof(new Uint8Array([0, 0, 0, 0]), [new Uint8Array([0])]),
            null
        );

        const serverMetadata = new ServerMetadata(
            BigInt(123),
            [],
            TransactionStatus.Successful,
            new Uint8Array([10, 11, 12])
        );

        const transactionRecord = new TransactionRecord<typeof transactionOrder>(
            0b11n,
            transactionOrder,
            serverMetadata
        );

        const unicityCertificate = new UnicityCertificate(
            0b11n,
            new InputRecord(0b11n, 0b11n, 0b11n, null, null, new Uint8Array([1]), 0b11n, null, 0b11n),
            null,
            new ShardTreeCertificate(BitString.create(new Uint8Array([1])), [new Uint8Array([1])]),
            new UnicityTreeCertificate(0b11n, 0b11n, new Uint8Array([1]), []),
            new UnicitySeal(0b11n, 0b11n, 0b11n, 0b11n, 0b11n, null, new Uint8Array([1]), new Map())
        );

        const txProof = new TransactionProof(0b11n, new Uint8Array([1]), [], unicityCertificate);
        const recordWithProof = new TransactionRecordWithProof(transactionRecord, txProof);

        const authenticator = new Authenticator(
            'SHA-256',
            new Uint8Array([1, 2, 3]),
            'ECDSA',
            new Uint8Array([4, 5, 6]),
            new Uint8Array([7, 8, 9])
        );

        const record = new AggregatorRecord(
            new Uint8Array([1, 2, 3, 4]),
            new Uint8Array([5, 6, 7, 8]),
            authenticator,
            recordWithProof
        );

        console.log('Storing record...');
        const stored = await storage.put(testRequestId, record);
        console.log('Store result:', stored);

        console.log('Retrieving record...');
        const retrieved = await storage.get(testRequestId);
        
        if (retrieved) {
            console.log('Retrieved successfully');
            console.log('Data comparison:');
            console.log('Root hash matches:', Buffer.compare(retrieved.rootHash, record.rootHash) === 0);
            console.log('Previous block data matches:', 
                retrieved.previousBlockData && record.previousBlockData && 
                Buffer.compare(retrieved.previousBlockData, record.previousBlockData) === 0
            );
            console.log('Auth signature matches:', Buffer.compare(retrieved.authenticator.signature, record.authenticator.signature) === 0);
            console.log('Auth public key matches:', Buffer.compare(retrieved.authenticator.publicKey, record.authenticator.publicKey) === 0);
            console.log('Auth state matches:', Buffer.compare(retrieved.authenticator.state, record.authenticator.state) === 0);
            console.log('Auth algorithm matches:', retrieved.authenticator.algorithm === record.authenticator.algorithm);
            console.log('Auth hash algorithm matches:', retrieved.authenticator.hashAlgorithm === record.authenticator.hashAlgorithm);
        } else {
            console.log('Failed to retrieve record');
        }

        console.log('\nTesting non-existent record retrieval...');
        const nonExistent = await storage.get(BigInt('0x999999'));
        console.log('Non-existent record result:', nonExistent === null ? 'null (correct)' : 'not null (wrong)');

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