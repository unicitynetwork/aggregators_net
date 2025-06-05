import { IUnitId } from '@alphabill/alphabill-js-sdk/lib/IUnitId.js';
import { TokenPartitionJsonRpcClient } from '@alphabill/alphabill-js-sdk/lib/json-rpc/TokenPartitionJsonRpcClient.js';
import { type ISigningService } from '@alphabill/alphabill-js-sdk/lib/signing/ISigningService.js';
import { createTokenClient, http } from '@alphabill/alphabill-js-sdk/lib/StateApiClientFactory.js';
import { NonFungibleToken } from '@alphabill/alphabill-js-sdk/lib/tokens/NonFungibleToken.js';
import { NonFungibleTokenData } from '@alphabill/alphabill-js-sdk/lib/tokens/NonFungibleTokenData.js';
import { NonFungibleTokenType } from '@alphabill/alphabill-js-sdk/lib/tokens/NonFungibleTokenType.js';
import { TokenPartitionUnitType } from '@alphabill/alphabill-js-sdk/lib/tokens/TokenPartitionUnitType.js';
import { CreateNonFungibleToken } from '@alphabill/alphabill-js-sdk/lib/tokens/transactions/CreateNonFungibleToken.js';
import { CreateNonFungibleTokenType } from '@alphabill/alphabill-js-sdk/lib/tokens/transactions/CreateNonFungibleTokenType.js';
import { UpdateNonFungibleToken } from '@alphabill/alphabill-js-sdk/lib/tokens/transactions/UpdateNonFungibleToken.js';
import { UnitIdWithType } from '@alphabill/alphabill-js-sdk/lib/tokens/UnitIdWithType.js';
import { ClientMetadata } from '@alphabill/alphabill-js-sdk/lib/transaction/ClientMetadata.js';
import { AlwaysFalsePredicate } from '@alphabill/alphabill-js-sdk/lib/transaction/predicates/AlwaysFalsePredicate.js';
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
    private readonly tokenClient: TokenPartitionJsonRpcClient,
    private readonly networkId: number,
    private readonly partitionId: number,
    private readonly proofFactory: IProofFactory,
    private readonly alwaysTrueProofFactory: IProofFactory,
    private readonly feeCreditRecordId: IUnitId,
    private readonly nftId: IUnitId,
  ) {}

  public static async create(
    signingService: ISigningService,
    tokenPartitionUrl: string,
    tokenPartitionId: number,
    networkId: number,
  ): Promise<AlphabillClient> {
    logger.info('Initializing Alphabill client...');
    const tokenClient = createTokenClient({ transport: http(tokenPartitionUrl) });
    const proofFactory = new PayToPublicKeyHashProofFactory(signingService);
    const alwaysTrueProofFactory = new AlwaysTrueProofFactory();

    const units = await tokenClient.getUnitsByOwnerId(signingService.publicKey);

    logger.info('Checking Fee Credit Record');
    const feeCredits = units.feeCreditRecords;
    if (feeCredits.length == 0) {
      throw new Error('No fee credits found.');
    }
    const feeCreditRecordId = feeCredits.at(0)!;
    logger.info(`Fee Credit Record: ${feeCreditRecordId}`);

    logger.info('Checking NFT Type');
    const tokenTypeUnitId = new UnitIdWithType(
      new Uint8Array([1, 2, 3, 5]),
      TokenPartitionUnitType.NON_FUNGIBLE_TOKEN_TYPE,
    );
    const nftType = await tokenClient.getUnit(tokenTypeUnitId, false, NonFungibleTokenType);
    if (nftType !== null) {
      logger.info(`NFT type already exists with unit ID ${tokenTypeUnitId}.`);
    } else {
      logger.info(`Creating NFT type with unit ID ${tokenTypeUnitId}.`);
      const round = (await tokenClient.getRoundInfo()).roundNumber;

      const createNonFungibleTokenTypeTransactionOrder = await CreateNonFungibleTokenType.create({
        icon: { data: new Uint8Array(), type: 'image/png' },
        metadata: new ClientMetadata(round + 60n, 5n, feeCreditRecordId, null),
        name: 'Unicity Trust Anchor',
        networkIdentifier: networkId,
        parentTypeId: null,
        partitionIdentifier: tokenPartitionId,
        stateLock: null,
        stateUnlock: null,
        symbol: 'Unicity',
        typeId: tokenTypeUnitId,
        version: 1n,
        subTypeCreationPredicate: new AlwaysFalsePredicate(),
        tokenMintingPredicate: new AlwaysTruePredicate(),
        tokenTypeOwnerPredicate: new AlwaysTruePredicate(),
        dataUpdatePredicate: new AlwaysTruePredicate(),
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
    }

    logger.info('Checking if NFT exists');
    let nftID: IUnitId | undefined;
    for (const unitId of units.nonFungibleTokens) {
      const nft = await tokenClient.getUnit(unitId, false, NonFungibleToken);
      if (nft) {
        logger.debug(`Wallet has NFT: ${nft.unitId} of type ${nft.typeId}`);
        if (tokenTypeUnitId.equals(nft.typeId)) {
          nftID = unitId;
          break;
        }
      }
    }

    if (nftID) {
      logger.info(`NFT already exists (ID=${nftID}), skipping initial Alphabill setup.`);
      return new AlphabillClient(
        tokenClient,
        networkId,
        tokenPartitionId,
        proofFactory,
        alwaysTrueProofFactory,
        feeCreditRecordId,
        nftID,
      );
    }

    logger.info(`Minting new NFT.`);
    const round = (await tokenClient.getRoundInfo()).roundNumber;
    const createNonFungibleTokenTransactionOrder = await CreateNonFungibleToken.create({
      data: NonFungibleTokenData.create(new Uint8Array()),
      metadata: new ClientMetadata(round + 60n, 5n, feeCreditRecordId, null),
      name: 'Unicity Trust Anchor',
      networkIdentifier: networkId,
      nonce: 0n,
      partitionIdentifier: tokenPartitionId,
      stateLock: null,
      stateUnlock: null,
      typeId: tokenTypeUnitId,
      uri: 'https://github.com/unicitynetwork',
      version: 1n,
      dataUpdatePredicate: PayToPublicKeyHashPredicate.create(signingService.publicKey),
      ownerPredicate: PayToPublicKeyHashPredicate.create(signingService.publicKey),
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
    nftID = createNonFungibleTokenProof.transactionRecord.transactionOrder.payload.unitId;
    logger.info(`Alphabill client setup successful, NFT ID: ${nftID}.`);
    return new AlphabillClient(
      tokenClient,
      networkId,
      tokenPartitionId,
      proofFactory,
      alwaysTrueProofFactory,
      feeCreditRecordId,
      nftID,
    );
  }

  public async submitHash(transactionHash: DataHash): Promise<SubmitHashResponse> {
    const token = await this.tokenClient.getUnit(this.nftId, false, NonFungibleToken);
    if (!token) {
      throw new Error('NFT not found.');
    }
    const round = (await this.tokenClient.getRoundInfo()).roundNumber;
    const updateNonFungibleTokenTransactionOrder = await UpdateNonFungibleToken.create({
      data: NonFungibleTokenData.create(transactionHash.imprint),
      metadata: new ClientMetadata(round + 60n, 5n, this.feeCreditRecordId, null),
      networkIdentifier: this.networkId,
      partitionIdentifier: this.partitionId,
      stateLock: null,
      stateUnlock: null,
      token: token,
      version: 1n,
    }).sign(this.proofFactory, this.proofFactory, [this.alwaysTrueProofFactory]);
    const updateNonFungibleTokenHash = await this.tokenClient.sendTransaction(updateNonFungibleTokenTransactionOrder);

    const waitProofStartTime = Date.now();
    const updateNonFungibleTokenProof = await this.tokenClient.waitTransactionProof(
      updateNonFungibleTokenHash,
      UpdateNonFungibleToken,
    );
    const waitProofDuration = Date.now() - waitProofStartTime;
    logger.info(`Waited for transaction proof (took ${waitProofDuration}ms)`);

    const updateNftTxStatus = updateNonFungibleTokenProof.transactionRecord.serverMetadata.successIndicator;
    logger.info(`Update NFT transaction status - ${TransactionStatus[updateNftTxStatus]}.`);
    return new SubmitHashResponse(token.data, updateNonFungibleTokenProof);
  }
}
