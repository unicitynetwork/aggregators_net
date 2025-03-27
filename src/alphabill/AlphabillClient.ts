import { TokenPartitionJsonRpcClient } from '@alphabill/alphabill-js-sdk/lib/json-rpc/TokenPartitionJsonRpcClient.js';
import { type ISigningService } from '@alphabill/alphabill-js-sdk/lib/signing/ISigningService.js';
import { createTokenClient, http } from '@alphabill/alphabill-js-sdk/lib/StateApiClientFactory.js';
import { NonFungibleToken } from '@alphabill/alphabill-js-sdk/lib/tokens/NonFungibleToken.js';
import { NonFungibleTokenData } from '@alphabill/alphabill-js-sdk/lib/tokens/NonFungibleTokenData.js';
import { TokenPartitionUnitType } from '@alphabill/alphabill-js-sdk/lib/tokens/TokenPartitionUnitType.js';
import { CreateNonFungibleToken } from '@alphabill/alphabill-js-sdk/lib/tokens/transactions/CreateNonFungibleToken.js';
import { CreateNonFungibleTokenType } from '@alphabill/alphabill-js-sdk/lib/tokens/transactions/CreateNonFungibleTokenType.js';
import { UpdateNonFungibleToken } from '@alphabill/alphabill-js-sdk/lib/tokens/transactions/UpdateNonFungibleToken.js';
import { UnitIdWithType } from '@alphabill/alphabill-js-sdk/lib/tokens/UnitIdWithType.js';
import { ClientMetadata } from '@alphabill/alphabill-js-sdk/lib/transaction/ClientMetadata.js';
import { AlwaysTruePredicate } from '@alphabill/alphabill-js-sdk/lib/transaction/predicates/AlwaysTruePredicate.js';
import { PayToPublicKeyHashPredicate } from '@alphabill/alphabill-js-sdk/lib/transaction/predicates/PayToPublicKeyHashPredicate.js';
import { AlwaysTrueProofFactory } from '@alphabill/alphabill-js-sdk/lib/transaction/proofs/AlwaysTrueProofFactory.js';
import { type IProofFactory } from '@alphabill/alphabill-js-sdk/lib/transaction/proofs/IProofFactory.js';
import { PayToPublicKeyHashProofFactory } from '@alphabill/alphabill-js-sdk/lib/transaction/proofs/PayToPublicKeyHashProofFactory.js';
import { TransactionStatus } from '@alphabill/alphabill-js-sdk/lib/transaction/record/TransactionStatus.js';
import { DataHash } from '@unicitylabs/commons/lib/hash/DataHash.js';

import { IAlphabillClient } from './IAlphabillClient.js';
import { SubmitHashResponse } from './SubmitHashResponse.js';

export class AlphabillClient implements IAlphabillClient {
  private readonly signingService: ISigningService;
  private readonly tokenClient: TokenPartitionJsonRpcClient;
  private readonly networkId: number;
  private readonly proofFactory: IProofFactory;
  private readonly alwaysTrueProofFactory: IProofFactory;

  public constructor(signingService: ISigningService, alphabillTokenPartitionUrl: string, networkId: number) {
    this.signingService = signingService;
    this.tokenClient = createTokenClient({ transport: http(alphabillTokenPartitionUrl) });
    this.networkId = networkId;
    this.proofFactory = new PayToPublicKeyHashProofFactory(this.signingService);
    this.alwaysTrueProofFactory = new AlwaysTrueProofFactory();
  }

  public async submitHash(transactionHash: DataHash): Promise<SubmitHashResponse> {
    const units = await this.tokenClient.getUnitsByOwnerId(this.signingService.publicKey);
    const feeCredits = units.feeCreditRecords;
    if (feeCredits.length == 0) {
      throw new Error('No fee credits found.');
    }
    const feeCreditRecordId = feeCredits.at(0)!;
    const round = (await this.tokenClient.getRoundInfo()).roundNumber;

    const updatedNftData = NonFungibleTokenData.create(transactionHash.data);

    const nonFungibleTokens = units.nonFungibleTokens;
    if (!nonFungibleTokens) {
      throw new Error('No NFTs found.');
    }
    const tokenId = nonFungibleTokens.at(0);
    const token = await this.tokenClient.getUnit(tokenId!, false, NonFungibleToken);
    if (!token) {
      throw new Error('NFT not found.');
    }

    console.log(`Updating data for token with ID ${tokenId}`);
    const updateNonFungibleTokenTransactionOrder = await UpdateNonFungibleToken.create({
      data: updatedNftData,
      metadata: new ClientMetadata(round + 60n, 5n, feeCreditRecordId, null),
      networkIdentifier: this.networkId,
      stateLock: null,
      stateUnlock: new AlwaysTruePredicate(),
      token: token,
      version: 1n,
    }).sign(this.alwaysTrueProofFactory, this.proofFactory, [this.alwaysTrueProofFactory]);
    const updateNonFungibleTokenHash = await this.tokenClient.sendTransaction(updateNonFungibleTokenTransactionOrder);
    const updateNonFungibleTokenProof = await this.tokenClient.waitTransactionProof(
      updateNonFungibleTokenHash,
      UpdateNonFungibleToken,
    );
    const updateNftTxStatus = updateNonFungibleTokenProof.transactionRecord.serverMetadata.successIndicator;
    console.log(`Update NFT transaction status - ${TransactionStatus[updateNftTxStatus]}.`);
    return new SubmitHashResponse(token.data, updateNonFungibleTokenProof);
  }

