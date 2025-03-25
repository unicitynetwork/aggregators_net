import type { UpdateNonFungibleTokenTransactionOrder } from '@alphabill/alphabill-js-sdk/lib/tokens/transactions/UpdateNonFungibleToken.js';
import { BitString } from '@alphabill/alphabill-js-sdk/lib/codec/cbor/BitString.js';
import { InputRecord } from '@alphabill/alphabill-js-sdk/lib/unit/UnicityCertificate.js';
import { ShardTreeCertificate } from '@alphabill/alphabill-js-sdk/lib/unit/UnicityCertificate.js';
import { UnicityTreeCertificate } from '@alphabill/alphabill-js-sdk/lib/unit/UnicityCertificate.js';
import { UnicitySeal } from '@alphabill/alphabill-js-sdk/lib/unit/UnicityCertificate.js';
import { UnicityCertificate } from '@alphabill/alphabill-js-sdk/lib/unit/UnicityCertificate.js';
import { TransactionProof } from '@alphabill/alphabill-js-sdk/lib/transaction/record/TransactionProof.js';
import { TransactionRecordWithProof } from '@alphabill/alphabill-js-sdk/lib/transaction/record/TransactionRecordWithProof.js';
import { TransactionStatus } from '@alphabill/alphabill-js-sdk/lib/transaction/record/TransactionStatus.js';
import { TransactionRecord } from '@alphabill/alphabill-js-sdk/lib/transaction/record/TransactionRecord.js';
import { ServerMetadata } from '@alphabill/alphabill-js-sdk/lib/transaction/record/ServerMetadata.js';
import { TransactionOrder } from '@alphabill/alphabill-js-sdk/lib/transaction/TransactionOrder.js';
import { TransactionPayload } from '@alphabill/alphabill-js-sdk/lib/transaction/TransactionPayload.js';
import { StateLock } from '@alphabill/alphabill-js-sdk/lib/transaction/StateLock.js';
import { ClientMetadata } from '@alphabill/alphabill-js-sdk/lib/transaction/ClientMetadata.js';
import { UpdateNonFungibleTokenAttributes } from '@alphabill/alphabill-js-sdk/lib/tokens/attributes/UpdateNonFungibleTokenAttributes.js';
import { UnitId } from '@alphabill/alphabill-js-sdk/lib/UnitId.js';
import { SubmitHashResponse } from '../../src/alphabill/SubmitHashResponse.js';
import { AlwaysTruePredicate } from '@alphabill/alphabill-js-sdk/lib/transaction/predicates/AlwaysTruePredicate.js';
import { IPredicate } from '@alphabill/alphabill-js-sdk/lib/transaction/predicates/IPredicate.js';
import { TokenPartitionJsonRpcClient } from '@alphabill/alphabill-js-sdk/lib/json-rpc/TokenPartitionJsonRpcClient.js';
import { ISigningService } from '@alphabill/alphabill-js-sdk/lib/signing/ISigningService.js';
import { IProofFactory } from '@alphabill/alphabill-js-sdk/lib/transaction/proofs/IProofFactory.js';
import { AlwaysTrueProofFactory } from '@alphabill/alphabill-js-sdk/lib/transaction/proofs/AlwaysTrueProofFactory.js';
import { UpdateNonFungibleToken } from '@alphabill/alphabill-js-sdk/lib/tokens/transactions/UpdateNonFungibleToken.js';
import { NonFungibleToken } from '@alphabill/alphabill-js-sdk/lib/tokens/NonFungibleToken.js';
import { NonFungibleTokenData } from '@alphabill/alphabill-js-sdk/lib/tokens/NonFungibleTokenData.js';
import { IAlphabillClient } from '../../src/alphabill/IAlphabillClient.js';

