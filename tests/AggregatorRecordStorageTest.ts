import assert from 'assert';

import { BitString } from '@alphabill/alphabill-js-sdk/lib/codec/cbor/BitString.js';
import { UpdateNonFungibleTokenAttributes } from '@alphabill/alphabill-js-sdk/lib/tokens/attributes/UpdateNonFungibleTokenAttributes.js';
import { ClientMetadata } from '@alphabill/alphabill-js-sdk/lib/transaction/ClientMetadata.js';
import { TypeDataUpdateProofsAuthProof } from '@alphabill/alphabill-js-sdk/lib/transaction/proofs/TypeDataUpdateProofsAuthProof.js';
import { ServerMetadata } from '@alphabill/alphabill-js-sdk/lib/transaction/record/ServerMetadata.js';
import { TransactionProof } from '@alphabill/alphabill-js-sdk/lib/transaction/record/TransactionProof.js';
import { TransactionRecord } from '@alphabill/alphabill-js-sdk/lib/transaction/record/TransactionRecord.js';
import { TransactionRecordWithProof } from '@alphabill/alphabill-js-sdk/lib/transaction/record/TransactionRecordWithProof.js';
import { TransactionStatus } from '@alphabill/alphabill-js-sdk/lib/transaction/record/TransactionStatus.js';
import { StateLock } from '@alphabill/alphabill-js-sdk/lib/transaction/StateLock.js';
import { TransactionOrder } from '@alphabill/alphabill-js-sdk/lib/transaction/TransactionOrder.js';
import { TransactionPayload } from '@alphabill/alphabill-js-sdk/lib/transaction/TransactionPayload.js';
import {
  UnicityCertificate,
  InputRecord,
  ShardTreeCertificate,
  UnicityTreeCertificate,
  UnicitySeal,
} from '@alphabill/alphabill-js-sdk/lib/unit/UnicityCertificate.js';
import { UnitId } from '@alphabill/alphabill-js-sdk/lib/UnitId.js';
import { Authenticator } from '@unicitylabs/commons/lib/api/Authenticator.js';
import { RequestId } from '@unicitylabs/commons/lib/api/RequestId.js';
import { DataHash } from '@unicitylabs/commons/lib/hash/DataHash.js';
import { HashAlgorithm } from '@unicitylabs/commons/lib/hash/HashAlgorithm.js';
import { HexConverter } from '@unicitylabs/commons/lib/util/HexConverter.js';
import { StartedTestContainer } from 'testcontainers';

import { setupTestDatabase, teardownTestDatabase } from './TestUtils.js';
import { AggregatorRecordStorage } from '../src/database/mongo/AggregatorRecordStorage.js';
import { AggregatorRecord } from '../src/records/AggregatorRecord.js';

