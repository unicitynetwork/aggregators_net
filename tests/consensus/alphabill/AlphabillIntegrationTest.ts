import { SetFeeCredit } from '@alphabill/alphabill-js-sdk/lib/fees/transactions/SetFeeCredit.js';
import { DefaultSigningService } from '@alphabill/alphabill-js-sdk/lib/signing/DefaultSigningService.js';
import { createTokenClient, http } from '@alphabill/alphabill-js-sdk/lib/StateApiClientFactory.js';
import { NonFungibleTokenData } from '@alphabill/alphabill-js-sdk/lib/tokens/NonFungibleTokenData.js';
import { TokenPartitionUnitType } from '@alphabill/alphabill-js-sdk/lib/tokens/TokenPartitionUnitType.js';
import { CreateNonFungibleToken } from '@alphabill/alphabill-js-sdk/lib/tokens/transactions/CreateNonFungibleToken.js';
import { CreateNonFungibleTokenType } from '@alphabill/alphabill-js-sdk/lib/tokens/transactions/CreateNonFungibleTokenType.js';
import { UnitIdWithType } from '@alphabill/alphabill-js-sdk/lib/tokens/UnitIdWithType.js';
import { ClientMetadata } from '@alphabill/alphabill-js-sdk/lib/transaction/ClientMetadata.js';
import { AlwaysFalsePredicate } from '@alphabill/alphabill-js-sdk/lib/transaction/predicates/AlwaysFalsePredicate.js';
import { AlwaysTruePredicate } from '@alphabill/alphabill-js-sdk/lib/transaction/predicates/AlwaysTruePredicate.js';
import { PayToPublicKeyHashPredicate } from '@alphabill/alphabill-js-sdk/lib/transaction/predicates/PayToPublicKeyHashPredicate.js';
import { AlwaysTrueProofFactory } from '@alphabill/alphabill-js-sdk/lib/transaction/proofs/AlwaysTrueProofFactory.js';
import { PayToPublicKeyHashProofFactory } from '@alphabill/alphabill-js-sdk/lib/transaction/proofs/PayToPublicKeyHashProofFactory.js';
import { TransactionStatus } from '@alphabill/alphabill-js-sdk/lib/transaction/record/TransactionStatus.js';
import { Base16Converter } from '@alphabill/alphabill-js-sdk/lib/util/Base16Converter.js';
import { Authenticator } from '@unicitylabs/commons/lib/api/Authenticator.js';
import { InclusionProof } from '@unicitylabs/commons/lib/api/InclusionProof.js';
import { RequestId } from '@unicitylabs/commons/lib/api/RequestId.js';
import { SubmitCommitmentStatus } from '@unicitylabs/commons/lib/api/SubmitCommitmentResponse.js';
import { DataHash } from '@unicitylabs/commons/lib/hash/DataHash.js';
import { DataHasher } from '@unicitylabs/commons/lib/hash/DataHasher.js';
import { HashAlgorithm } from '@unicitylabs/commons/lib/hash/HashAlgorithm.js';
import { SigningService } from '@unicitylabs/commons/lib/signing/SigningService.js';
import { HexConverter } from '@unicitylabs/commons/lib/util/HexConverter.js';
import { DockerComposeEnvironment, StartedDockerComposeEnvironment, Wait } from 'testcontainers';

import { AggregatorGateway } from '../../../src/AggregatorGateway.js';
import logger from '../../../src/logger.js';
import { connectToSharedMongo, clearAllCollections, sendCommitment, sendGetInclusionProof, disconnectFromSharedMongo, createGatewayConfig } from '../../TestUtils.js';
import { Commitment } from '../../../src/commitment/Commitment.js';

