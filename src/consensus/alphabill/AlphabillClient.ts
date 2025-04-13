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
import logger from '../../logger.js';

export class AlphabillClient implements IAlphabillClient {
  private constructor(
    private readonly signingService: ISigningService,
    private readonly tokenClient: TokenPartitionJsonRpcClient,
    private readonly networkId: number,
    private readonly partitionId: number,
    private readonly proofFactory: IProofFactory,
    private readonly alwaysTrueProofFactory: IProofFactory,
  ) {}

  public static async create(
    signingService: ISigningService,
    tokenPartitionUrl: string,
    tokenPartitionId: number,
    networkId: number,
  ): Promise<AlphabillClient> {
    const tokenClient = createTokenClient({ transport: http(tokenPartitionUrl) });
    const proofFactory = new PayToPublicKeyHashProofFactory(signingService);
    const alwaysTrueProofFactory = new AlwaysTrueProofFactory();
    const units = await tokenClient.getUnitsByOwnerId(signingService.publicKey);
    if (units.nonFungibleTokens.length > 0) {
      logger.info('NFT already exists, skipping initial Alphabill setup.');
      return new AlphabillClient(
        signingService,
        tokenClient,
        networkId,
        tokenPartitionId,
        proofFactory,
        alwaysTrueProofFactory,
      );
    }
    logger.info('Setting up Alphabill client...');
    const feeCredits = units.feeCreditRecords;
    if (feeCredits.length == 0) {
      throw new Error('No fee credits found.');
    }
    const feeCreditRecordId = feeCredits.at(0)!;
    const round = (await tokenClient.getRoundInfo()).roundNumber;
    const identifier = new Uint8Array([1, 2, 3]);
    const tokenTypeUnitId = new UnitIdWithType(identifier, TokenPartitionUnitType.NON_FUNGIBLE_TOKEN_TYPE);
    logger.info(`Creating NFT type with unit ID ${tokenTypeUnitId}.`);

    const createNonFungibleTokenTypeTransactionOrder = await CreateNonFungibleTokenType.create({
      dataUpdatePredicate: new AlwaysTruePredicate(),
      icon: { data: new Uint8Array(), type: 'image/png' },
      metadata: new ClientMetadata(round + 60n, 5n, feeCreditRecordId, null),
      name: 'Unicity Trust Anchor',
      networkIdentifier: networkId,
      parentTypeId: null,
      partitionIdentifier: tokenPartitionId,
      stateLock: null,
      stateUnlock: new AlwaysTruePredicate(),
      subTypeCreationPredicate: new AlwaysTruePredicate(),
      symbol: 'Unicity',
      tokenMintingPredicate: new AlwaysTruePredicate(),
      tokenTypeOwnerPredicate: new AlwaysTruePredicate(),
      typeId: tokenTypeUnitId,
      version: 1n,
    }).sign(proofFactory, []);
    const createNonFungibleTokenTypeHash = await tokenClient.sendTransaction(
      createNonFungibleTokenTypeTransactionOrder,
    );
    const createNonFungibleTokenTypeProof = await tokenClient.waitTransactionProof(
      createNonFungibleTokenTypeHash,
      CreateNonFungibleTokenType,
    );
    const txStatus = createNonFungibleTokenTypeProof.transactionRecord.serverMetadata.successIndicator;
    logger.info(`Create NFT type transaction status - ${TransactionStatus[txStatus]}.`);

    logger.info(`Creating NFT.`);
    const createNonFungibleTokenTransactionOrder = await CreateNonFungibleToken.create({
      data: NonFungibleTokenData.create(new Uint8Array()),
      dataUpdatePredicate: new AlwaysTruePredicate(),
      metadata: new ClientMetadata(round + 60n, 5n, feeCreditRecordId, null),
      name: 'Unicity Trust Anchor',
      networkIdentifier: networkId,
      nonce: 0n,
      ownerPredicate: PayToPublicKeyHashPredicate.create(signingService.publicKey),
      partitionIdentifier: tokenPartitionId,
      stateLock: null,
      stateUnlock: new AlwaysTruePredicate(),
      typeId: tokenTypeUnitId,
      uri: 'https://github.com/unicitynetwork',
      version: 1n,
    }).sign(alwaysTrueProofFactory, proofFactory);
    const createNonFungibleTokenHash = await tokenClient.sendTransaction(createNonFungibleTokenTransactionOrder);
    const createNonFungibleTokenProof = await tokenClient.waitTransactionProof(
      createNonFungibleTokenHash,
      CreateNonFungibleToken,
    );
    const createNftTxStatus = createNonFungibleTokenProof.transactionRecord.serverMetadata.successIndicator;
    logger.info(`Create NFT transaction status - ${TransactionStatus[createNftTxStatus]}.`);
    if (createNftTxStatus !== TransactionStatus.Successful) {
      throw new Error('Alphabill client setup failed.');
    }
    logger.info('Alphabill client setup successful.');
    return new AlphabillClient(
      signingService,
      tokenClient,
      networkId,
      tokenPartitionId,
      proofFactory,
      alwaysTrueProofFactory,
    );
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

    const updateNonFungibleTokenTransactionOrder = await UpdateNonFungibleToken.create({
      data: updatedNftData,
      metadata: new ClientMetadata(round + 60n, 5n, feeCreditRecordId, null),
      networkIdentifier: this.networkId,
      partitionIdentifier: this.partitionId,
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
    logger.info(`Update NFT transaction status - ${TransactionStatus[updateNftTxStatus]}.`);
    return new SubmitHashResponse(token.data, updateNonFungibleTokenProof);
  }
}