describe('Aggregator Record Storage Tests', () => {
  jest.setTimeout(60000);

  let container: StartedTestContainer;

  beforeAll(async () => {
    container = (await setupTestDatabase()).container;
  });

  afterAll(async () => {
    await teardownTestDatabase(container);
  });

  it('Store and retrieve record', async () => {
    const storage = new AggregatorRecordStorage();
    const testRequestId = await RequestId.create(
      new Uint8Array([1, 2, 3, 4]),
      new DataHash(HashAlgorithm.SHA256, new Uint8Array([5, 6, 7, 8])),
    );
    console.log('Using requestId:', testRequestId.toString());

    const attributes = new UpdateNonFungibleTokenAttributes({ bytes: new Uint8Array([1, 2, 3]) }, BigInt(1));

    const payload = new TransactionPayload<UpdateNonFungibleTokenAttributes>(
      1,
      1,
      new UnitId(new Uint8Array([0, 0, 0, 0]), new Uint8Array([0, 0, 0, 0])),
      1,
      attributes,
      new StateLock({ bytes: new Uint8Array([1]) }, { bytes: new Uint8Array([1]) }),
      new ClientMetadata(0b11n, 0b11n, null, null),
    );

    const transactionOrder = new TransactionOrder<UpdateNonFungibleTokenAttributes, TypeDataUpdateProofsAuthProof>(
      0b11n,
      payload,
      null,
      new TypeDataUpdateProofsAuthProof(new Uint8Array([0, 0, 0, 0]), [new Uint8Array([0])]),
      null,
    );

    const serverMetadata = new ServerMetadata(
      BigInt(123),
      [],
      TransactionStatus.Successful,
      new Uint8Array([10, 11, 12]),
    );

    const transactionRecord = new TransactionRecord<typeof transactionOrder>(0b11n, transactionOrder, serverMetadata);

    const unicityCertificate = new UnicityCertificate(
      0b11n,
      new InputRecord(0b11n, 0b11n, 0b11n, null, null, new Uint8Array([1]), 0b11n, null, 0b11n),
      null,
      new ShardTreeCertificate(BitString.create(new Uint8Array([1])), [new Uint8Array([1])]),
      new UnicityTreeCertificate(0b11n, 0b11n, new Uint8Array([1]), []),
      new UnicitySeal(0b11n, 0b11n, 0b11n, 0b11n, 0b11n, null, new Uint8Array([1]), new Map()),
    );

    const txProof = new TransactionProof(0b11n, new Uint8Array([1]), [], unicityCertificate);
    const recordWithProof = new TransactionRecordWithProof(transactionRecord, txProof);

    const authenticator = new Authenticator(
      new Uint8Array([1, 2, 3]),
      'ECDSA',
      new Uint8Array([4, 5, 6]),
      new DataHash(HashAlgorithm.SHA256, new Uint8Array([7, 8, 9])),
    );

    const record = new AggregatorRecord(
      1,
      1,
      1,
      1n,
      txProof.unicityCertificate.unicitySeal.timestamp,
      recordWithProof,
      new Uint8Array([5, 6, 7, 8]),
      new DataHash(HashAlgorithm.SHA256, new Uint8Array([1, 2, 3, 4])),
      null,
      authenticator,
    );

    console.log('Storing record...');
    const stored = await storage.put(testRequestId, record);
    console.log('Store result:', stored);

    console.log('Retrieving record...');
    const retrieved = await storage.get(testRequestId);
    expect(retrieved).not.toBeNull();
    assert(retrieved);
    console.log('Retrieved successfully');
    console.log('Data comparison:');
    expect(retrieved.chainId).toEqual(record.chainId);
    expect(retrieved.version).toEqual(record.version);
    expect(retrieved.forkId).toEqual(record.forkId);
    expect(retrieved.index).toEqual(record.index);
    expect(retrieved.timestamp).toEqual(record.timestamp);
    const originalProof = record.txProof;
    const retrievedProof = retrieved.txProof;
    console.log('Transaction proof comparison:');
    expect(originalProof.transactionRecord.transactionOrder.payload.type).toEqual(
      retrievedProof.transactionRecord.transactionOrder.payload.type,
    );
    expect(HexConverter.encode(originalProof.transactionRecord.transactionOrder.payload.attributes.data.bytes)).toEqual(
      HexConverter.encode(retrievedProof.transactionRecord.transactionOrder.payload.attributes.data.bytes),
    );
    if (retrieved.previousBlockHash && record.previousBlockHash) {
      expect(HexConverter.encode(retrieved.previousBlockHash)).toEqual(HexConverter.encode(record.previousBlockHash));
    }
    expect(retrieved.rootHash.equals(record.rootHash)).toBeTruthy();
    if (retrieved.noDeletionProofHash && record.noDeletionProofHash) {
      expect(HexConverter.encode(retrieved.noDeletionProofHash)).toEqual(
        HexConverter.encode(record.noDeletionProofHash),
      );
    }
    expect(HexConverter.encode(retrieved.authenticator.signature)).toEqual(
      HexConverter.encode(record.authenticator.signature),
    );
    expect(HexConverter.encode(retrieved.authenticator.publicKey)).toEqual(
      HexConverter.encode(record.authenticator.publicKey),
    );
    expect(retrieved.authenticator.stateHash.equals(record.authenticator.stateHash)).toBeTruthy();
    expect(retrieved.authenticator.algorithm).toEqual(record.authenticator.algorithm);
  });
});