describe('Alphabill Client Integration Tests', () => {
  const composeFilePath = 'tests';
  const composeAlphabill = 'consensus/alphabill/docker/alphabill-docker-compose.yml';

  const privateKey = '1DE87F189C3C9E42F93C90C95E2AC761BE9D0EB2FD1CA0FF3A9CE165C3DE96A9';
  const alphabillSigningService = new DefaultSigningService(Base16Converter.decode(privateKey));
  const proofFactory = new PayToPublicKeyHashProofFactory(alphabillSigningService);
  const tokenPartitionUrl = 'http://localhost:11003/rpc';
  const networkId = 3;
  const tokenPartitionId = 5;
  const initialBlockHash = '185f8db32271fe25f561a6fc938b2e264306ec304eda518007d1764826381969';
  const aggregatorPort = 3333;

  let stateHash: DataHash;
  let transactionHash: DataHash;
  let requestId: RequestId;
  let aggregatorEnvironment: StartedDockerComposeEnvironment;
  let aggregator: AggregatorGateway;
  let unicitySigningService: SigningService;

  beforeAll(async () => {
    logger.info(
      'Setting up test environment with Alphabill root node, permissioned token partition node and shared MongoDB...',
    );
    
    // Connect to the global shared MongoDB replica set
    const mongoUri = await connectToSharedMongo();
    
    aggregatorEnvironment = await new DockerComposeEnvironment(composeFilePath, composeAlphabill)
      .withBuild()
      .withWaitStrategy('alphabill-permissioned-tokens-1', Wait.forHealthCheck())
      .withStartupTimeout(15000)
      .up();
    logger.info('Setup successful.');

    // Wait for Alphabill nodes to sync up
    await new Promise((resolve) => setTimeout(resolve, 5000));

    // Set fee credit
    logger.info('Setting fee credit...');
    const tokenClient = createTokenClient({ transport: http(tokenPartitionUrl) });
    const ownerPredicate = PayToPublicKeyHashPredicate.create(alphabillSigningService.publicKey);
    let round = (await tokenClient.getRoundInfo()).roundNumber;
    const setFeeCreditTransactionOrder = await SetFeeCredit.create({
      targetPartitionIdentifier: tokenPartitionId,
      ownerPredicate: ownerPredicate,
      amount: 100n,
      feeCreditRecord: { unitId: null, counter: null },
      version: 1n,
      networkIdentifier: networkId,
      partitionIdentifier: tokenPartitionId,
      stateLock: null,
      metadata: new ClientMetadata(round + 60n, 5n, null, null),
      stateUnlock: null,
    }).sign(proofFactory);
    const setFeeCreditHash = await tokenClient.sendTransaction(setFeeCreditTransactionOrder);
    const setFeeCreditProof = await tokenClient.waitTransactionProof(setFeeCreditHash, SetFeeCredit);
    expect(setFeeCreditProof.transactionRecord.serverMetadata.successIndicator).toEqual(TransactionStatus.Successful);
    const feeCreditRecordId = setFeeCreditProof.transactionRecord.serverMetadata.targetUnitIds.at(0)!;
    logger.info('Setting fee credit successful.');

    // Add some NFTs to the partition to make sure aggregator is not confused and uses the correct NFT
    const tokenTypeUnitId = new UnitIdWithType(new Uint8Array([42]), TokenPartitionUnitType.NON_FUNGIBLE_TOKEN_TYPE);
    // const nftType = await tokenClient.getUnit(tokenTypeUnitId, false, NonFungibleTokenType);
    round = (await tokenClient.getRoundInfo()).roundNumber;

    const createNonFungibleTokenTypeTransactionOrder = await CreateNonFungibleTokenType.create({
      icon: { data: new Uint8Array(0), type: 'image/png' },
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

    logger.info(`Minting new NFT.`);
    const alwaysTrueProofFactory = new AlwaysTrueProofFactory();
    round = (await tokenClient.getRoundInfo()).roundNumber;
    const createNonFungibleTokenTransactionOrder = await CreateNonFungibleToken.create({
      data: NonFungibleTokenData.create(new Uint8Array(0)),
      metadata: new ClientMetadata(round + 60n, 5n, feeCreditRecordId, null),
      name: 'Test',
      networkIdentifier: networkId,
      nonce: 0n,
      partitionIdentifier: tokenPartitionId,
      stateLock: null,
      stateUnlock: null,
      typeId: tokenTypeUnitId,
      uri: 'https://github.com/unicitynetwork',
      version: 1n,
      dataUpdatePredicate: PayToPublicKeyHashPredicate.create(alphabillSigningService.publicKey),
      ownerPredicate: PayToPublicKeyHashPredicate.create(alphabillSigningService.publicKey),
    }).sign(alwaysTrueProofFactory, proofFactory);
    const createNonFungibleTokenHash = await tokenClient.sendTransaction(createNonFungibleTokenTransactionOrder);
    const createNonFungibleTokenProof = await tokenClient.waitTransactionProof(
      createNonFungibleTokenHash,
      CreateNonFungibleToken,
    );
    const createNftTxStatus = createNonFungibleTokenProof.transactionRecord.serverMetadata.successIndicator;
    logger.info(`Create NFT transaction status - ${TransactionStatus[createNftTxStatus]}.`);

    logger.info('Starting aggregator...');
    const gatewayConfig = createGatewayConfig(aggregatorPort, 'test-server', mongoUri, {
      aggregatorConfig: {
        initialBlockHash: initialBlockHash,
        port: aggregatorPort,
      },
      alphabill: {
        privateKey: privateKey,
        networkId: networkId,
        tokenPartitionUrl: tokenPartitionUrl,
        tokenPartitionId: tokenPartitionId,
      },
    });
    
    aggregator = await AggregatorGateway.create(gatewayConfig);
    logger.info('Aggregator running.');
    stateHash = await new DataHasher(HashAlgorithm.SHA256).update(new Uint8Array([1, 2])).digest();
    transactionHash = await new DataHasher(HashAlgorithm.SHA256).update(new Uint8Array([1, 2])).digest();
    unicitySigningService = new SigningService(HexConverter.decode(privateKey));
    requestId = await RequestId.create(unicitySigningService.publicKey, stateHash);
  }, 60000);

  afterAll(async () => {
    logger.info('Stopping aggregator...');
    await aggregator.stop();
    logger.info('Stopping environment...');
    await aggregatorEnvironment.down();
    await clearAllCollections();
    await disconnectFromSharedMongo();
  }, 60000);

  it('Submit commitment to aggregator and wait for inclusion proof', async () => {
    const authenticator: Authenticator = await Authenticator.create(unicitySigningService, transactionHash, stateHash);

    const commitment = new Commitment(requestId, transactionHash, authenticator);
    const response = await sendCommitment(aggregatorPort, commitment, 1);
    expect(response.status).toEqual(200);
    expect(response.data.jsonrpc).toEqual('2.0');
    expect(response.data.id).toEqual(1);
    expect(response.data.result).toHaveProperty('status', SubmitCommitmentStatus.SUCCESS);
    logger.info('Submit commitment response: ' + JSON.stringify(response, null, 2));

    await new Promise((resolve) => setTimeout(resolve, 5000));

    const getInclusionProofResponse = await sendGetInclusionProof(aggregatorPort, requestId, 2);
    expect(getInclusionProofResponse.status).toEqual(200);
    expect(getInclusionProofResponse.data.jsonrpc).toEqual('2.0');
    expect(getInclusionProofResponse.data.id).toEqual(2);
    expect(getInclusionProofResponse.data).toHaveProperty('result');
    const inclusionProof = InclusionProof.fromJSON(getInclusionProofResponse.data.result);
    const verificationResult = await inclusionProof.verify(requestId.toBigInt());
    expect(verificationResult).toBeTruthy();
  }, 60000);

  it('Re-submit commitment to aggregator with same requestID but different state, expect error', async () => {
    const newStateHash = await new DataHasher(HashAlgorithm.SHA256).update(new Uint8Array([3, 4])).digest();
    const authenticator: Authenticator = await Authenticator.create(
      unicitySigningService,
      transactionHash,
      newStateHash,
    );

    const commitment = new Commitment(requestId, transactionHash, authenticator);
    const response = await sendCommitment(aggregatorPort, commitment, 3);
    expect(response.status).toEqual(400);
    expect(response.data.jsonrpc).toEqual('2.0');
    expect(response.data.id).toEqual(3);
    expect(response.data.error).not.toBeNull();
    expect(response.data.error!.code).toEqual(-32000);
    expect(response.data.error!.message).toEqual('Failed to submit commitment');
    expect(response.data.error!.data).not.toBeNull();
    expect(response.data.error!.data).toHaveProperty('status', SubmitCommitmentStatus.REQUEST_ID_MISMATCH);
    logger.info('Submit commitment error response: ' + JSON.stringify(response, null, 2));
  }, 60000);

  it('Validate first block hash is set to initial block hash', async () => {
    const firstBlock = await aggregator.getRoundManager().getBlockStorage().get(1n);
    expect(firstBlock!.index).toEqual(1n);
    expect(HexConverter.encode(firstBlock!.previousBlockHash)).toEqual(initialBlockHash);
  }, 60000);
});
