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
import { Binary } from 'mongodb';
import mongoose from 'mongoose';

import { Block } from '../../src/hashchain/Block.js';
import { BlockStorage } from '../../src/hashchain/BlockStorage.js';
import { connectToSharedMongo, disconnectFromSharedMongo, clearAllCollections } from '../TestUtils.js';
import logger from '../../src/logger.js';

describe('Block Storage Tests', () => {
  jest.setTimeout(60000);

  beforeAll(async () => {
    const mongoUri = await connectToSharedMongo();
  });

  afterAll(async () => {
    await disconnectFromSharedMongo();
  });

  afterEach(async () => {
    await clearAllCollections();
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
      new Uint8Array([1]),
      new ShardTreeCertificate(BitString.create(new Uint8Array([1])), [new Uint8Array([1])]),
      new UnicityTreeCertificate(0b11n, 0b11n, []),
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

    logger.info('Storing block...');
    const stored = await storage.put(block);
    logger.info('Store result:', stored);

    logger.info('Retrieving block...');
    const retrieved = await storage.get(1n);
    expect(retrieved).not.toBeNull();
    assert(retrieved);
    logger.info('Retrieved successfully');
    logger.info('Data comparison:');
    expect(retrieved.index).toEqual(block.index);
    expect(retrieved.index).toEqual(1n);
    expect(retrieved.chainId).toEqual(block.chainId);
    expect(retrieved.version).toEqual(block.version);
    expect(retrieved.forkId).toEqual(block.forkId);
    expect(retrieved.timestamp).toEqual(block.timestamp);
    const originalProof = block.txProof;
    const retrievedProof = retrieved.txProof;
    logger.info('Transaction proof comparison:');
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

  it('Should deserialize blocks with binary-encoded data from MongoDB', async () => {
    const testData = {
      _id: new mongoose.Types.ObjectId('6812542e10effd5dbc701f75'),
      index: new Binary(Buffer.from('CA==', 'base64')),
      chainId: 1,
      version: 1,
      forkId: 1,
      txProof: new Binary(
        Buffer.from(
          'gtkD94MB2QP4iwEBGGZYIcFq6LQWZfd62nhW2CbTXB4+Oeb+tKCGhtYMZ8/kGe8kBAqCWCIAAJailtIk8oXGe+6Tww+KMJFX8NqjXcW4fkELeGMKCc/HGQQP9oQZCe8FWCFkbis93xs06UVCN5M52S2Aj7YQ8XLWXtJRP4yX1lqmSxD29oJYZ4JYQaZtw8i836R8yagY5X1xsyQrHcj4QkpWh6mgiwn5VN7jdYW14JU73Gn/fKq/vH6e/WwOH9Af1lech+xMZ2qN3u8BWCEDhRc2PG3TJE44yoztEO2YI4HtmzYPySrVFUfQaYIF/NaB9lhnglhB9jvYKyFsXIurmUj9F4HsvbtbE00RoJ6k+HFwzgDbcyVpBYSaWbBmDF3AgLO8RifyCG77q87J5t3+8xPLNr+u2gBYIQOFFzY8bdMkTjjKjO0Q7Zgjge2bNg/JKtUVR9BpggX81oQAgVghwWrotBZl93raeFbYJtNcHj455v60oIaG1gxnz+QZ7yQEAfbZA/GEAVggW7946Pk5IiCzi3fB7VkdJqIKInv7h1TZGJa8dnGG8lCA2QPvhwHZA/CKARkJtABYILu7SMl/68cAvBUWtFKWcBGYOwlSHqov8AH62BBCU4/yWCCOXghlOAD7KImlP22IjxDILIWC+PAzsnGRGSCX37aZ/UgAAAAAAAAAABpoElQqWCD3H8o+ol2/TGPEwzLdZVbl/Skk0vx62KuILHdtsLBoewBYIHfBs6mxsRfbxgddjDyEgYlwcGewSSq+lNCGAI+9YEmwWCCgCB1faHvJmN03LACZRH1WD0h87+/dG13930A+8IhmPFggqEDamXhZhlcT2KrS1i5zNNfUg/D5KBijjvsaJTHBFB2CQYCA2QP2gwEYZoDZA+mIAQEZKuMAGmgSVCxYIHR9MPEDwcXyyrIJcykqBp2LENg66b4R8H5bH1Io7yb7WCBIoI0ngONnQ3TyQKEAEdFV/Y8ByVFz4A6tLL2RHsQg7ap4NTE2VWl1MkhBa3ZCb1FqaWdTVmdDQ3RjOFBqdDZTc1pja2R1dTVxR2J4b2sydEp0Wkdna1dTWEFbK0s3zGrPHq49qn6skFHSgargWo1RIctgpxp1g5NrJkYG/AOOgLRMtiE7bMkhz6LeNtq7j+U8vWElTogQ93FlAXg1MTZVaXUySEFreFJOc3RhYU1XY0xibVV1OXkxWE5GZkFnWUxneWRUYnc4QWRHZmVqck1pSzZYQRTq+Dl0FEJc2wPRPQSjI+UGraL/IyzTSeYjkYibMTORPl8YPxMq/OBy8E0XjeIy+84q3RHUPeXfiVkLxZOjaDgBeDUxNlVpdTJIQW0yNjhqWldha0NqaVRaR2hVSkZBUWJ6dWlCTWMxMzU4VUFnd1U5RFBURHVDRVhBdc+Gzs0fgWvrqmm/Y3KlZNQzAiUGCYJwOYlH1DFC6r5T7zHqlgbPzCq8wek2QrGRMnaCONEZKGcV51YR76kC5wB4NTE2VWl1MkhBbUE2eWZoUVh3ZUJtMlpidWVHYlFYaWRLMm9nNGNTakVFRTdBQnZyTHVIa2ZFWEFqTPccxetgM6nSnYd10exJEV3er1MjI1nP7HEMWSlQIn9WAe4R/yv+/xABkaBs9tLiTHGpVA24nFEfjlPe+/r8AHg1MTZVaXUySEFtQzVrbzZvV1ZOOUdMQXhhMlc1U0NNMm5BUHVUaGRLUXJoWnNDN1RaUXRTb3BYQfGO4RERLVF2wYZrEpQCUUJIdEhEuVY3OTQu0CGt4WdtFb3pkd8wIPVHx4O28a/xT0a/3nwTQjN6mxXDvAFxSggAeDUxNlVpdTJIQW1OWVRRdkVhWVhMRWIzdUoyNHJCY1FxZnJwcUtRWVFDc2ZHQ0hqVnZDMnFEb1hB6h2NKF0oGF3TgKSu1vVv4Z6dlJ7b0w8HuIMjTRH+3kksgbbS7G+0t9KhMW7nf4kMwXm725PJDupWzO59aZItDwB4NTE2VWl1MkhBbVNtZjVjcVhrUWdwZld0UldUb3RNeW80WWVjYmh6ZUtlU2lUSkhrZ2dBMlVyWEFuABr36Cu7O40PBg80uTlCiNqXXmOkSthJEApyB44ivB5/ZUvHjT4YclMmkDanK2I8XhP9iKmgSCmBRVXLguW3AHg1MTZVaXUySEFtVThya2t1TXQ4a2V0bVN4alN5YmVpbTVxN0Job2dWSnJHNEJqbXBwdUZZYlhYQcLjYYCcQmKx5OKFeAS+YakIdHC3unM8aKHpupNPGg9SaF+HwOvf1Z2pY/t7hZahl42LHZ7CaE7RaQvKKpOb6+cBeDUxNlVpdTJIQW1WNlpibzVtQnFaUGY0VFk5ZDdBa01OWjJwSFJFdldEZnNtRGdVM213WnNiU1hB6jF5p5DJNRKlxefIzh1U9dwk3JC4BPDjRMFAAoUySz0yv9FoeyB5V5I2xj9V6bhDGulbI/4Bd8pzuMgkpeZp8AB4NTE2VWl1MkhBbVZUVnhZb3ZzYVhRM3plb1h6Slo0cjVzZDRDVW1IdXRRNXp4TWZENmR3b3BpWEHoh2HEerUDlPBnDtDrz7t+cC+RKA4Q8YKu8xgAL1kBF2O1h850gr+SmUfz4wWMUjKn5CXPDRyh8iXIIsDmA1KWAQ==',
          'base64',
        ),
      ),
      previousBlockHash: new Binary(Buffer.from('AACWopbSJPKFxnvuk8MPijCRV/Dao13FuH5BC3hjCgnPxw==', 'base64')),
      rootHash: new Binary(Buffer.from('AACWopbSJPKFxnvuk8MPijCRV/Dao13FuH5BC3hjCgnPxw==', 'base64')),
      noDeletionProofHash: null,
      __v: 0,
    };

    await mongoose.connection.collection('blocks').insertOne(testData);

    const storage = new BlockStorage();
    const retrieved = await storage.get(8n);

    expect(retrieved).not.toBeNull();
    assert(retrieved);

    expect(retrieved.index).toEqual(8n);
    expect(retrieved.chainId).toEqual(1);
    expect(retrieved.version).toEqual(1);
    expect(retrieved.forkId).toEqual(1);

    const expectedPreviousBlockHash = Buffer.from('AACWopbSJPKFxnvuk8MPijCRV/Dao13FuH5BC3hjCgnPxw==', 'base64');
    expect(new Uint8Array(retrieved.previousBlockHash)).toEqual(new Uint8Array(expectedPreviousBlockHash));

    const expectedRootHash = Buffer.from('AACWopbSJPKFxnvuk8MPijCRV/Dao13FuH5BC3hjCgnPxw==', 'base64');
    expect(new Uint8Array(retrieved.rootHash.imprint)).toEqual(new Uint8Array(expectedRootHash));

    expect(retrieved.noDeletionProofHash).toBeNull();

    // Verify the txProof can be decoded (this tests that the binary data is valid)
    expect(retrieved.txProof).toBeDefined();
    expect(retrieved.txProof.transactionRecord).toBeDefined();
  });
});
