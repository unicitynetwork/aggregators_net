import { BitString } from '@alphabill/alphabill-js-sdk/lib/codec/cbor/BitString.js';
import { TokenPartitionJsonRpcClient } from '@alphabill/alphabill-js-sdk/lib/json-rpc/TokenPartitionJsonRpcClient.js';
import { type ISigningService } from '@alphabill/alphabill-js-sdk/lib/signing/ISigningService.js';
import { UpdateNonFungibleTokenAttributes } from '@alphabill/alphabill-js-sdk/lib/tokens/attributes/UpdateNonFungibleTokenAttributes.js';
import { NonFungibleTokenData } from '@alphabill/alphabill-js-sdk/lib/tokens/NonFungibleTokenData.js';
import type { UpdateNonFungibleTokenTransactionOrder } from '@alphabill/alphabill-js-sdk/lib/tokens/transactions/UpdateNonFungibleToken.js';
import { ClientMetadata } from '@alphabill/alphabill-js-sdk/lib/transaction/ClientMetadata.js';
import { AlwaysTrueProofFactory } from '@alphabill/alphabill-js-sdk/lib/transaction/proofs/AlwaysTrueProofFactory.js';
import { type IProofFactory } from '@alphabill/alphabill-js-sdk/lib/transaction/proofs/IProofFactory.js';
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
  InputRecord,
  ShardTreeCertificate,
  UnicityCertificate,
  UnicitySeal,
  UnicityTreeCertificate,
} from '@alphabill/alphabill-js-sdk/lib/unit/UnicityCertificate.js';
import { UnitId } from '@alphabill/alphabill-js-sdk/lib/UnitId.js';
import { DataHash } from '@unicitylabs/commons/lib/hash/DataHash.js';

import { IAlphabillClient } from '../../../src/consensus/alphabill/IAlphabillClient.js';
import { SubmitHashResponse } from '../../../src/consensus/alphabill/SubmitHashResponse.js';
import logger from '../../../src/logger.js';
import { AlwaysTruePredicate } from '@alphabill/alphabill-js-sdk/lib/transaction/predicates/AlwaysTruePredicate.js';

class MockSigningService implements ISigningService {
  public publicKey = new Uint8Array([1, 2, 3, 4]);

  public async sign(message: Uint8Array): Promise<Uint8Array> {
    return new Uint8Array([5, 6, 7, 8]);
  }
}

export class MockAlphabillClient implements IAlphabillClient {
  public readonly signingService: ISigningService;
  public readonly tokenClient: TokenPartitionJsonRpcClient;
  public readonly networkId: number;
  public readonly proofFactory: IProofFactory;
  public readonly alwaysTrueProofFactory: IProofFactory;

  private previousData: Uint8Array[] = [];

  public constructor() {
    this.signingService = new MockSigningService();
    this.tokenClient = {} as TokenPartitionJsonRpcClient;
    this.networkId = 1;
    this.proofFactory = new AlwaysTrueProofFactory();
    this.alwaysTrueProofFactory = new AlwaysTrueProofFactory();
  }

  public async submitHash(transactionHash: DataHash): Promise<SubmitHashResponse> {
    const previousData = this.previousData.length > 0 ? this.previousData[this.previousData.length - 1] : null;

    this.previousData.push(transactionHash.data);

    const txProof = this.createMockTransactionProof(transactionHash.data);

    logger.info('Mock Alphabill client: submitting hash successfully');
    return new SubmitHashResponse(previousData, txProof);
  }

  private createMockTransactionProof(
    data: Uint8Array,
  ): TransactionRecordWithProof<UpdateNonFungibleTokenTransactionOrder> {
    const nftData = NonFungibleTokenData.create(data);
    const attributes = new UpdateNonFungibleTokenAttributes(nftData, 1n);
    const tokenId = new UnitId(new Uint8Array([1, 2, 3, 4]), new Uint8Array([0, 0, 0, 1]));
    const metadata = new ClientMetadata(1n, 1n, null, null);
    const predicate = new AlwaysTruePredicate();
    const stateLock = new StateLock(predicate, predicate);

    const payload = new TransactionPayload<UpdateNonFungibleTokenAttributes>(
      1,
      1,
      tokenId,
      1,
      attributes,
      stateLock,
      metadata,
    );

    const authProof = new TypeDataUpdateProofsAuthProof(new Uint8Array([1, 2, 3, 4]), [new Uint8Array([1])]);

    const transactionOrder = new TransactionOrder<UpdateNonFungibleTokenAttributes, TypeDataUpdateProofsAuthProof>(
      1n,
      payload,
      null,
      authProof,
      null,
    );

    const serverMetadata = new ServerMetadata(1n, [], TransactionStatus.Successful, new Uint8Array([1, 2, 3]));

    const transactionRecord = new TransactionRecord<typeof transactionOrder>(1n, transactionOrder, serverMetadata);

    const inputRecord = new InputRecord(1n, 1n, 1n, null, null, new Uint8Array([1]), 1n, null, 1n, null);

    const shardTreeCertificate = new ShardTreeCertificate(BitString.create(new Uint8Array([1])), [new Uint8Array([1])]);

    const unicityTreeCertificate = new UnicityTreeCertificate(1n, 1n, []);

    const unicitySeal = new UnicitySeal(1n, 1n, 1n, 1n, BigInt(Date.now()), null, new Uint8Array([1]), new Map());

    const unicityCertificate = new UnicityCertificate(
      1n,
      inputRecord,
      null,
      new Uint8Array([1]),
      shardTreeCertificate,
      unicityTreeCertificate,
      unicitySeal,
    );

    const transactionProof = new TransactionProof(1n, new Uint8Array([1]), [], unicityCertificate);

    return new TransactionRecordWithProof(transactionRecord, transactionProof);
  }
}