// Create mock interfaces for required properties
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
  // Required properties to match AlphabillClient interface
  public readonly signingService: ISigningService;
  public readonly tokenClient: TokenPartitionJsonRpcClient;
  public readonly networkId: number;
  public readonly proofFactory: IProofFactory;
  public readonly alwaysTrueProofFactory: IProofFactory;
  
  private previousData: Uint8Array[] = [];

  constructor() {
    // Initialize required properties with mock implementations
    this.signingService = new MockSigningService();
    this.tokenClient = {} as TokenPartitionJsonRpcClient; // Mock as empty object
    this.networkId = 1;
    this.proofFactory = new AlwaysTrueProofFactory();
    this.alwaysTrueProofFactory = new AlwaysTrueProofFactory();
  }

  public async submitHash(rootHash: Uint8Array): Promise<SubmitHashResponse> {
    // Store the current data as previous for next call
    const previousData = this.previousData.length > 0 
      ? this.previousData[this.previousData.length - 1] 
      : null;
    
    // Add current data to history
    this.previousData.push(new Uint8Array(rootHash));

    // Create a mock transaction proof
    const txProof = this.createMockTransactionProof(rootHash);
    
    console.log('Mock Alphabill client: submitting hash successfully');
    return new SubmitHashResponse(previousData, txProof);
  }

  public async initialSetup(): Promise<void> {
    console.log('Mock Alphabill client setup completed successfully');
  }

  // Helper method to create a mock transaction proof
  private createMockTransactionProof(data: Uint8Array): TransactionRecordWithProof<UpdateNonFungibleTokenTransactionOrder> {
    // Create a simplified mock token for test purposes
    const mockToken = {
      id: new UnitId(new Uint8Array([1, 2, 3, 4]), new Uint8Array([0, 0, 0, 1])),
      typeId: new UnitId(new Uint8Array([1, 2, 3, 4]), new Uint8Array([0, 0, 0, 1])),
      data: new Uint8Array([1, 2, 3, 4]),
      owner: new UnitId(new Uint8Array([5, 6, 7, 8]), new Uint8Array([0, 0, 0, 1])),
      name: "Mock Token",
      uri: "https://example.com/token",
      _data: NonFungibleTokenData.create(data),
      encode: () => new Uint8Array([1, 2, 3, 4])
    } as unknown as NonFungibleToken;

    // Create mock NFT data
    const nftData = NonFungibleTokenData.create(data);
    
    // Use the real UpdateNonFungibleToken class to create a transaction order
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
          _brand: 'UpdateNonFungibleTokenAttributes' as const
        }
      }
    } as unknown as UpdateNonFungibleTokenTransactionOrder;

    // Create mock server metadata with all required properties
    const serverMetadata = {
      roundNumber: 1n,
      fee: 1n,
      actualFee: 1n,
      successIndicator: 0, // TransactionStatus.SUCCESS
      blockNumber: 1n,
      feeCreditRecordId: null,
      hash: new Uint8Array([7, 8, 9]),
      rpcErrors: null,
      _targetUnitIds: [],
      _processingDetails: null,
      targetUnitIds: [],
      processingDetails: null
    } as unknown as ServerMetadata;

    // Create mock transaction record
    const transactionRecord = {
      transactionOrder: updateOrder,
      serverMetadata: serverMetadata
    } as TransactionRecord<UpdateNonFungibleTokenTransactionOrder>;

    // Create mock unicity certificate components
    const inputRecord = new InputRecord(
      1n, 1n, 1n, null, null, new Uint8Array([1]), 1n, null, 1n
    );
    
    const shardTreeCertificate = new ShardTreeCertificate(
      BitString.create(new Uint8Array([1])), 
      [new Uint8Array([1])]
    );
    
    const unicityTreeCertificate = new UnicityTreeCertificate(
      1n, 1n, new Uint8Array([1]), []
    );
    
    const unicitySeal = new UnicitySeal(
      1n, 1n, 1n, 1n, 1n, null, new Uint8Array([1]), new Map()
    );

    // Create complete unicity certificate
    const unicityCertificate = new UnicityCertificate(
      1n,
      inputRecord,
      null,
      shardTreeCertificate,
      unicityTreeCertificate,
      unicitySeal
    );

    // Create transaction proof
    const txProof = new TransactionProof(
      1n, 
      new Uint8Array([1]), 
      [], 
      unicityCertificate
    );

    // Combine record and proof
    return {
      transactionRecord,
      transactionProof: txProof,
      encode: () => new Uint8Array([1, 2, 3])
    } as TransactionRecordWithProof<UpdateNonFungibleTokenTransactionOrder>;
  }
} 