  public async initialSetup(): Promise<void> {
    const units = await this.tokenClient.getUnitsByOwnerId(this.signingService.publicKey);
    if (units.nonFungibleTokens.length > 0) {
      console.log('NFT already exists, skipping initial Alphabill setup.');
      return;
    }
    console.log('Setting up Alphabill client...');
    const feeCredits = units.feeCreditRecords;
    if (feeCredits.length == 0) {
      throw new Error('No fee credits found.');
    }
    const feeCreditRecordId = feeCredits.at(0)!;
    const round = (await this.tokenClient.getRoundInfo()).roundNumber;
    const identifier = new Uint8Array([1, 2, 3]);
    const tokenTypeUnitId = new UnitIdWithType(identifier, TokenPartitionUnitType.NON_FUNGIBLE_TOKEN_TYPE);
    console.log(`Creating NFT type with unit ID ${tokenTypeUnitId}.`);

    const createNonFungibleTokenTypeTransactionOrder = await CreateNonFungibleTokenType.create({
      dataUpdatePredicate: new AlwaysTruePredicate(),
      icon: { data: new Uint8Array(), type: 'image/png' },
      metadata: new ClientMetadata(round + 60n, 5n, feeCreditRecordId, null),
      name: 'Unicity Trust Anchor',
      networkIdentifier: this.networkId,
      parentTypeId: null,
      stateLock: null,
      stateUnlock: new AlwaysTruePredicate(),
      subTypeCreationPredicate: new AlwaysTruePredicate(),
      symbol: 'Unicity',
      tokenMintingPredicate: new AlwaysTruePredicate(),
      tokenTypeOwnerPredicate: new AlwaysTruePredicate(),
      type: { unitId: tokenTypeUnitId },
      version: 1n,
    }).sign(this.proofFactory, []);
    const createNonFungibleTokenTypeHash = await this.tokenClient.sendTransaction(
      createNonFungibleTokenTypeTransactionOrder,
    );
    const createNonFungibleTokenTypeProof = await this.tokenClient.waitTransactionProof(
      createNonFungibleTokenTypeHash,
      CreateNonFungibleTokenType,
    );
    const txStatus = createNonFungibleTokenTypeProof.transactionRecord.serverMetadata.successIndicator;
    console.log(`Create NFT type transaction status - ${TransactionStatus[txStatus]}.`);

    console.log(`Creating NFT.`);
    const createNonFungibleTokenTransactionOrder = await CreateNonFungibleToken.create({
      data: NonFungibleTokenData.create(new Uint8Array()),
      dataUpdatePredicate: new AlwaysTruePredicate(),
      metadata: new ClientMetadata(round + 60n, 5n, feeCreditRecordId, null),
      name: 'Unicity Trust Anchor',
      networkIdentifier: this.networkId,
      nonce: 0n,
      ownerPredicate: PayToPublicKeyHashPredicate.create(this.signingService.publicKey),
      stateLock: null,
      stateUnlock: new AlwaysTruePredicate(),
      type: { unitId: tokenTypeUnitId },
      uri: 'https://github.com/unicitynetwork',
      version: 1n,
    }).sign(this.alwaysTrueProofFactory, this.proofFactory);
    const createNonFungibleTokenHash = await this.tokenClient.sendTransaction(createNonFungibleTokenTransactionOrder);
    const createNonFungibleTokenProof = await this.tokenClient.waitTransactionProof(
      createNonFungibleTokenHash,
      CreateNonFungibleToken,
    );
    const createNftTxStatus = createNonFungibleTokenProof.transactionRecord.serverMetadata.successIndicator;
    console.log(`Create NFT transaction status - ${TransactionStatus[createNftTxStatus]}.`);
    if (createNftTxStatus === TransactionStatus.Successful) {
      console.log('Alphabill client setup successful.');
    } else {
      console.log('Alphabill client setup failed.');
    }
  }
}
