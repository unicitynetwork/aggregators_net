import { BitString } from '@alphabill/alphabill-js-sdk/lib/codec/cbor/BitString.js';
import { TokenPartitionJsonRpcClient } from '@alphabill/alphabill-js-sdk/lib/json-rpc/TokenPartitionJsonRpcClient.js';
import { type ISigningService } from '@alphabill/alphabill-js-sdk/lib/signing/ISigningService.js';
import { NonFungibleToken } from '@alphabill/alphabill-js-sdk/lib/tokens/NonFungibleToken.js';
import { NonFungibleTokenData } from '@alphabill/alphabill-js-sdk/lib/tokens/NonFungibleTokenData.js';
import type { UpdateNonFungibleTokenTransactionOrder } from '@alphabill/alphabill-js-sdk/lib/tokens/transactions/UpdateNonFungibleToken.js';
import { ClientMetadata } from '@alphabill/alphabill-js-sdk/lib/transaction/ClientMetadata.js';
import { AlwaysTruePredicate } from '@alphabill/alphabill-js-sdk/lib/transaction/predicates/AlwaysTruePredicate.js';
import { AlwaysTrueProofFactory } from '@alphabill/alphabill-js-sdk/lib/transaction/proofs/AlwaysTrueProofFactory.js';
import { type IProofFactory } from '@alphabill/alphabill-js-sdk/lib/transaction/proofs/IProofFactory.js';
import { ServerMetadata } from '@alphabill/alphabill-js-sdk/lib/transaction/record/ServerMetadata.js';
import { TransactionProof } from '@alphabill/alphabill-js-sdk/lib/transaction/record/TransactionProof.js';
import { TransactionRecord } from '@alphabill/alphabill-js-sdk/lib/transaction/record/TransactionRecord.js';
import { TransactionRecordWithProof } from '@alphabill/alphabill-js-sdk/lib/transaction/record/TransactionRecordWithProof.js';
import {
  InputRecord,
  ShardTreeCertificate,
  UnicityTreeCertificate,
  UnicitySeal,
  UnicityCertificate,
} from '@alphabill/alphabill-js-sdk/lib/unit/UnicityCertificate.js';
import { UnitId } from '@alphabill/alphabill-js-sdk/lib/UnitId.js';
import { DataHash } from '@unicitylabs/commons/lib/hash/DataHash.js';

import { IAlphabillClient } from '../../src/alphabill/IAlphabillClient.js';
import { SubmitHashResponse } from '../../src/alphabill/SubmitHashResponse.js';

class MockSigningService implements ISigningService {
  publicKey = new Uint8Array([1, 2, 3, 4]);

  async sign(message: Uint8Array): Promise<Uint8Array> {
    return new Uint8Array([5, 6, 7, 8]);
  }

  async verify(message: Uint8Array, signature: Uint8Array): Promise<boolean> {
    return true;
  }
}

export class MockAlphabillClient implements IAlphabillClient {
  public readonly signingService: ISigningService;
  public readonly tokenClient: TokenPartitionJsonRpcClient;
  public readonly networkId: number;
  public readonly proofFactory: IProofFactory;
  public readonly alwaysTrueProofFactory: IProofFactory;

  private previousData: Uint8Array[] = [];

  constructor() {
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

    console.log('Mock Alphabill client: submitting hash successfully');
    return new SubmitHashResponse(previousData, txProof);
  }

  public async initialSetup(): Promise<void> {
    console.log('Mock Alphabill client setup completed successfully');
  }

  private createMockTransactionProof(
    data: Uint8Array,
  ): TransactionRecordWithProof<UpdateNonFungibleTokenTransactionOrder> {
    const mockToken = {
      id: new UnitId(new Uint8Array([1, 2, 3, 4]), new Uint8Array([0, 0, 0, 1])),
      typeId: new UnitId(new Uint8Array([1, 2, 3, 4]), new Uint8Array([0, 0, 0, 1])),
      data: new Uint8Array([1, 2, 3, 4]),
      owner: new UnitId(new Uint8Array([5, 6, 7, 8]), new Uint8Array([0, 0, 0, 1])),
      name: 'Mock Token',
      uri: 'https://example.com/token',
      _data: NonFungibleTokenData.create(data),
      encode: () => new Uint8Array([1, 2, 3, 4]),
    } as unknown as NonFungibleToken;

    const nftData = NonFungibleTokenData.create(data);

    const updateOrder = {
      data: nftData,
      metadata: new ClientMetadata(1n, 1n, new UnitId(new Uint8Array([1, 2, 3]), new Uint8Array([0, 0, 0, 1])), null),
      networkIdentifier: this.networkId,
      stateLock: null,
      stateUnlock: new AlwaysTruePredicate(),
      token: mockToken,
      version: 1n,
      encode: () => new Uint8Array([1, 2, 3]),
      payload: {
        type: 1n,
        attributes: {
          data: BitString.create(data),
          counter: 1n,
          _brand: 'UpdateNonFungibleTokenAttributes' as const,
        },
      },
    } as unknown as UpdateNonFungibleTokenTransactionOrder;

    const serverMetadata = {
      roundNumber: 1n,
      fee: 1n,
      actualFee: 1n,
      successIndicator: 0,
      blockNumber: 1n,
      feeCreditRecordId: null,
      hash: new Uint8Array([7, 8, 9]),
      rpcErrors: null,
      _targetUnitIds: [],
      _processingDetails: null,
      targetUnitIds: [],
      processingDetails: null,
    } as unknown as ServerMetadata;

    const transactionRecord = {
      transactionOrder: updateOrder,
      serverMetadata: serverMetadata,
    } as TransactionRecord<UpdateNonFungibleTokenTransactionOrder>;

    const inputRecord = new InputRecord(1n, 1n, 1n, null, null, new Uint8Array([1]), 1n, null, 1n);

    const shardTreeCertificate = new ShardTreeCertificate(BitString.create(new Uint8Array([1])), [new Uint8Array([1])]);

    const unicityTreeCertificate = new UnicityTreeCertificate(1n, 1n, new Uint8Array([1]), []);

    const unicitySeal = new UnicitySeal(1n, 1n, 1n, 1n, 1n, null, new Uint8Array([1]), new Map());

    const unicityCertificate = new UnicityCertificate(
      1n,
      inputRecord,
      null,
      shardTreeCertificate,
      unicityTreeCertificate,
      unicitySeal,
    );

    const txProof = new TransactionProof(1n, new Uint8Array([1]), [], unicityCertificate);

    return {
      transactionRecord,
      transactionProof: txProof,
      encode: () => new Uint8Array([1, 2, 3]),
    } as TransactionRecordWithProof<UpdateNonFungibleTokenTransactionOrder>;
  }
}
