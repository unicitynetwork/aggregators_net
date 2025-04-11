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
import { DataHash } from '@unicitylabs/commons/lib/hash/DataHash.js';
import { HashAlgorithm } from '@unicitylabs/commons/lib/hash/HashAlgorithm.js';
import { HexConverter } from '@unicitylabs/commons/lib/util/HexConverter.js';
import { StartedTestContainer } from 'testcontainers';

import { Block } from '../../src/hashchain/Block.js';
import { BlockStorage } from '../../src/hashchain/BlockStorage.js';
import { startMongoDb, stopMongoDb } from '../TestContainers.js';

describe('Block Storage Tests', () => {
  jest.setTimeout(60000);

  let container: StartedTestContainer;

  beforeAll(async () => {
    container = await startMongoDb();
  });

  afterAll(() => {
    stopMongoDb(container);
  });

  it('Store and retrieve block', async () => {
    const storage = new BlockStorage();
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
      new InputRecord(0b11n, 0b11n, 0b11n, null, null, new Uint8Array([1]), 0b11n, null, 0b11n, null),
      null,
      new ShardTreeCertificate(BitString.create(new Uint8Array([1])), [new Uint8Array([1])]),
      new UnicityTreeCertificate(0b11n, 0b11n, new Uint8Array([1]), []),
      new UnicitySeal(0b11n, 0b11n, 0b11n, 0b11n, 0b11n, null, new Uint8Array([1]), new Map()),
    );

    const txProof = new TransactionProof(0b11n, new Uint8Array([1]), [], unicityCertificate);
    const recordWithProof = new TransactionRecordWithProof(transactionRecord, txProof);

    const block = new Block(
      await storage.getNextBlockNumber(),
      1,
      1,
      1,
      txProof.unicityCertificate.unicitySeal.timestamp,
      recordWithProof,
      new Uint8Array([5, 6, 7, 8]),
      new DataHash(HashAlgorithm.SHA256, new Uint8Array([1, 2, 3, 4])),
      null,
    );

    console.log('Storing block...');
    const stored = await storage.put(block);
    console.log('Store result:', stored);

    console.log('Retrieving block...');
    const retrieved = await storage.get(1n);
    expect(retrieved).not.toBeNull();
    assert(retrieved);
    console.log('Retrieved successfully');
    console.log('Data comparison:');
    expect(retrieved.index).toEqual(block.index);
    expect(retrieved.index).toEqual(1n);
    expect(retrieved.chainId).toEqual(block.chainId);
    expect(retrieved.version).toEqual(block.version);
    expect(retrieved.forkId).toEqual(block.forkId);
    expect(retrieved.timestamp).toEqual(block.timestamp);
    const originalProof = block.txProof;
    const retrievedProof = retrieved.txProof;
    console.log('Transaction proof comparison:');
    expect(originalProof.transactionRecord.transactionOrder.payload.type).toEqual(
      retrievedProof.transactionRecord.transactionOrder.payload.type,
    );
    expect(HexConverter.encode(originalProof.transactionRecord.transactionOrder.payload.attributes.data.bytes)).toEqual(
      HexConverter.encode(retrievedProof.transactionRecord.transactionOrder.payload.attributes.data.bytes),
    );
    if (retrieved.previousBlockHash && block.previousBlockHash) {
      expect(HexConverter.encode(retrieved.previousBlockHash)).toEqual(HexConverter.encode(block.previousBlockHash));
    }
    expect(retrieved.rootHash.equals(block.rootHash)).toBeTruthy();
    if (retrieved.noDeletionProofHash && block.noDeletionProofHash) {
      expect(HexConverter.encode(retrieved.noDeletionProofHash)).toEqual(
        HexConverter.encode(block.noDeletionProofHash),
      );
    }
    const nextBlockNumber = await storage.getNextBlockNumber();
    expect(nextBlockNumber).toEqual(2n);
  });
});
