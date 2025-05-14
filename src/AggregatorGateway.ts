import http from 'http';
import https from 'https';
import { existsSync, readFileSync } from 'node:fs';
import { Server } from 'node:http';
import os from 'node:os';

import { DefaultSigningService } from '@alphabill/alphabill-js-sdk/lib/signing/DefaultSigningService.js';
import { Authenticator } from '@unicitylabs/commons/lib/api/Authenticator.js';
import { RequestId } from '@unicitylabs/commons/lib/api/RequestId.js';
import { DataHash } from '@unicitylabs/commons/lib/hash/DataHash.js';
import { HashAlgorithm } from '@unicitylabs/commons/lib/hash/HashAlgorithm.js';
import { SparseMerkleTree } from '@unicitylabs/commons/lib/smt/SparseMerkleTree.js';
import { HexConverter } from '@unicitylabs/commons/lib/util/HexConverter.js';
import bodyParser from 'body-parser';
import cors from 'cors';
import express, { Request, Response } from 'express';

import { AggregatorService } from './AggregatorService.js';
import { AggregatorStorage } from './AggregatorStorage.js';
import { Commitment } from './commitment/Commitment.js';
import { AlphabillClient } from './consensus/alphabill/AlphabillClient.js';
import { IAlphabillClient } from './consensus/alphabill/IAlphabillClient.js';
import { LeaderElection } from './highAvailability/LeaderElection.js';
import { LeadershipStorage } from './highAvailability/LeadershipStorage.js';
import logger from './logger.js';
import { BlockRecords } from './records/BlockRecords.js';
import { IBlockRecordsStorage } from './records/IBlockRecordsStorage.js';
import { RoundManager } from './RoundManager.js';
import { ISmtStorage } from './smt/ISmtStorage.js';
import { Smt } from './smt/Smt.js';
import { SmtNode } from './smt/SmtNode.js';
import { SubmitCommitmentStatus } from './SubmitCommitmentResponse.js';
import { MockAlphabillClient } from '../tests/consensus/alphabill/MockAlphabillClient.js';

export interface IGatewayConfig {
  aggregatorConfig?: IAggregatorConfig;
  alphabill?: IAlphabillConfig;
  highAvailability?: IHighAvailabilityConfig;
  storage?: IStorageConfig;
}

export interface IAggregatorConfig {
  chainId?: number;
  version?: number;
  forkId?: number;
  initialBlockHash?: string;
  sslCertPath?: string;
  sslKeyPath?: string;
  port?: number;
  concurrencyLimit?: number;
  serverId?: string;
  blockCreationWaitTime?: number;
}

export interface IAlphabillConfig {
  useMock?: boolean;
  privateKey?: string;
  tokenPartitionUrl?: string;
  tokenPartitionId?: number;
  networkId?: number;
}

export interface IHighAvailabilityConfig {
  enabled?: boolean;
  lockTtlSeconds?: number;
  leaderHeartbeatInterval?: number;
  leaderElectionPollingInterval?: number;
}

export interface IStorageConfig {
  uri?: string;
}

interface IJsonRpcError {
  jsonrpc: string;
  error: {
    code: number;
    message: string;
    data?: unknown;
  };
  id: string | number | null;
}

export class AggregatorGateway {
  private static blockCreationActive = false;
  private static blockCreationTimer: NodeJS.Timeout | null = null;
  private serverId: string;
  private server: Server;
  private leaderElection: LeaderElection | null;
  private roundManager: RoundManager;
  private blockRecordsStorage: IBlockRecordsStorage;
  private smtStorage: ISmtStorage;
  private smt: Smt;

  private constructor(
    serverId: string,
    server: Server,
    leaderElection: LeaderElection | null,
    roundManager: RoundManager,
    blockRecordsStorage: IBlockRecordsStorage,
    smtStorage: ISmtStorage,
    smt: Smt,
  ) {
    this.serverId = serverId;
    this.server = server;
    this.leaderElection = leaderElection;
    this.roundManager = roundManager;
    this.blockRecordsStorage = blockRecordsStorage;
    this.smtStorage = smtStorage;
    this.smt = smt;

    this.setupBlockRecordsChangeListener();
  }

  public static async create(config: IGatewayConfig = {}): Promise<AggregatorGateway> {
    config = {
      aggregatorConfig: {
        chainId: config.aggregatorConfig?.chainId ?? 1,
        version: config.aggregatorConfig?.version ?? 1,
        forkId: config.aggregatorConfig?.forkId ?? 1,
        initialBlockHash:
          config.aggregatorConfig?.initialBlockHash ??
          '185f8db32271fe25f561a6fc938b2e264306ec304eda518007d1764826381969',
        port: config.aggregatorConfig?.port ?? 80,
        sslCertPath: config.aggregatorConfig?.sslCertPath ?? '',
        sslKeyPath: config.aggregatorConfig?.sslKeyPath ?? '',
        concurrencyLimit: config.aggregatorConfig?.concurrencyLimit ?? 100,
        serverId: config.aggregatorConfig?.serverId,
        blockCreationWaitTime: config.aggregatorConfig?.blockCreationWaitTime ?? 10000,
      },
      highAvailability: {
        enabled: config.highAvailability?.enabled !== false,
        lockTtlSeconds: config.highAvailability?.lockTtlSeconds ?? 30,
        leaderHeartbeatInterval: config.highAvailability?.leaderHeartbeatInterval ?? 10000,
        leaderElectionPollingInterval: config.highAvailability?.leaderElectionPollingInterval ?? 5000,
      },
      alphabill: {
        useMock: config.alphabill?.useMock ?? false,
        networkId: config.alphabill?.networkId,
        tokenPartitionId: config.alphabill?.tokenPartitionId,
        tokenPartitionUrl: config.alphabill?.tokenPartitionUrl,
        privateKey: config.alphabill?.privateKey,
      },
      storage: {
        uri: config.storage?.uri ?? 'mongodb://localhost:27017/',
      },
    };

    const serverId = config.aggregatorConfig!.serverId || `${os.hostname()}-${process.pid}`;
    const mongoUri = config.storage?.uri ?? 'mongodb://localhost:27017/';
    const storage = await AggregatorStorage.init(mongoUri);

    const alphabillClient = await AggregatorGateway.setupAlphabillClient(config.alphabill!, serverId);
    const smt = await AggregatorGateway.setupSmt(storage.smtStorage, serverId);
    const roundManager = new RoundManager(
      config.aggregatorConfig!,
      alphabillClient,
      smt,
      storage.blockStorage,
      storage.recordStorage,
      storage.blockRecordsStorage,
      storage.commitmentStorage,
      storage.smtStorage,
    );
    const aggregatorService = new AggregatorService(
      roundManager,
      smt,
      storage.recordStorage,
      storage.blockStorage,
      storage.blockRecordsStorage,
    );

    let leaderElection: LeaderElection | null = null;
    if (config.highAvailability?.enabled) {
      const { leaderHeartbeatInterval, leaderElectionPollingInterval, lockTtlSeconds } = config.highAvailability;
      const leadershipStorage = new LeadershipStorage(lockTtlSeconds!);

      leaderElection = new LeaderElection(leadershipStorage, {
        heartbeatInterval: leaderHeartbeatInterval!,
        electionPollingInterval: leaderElectionPollingInterval!,
        lockTtlSeconds: lockTtlSeconds!,
        lockId: 'aggregator_leader_lock',
        onBecomeLeader(): void {
          return AggregatorGateway.onBecomeLeader(serverId, roundManager);
        },
        onLoseLeadership(): void {
          return AggregatorGateway.onLoseLeadership(serverId);
        },
        serverId: serverId,
      });
    } else {
      logger.info('High availability mode is disabled.');
      AggregatorGateway.blockCreationActive = true;
      AggregatorGateway.startNextBlock(roundManager);
    }
    const app = express();
    AggregatorGateway.setupRouter(
      app,
      config,
      aggregatorService,
      serverId,
      leaderElection,
      config.aggregatorConfig!.concurrencyLimit!,
    );

    if (config.aggregatorConfig?.concurrencyLimit) {
      logger.info(`Concurrency limiting enabled: Max ${config.aggregatorConfig.concurrencyLimit} concurrent requests`);
    }

    const { sslCertPath, sslKeyPath, port } = config.aggregatorConfig!;

    const server =
      sslCertPath && sslKeyPath && existsSync(sslCertPath) && existsSync(sslKeyPath)
        ? https.createServer({ cert: readFileSync(sslCertPath), key: readFileSync(sslKeyPath) }, app)
        : http.createServer(app);

    server.listen(port, () => {
      const protocol = server instanceof https.Server ? 'HTTPS' : 'HTTP';
      logger.info(`Unicity Aggregator (${protocol}) listening on port ${port} with server ID ${serverId}`);
    });

    if (config.highAvailability?.enabled && leaderElection) {
      await leaderElection.start();
      logger.info(`Leader election process started for server ${serverId}.`);
    }

    return new AggregatorGateway(
      serverId,
      server,
      leaderElection,
      roundManager,
      storage.blockRecordsStorage,
      storage.smtStorage,
      smt,
    );
  }

  private static onBecomeLeader(aggregatorServerId: string, roundManager: RoundManager): void {
    logger.info(`Server ${aggregatorServerId} became the leader.`);
    AggregatorGateway.blockCreationActive = true;
    AggregatorGateway.startNextBlock(roundManager);
  }

  private static onLoseLeadership(aggregatorServerId: string): void {
    logger.info(`Server ${aggregatorServerId} lost leadership.`);
    AggregatorGateway.blockCreationActive = false;
    if (AggregatorGateway.blockCreationTimer) {
      clearTimeout(AggregatorGateway.blockCreationTimer);
      AggregatorGateway.blockCreationTimer = null;
    }
  }

  private static async setupAlphabillClient(
    config: IAlphabillConfig,
    aggregatorServerId: string,
  ): Promise<IAlphabillClient> {
    const { useMock, privateKey, tokenPartitionUrl, tokenPartitionId, networkId } = config;
    if (useMock) {
      logger.info(`Server ${aggregatorServerId} using mock AlphabillClient.`);
      return new MockAlphabillClient();
    }
    logger.info(`Server ${aggregatorServerId} using real AlphabillClient.`);
    if (!privateKey) {
      throw new Error('Alphabill private key must be defined in hex encoding.');
    }
    const signingService = new DefaultSigningService(HexConverter.decode(privateKey));
    if (!tokenPartitionUrl) {
      throw new Error('Alphabill token partition URL must be defined.');
    }
    if (!tokenPartitionId) {
      throw new Error('Alphabill token partition ID must be defined.');
    }
    if (!networkId) {
      throw new Error('Alphabill network ID must be defined.');
    }
    return await AlphabillClient.create(signingService, tokenPartitionUrl, tokenPartitionId, networkId);
  }

  private static setupRouter(
    app: express.Application,
    config: IGatewayConfig,
    aggregatorService: AggregatorService,
    serverId: string,
    leaderElection: LeaderElection | null,
    maxConcurrentRequests: number,
  ): void {
    let activeRequests = 0;
    app.use(cors());
    app.use(bodyParser.json());

    app.get('/health', (req: Request, res: Response) => {
      res.status(200).json({
        status: 'ok',
        role:
          config.highAvailability?.enabled !== false
            ? leaderElection && leaderElection.isCurrentLeader()
              ? 'leader'
              : 'follower'
            : 'standalone',
        serverId: serverId,
        activeRequests: activeRequests,
        maxConcurrentRequests: maxConcurrentRequests,
        smtRootHash: aggregatorService.getSmt().rootHash.toString(),
      });
    });

    app.post('/', async (req: Request, res: Response) => {
      // Check if we're at capacity before processing the request
      if (config.aggregatorConfig?.concurrencyLimit && activeRequests >= maxConcurrentRequests) {
        logger.warn(`Concurrency limit reached (${activeRequests}/${maxConcurrentRequests}). Request rejected.`);
        AggregatorGateway.sendJsonRpcError(
          res,
          503,
          -32000,
          'Server is at capacity. Please try again later.',
          req.body?.id || null,
        );
        return;
      }

      if (config.aggregatorConfig?.concurrencyLimit) {
        activeRequests++;
        let countDecremented = false;

        // decrement counter only once
        const decrementCounter = (): void => {
          if (!countDecremented) {
            countDecremented = true;
            activeRequests--;
          }
        };

        // Listen for normal completion
        res.on('finish', decrementCounter);

        // Also listen for abrupt connection close
        res.on('close', decrementCounter);
      }

      if (!aggregatorService) {
        AggregatorGateway.sendJsonRpcError(res, 500, -32603, 'Internal error: Service not initialized.', req.body.id);
        return;
      }

      if (req.body.jsonrpc !== '2.0' || !req.body.params) {
        AggregatorGateway.sendJsonRpcError(
          res,
          400,
          -32600,
          'Invalid Request: Not a valid JSON-RPC 2.0 request',
          req.body.id,
        );
        return;
      }

      try {
        switch (req.body.method) {
          case 'submit_commitment':
            await AggregatorGateway.handleSubmitCommitment(req, res, aggregatorService);
            break;
          case 'get_inclusion_proof':
            await AggregatorGateway.handleGetInclusionProof(req, res, aggregatorService);
            break;
          case 'get_no_deletion_proof':
            await AggregatorGateway.handleGetNoDeletionProof(req, res, aggregatorService);
            break;
          case 'get_block_height':
            await AggregatorGateway.handleGetBlockHeight(req, res, aggregatorService);
            break;
          case 'get_block':
            await AggregatorGateway.handleGetBlock(req, res, aggregatorService);
            break;
          case 'get_block_commitments':
            await AggregatorGateway.handleGetBlockCommitments(req, res, aggregatorService);
            break;
          default:
            res.sendStatus(400);
            break;
        }
      } catch (error) {
        logger.error(`Error processing ${req.body.method}:`, error);
        AggregatorGateway.sendJsonRpcError(
          res,
          500,
          -32603,
          `Internal error: ${error instanceof Error ? error.message : 'Unknown error'}`,
          req.body.id,
        );
      }
    });
  }

  private static sendJsonRpcError(
    res: Response,
    httpStatus: number,
    errorCode: number,
    message: string,
    id: string | number | null,
    data?: unknown,
  ): void {
    const errorResponse: IJsonRpcError = {
      jsonrpc: '2.0',
      error: {
        code: errorCode,
        message: message,
      },
      id: id,
    };

    if (data !== undefined) {
      errorResponse.error.data = data;
    }

    res.status(httpStatus).json(errorResponse);
  }

  private static async handleSubmitCommitment(
    req: Request,
    res: Response,
    aggregatorService: AggregatorService,
  ): Promise<void> {
    logger.info(`Received submit_commitment request: ${req.body.params.requestId}`);

    const missingFields = [];
    if (!req.body.params.requestId) missingFields.push('requestId');
    if (!req.body.params.transactionHash) missingFields.push('transactionHash');
    if (!req.body.params.authenticator) missingFields.push('authenticator');

    if (missingFields.length > 0) {
      AggregatorGateway.sendJsonRpcError(
        res,
        400,
        -32602,
        `Invalid parameters: Missing required fields: ${missingFields.join(', ')}`,
        req.body.id,
      );
      return;
    }

    let commitment: Commitment;
    try {
      const requestId: RequestId = RequestId.fromDto(req.body.params.requestId);
      const transactionHash: DataHash = DataHash.fromDto(req.body.params.transactionHash);
      const authenticator: Authenticator = Authenticator.fromDto(req.body.params.authenticator);
      commitment = new Commitment(requestId, transactionHash, authenticator);
    } catch (error) {
      AggregatorGateway.sendJsonRpcError(
        res,
        400,
        -32602,
        'Invalid parameters: Could not create commitment',
        req.body.id,
        { details: error instanceof Error ? error.message : 'Unknown error' },
      );
      return;
    }
    const response = await aggregatorService.submitCommitment(commitment);
    if (response.status !== SubmitCommitmentStatus.SUCCESS) {
      AggregatorGateway.sendJsonRpcError(
        res,
        400,
        -32000,
        'Failed to submit commitment',
        req.body.id,
        response.toDto(),
      );
      return;
    }
    res.json({
      jsonrpc: '2.0',
      result: response.toDto(),
      id: req.body.id,
    });
  }

  private static async handleGetInclusionProof(
    req: Request,
    res: Response,
    aggregatorService: AggregatorService,
  ): Promise<void> {
    logger.info(`Received get_inclusion_proof request: ${req.body.params.requestId}`);

    if (!req.body.params.requestId) {
      AggregatorGateway.sendJsonRpcError(
        res,
        400,
        -32602,
        'Invalid parameters: Missing required field: requestId',
        req.body.id,
      );
      return;
    }

    let requestId: RequestId;
    try {
      requestId = RequestId.fromDto(req.body.params.requestId);
    } catch (error) {
      AggregatorGateway.sendJsonRpcError(
        res,
        400,
        -32602,
        'Invalid parameters: Invalid requestId format',
        req.body.id,
        { details: error instanceof Error ? error.message : 'Unknown error' },
      );
      return;
    }

    const inclusionProof = await aggregatorService.getInclusionProof(requestId);
    if (inclusionProof == null) {
      AggregatorGateway.sendJsonRpcError(res, 404, -32001, 'Inclusion proof not found', req.body.id);
      return;
    }
    res.json({
      jsonrpc: '2.0',
      result: inclusionProof.toDto(),
      id: req.body.id,
    });
  }

  private static async handleGetNoDeletionProof(
    req: Request,
    res: Response,
    aggregatorService: AggregatorService,
  ): Promise<void> {
    const noDeletionProof = await aggregatorService.getNodeletionProof();
    if (noDeletionProof == null) {
      AggregatorGateway.sendJsonRpcError(res, 404, -32001, 'No deletion proof not found', req.body.id);
      return;
    }
    res.json({
      jsonrpc: '2.0',
      result: noDeletionProof,
      id: req.body.id,
    });
  }

  private static async handleGetBlockHeight(
    req: Request,
    res: Response,
    aggregatorService: AggregatorService,
  ): Promise<void> {
    logger.info('Received get_block_height request');
    const currentBlockNumber = await aggregatorService.getCurrentBlockNumber();
    res.json({
      jsonrpc: '2.0',
      result: { blockNumber: currentBlockNumber.toString() },
      id: req.body.id,
    });
  }

  private static async handleGetBlock(
    req: Request,
    res: Response,
    aggregatorService: AggregatorService,
  ): Promise<void> {
    logger.info(`Received get_block request: ${req.body.params.blockNumber}`);

    if (!req.body.params.blockNumber) {
      AggregatorGateway.sendJsonRpcError(res, 400, -32602, 'Invalid parameters: blockNumber is required', req.body.id);
      return;
    }

    let blockNumber;
    try {
      // Handle "latest" as a special case
      if (req.body.params.blockNumber === 'latest') {
        blockNumber = await aggregatorService.getCurrentBlockNumber();
      } else {
        blockNumber = BigInt(req.body.params.blockNumber);
      }
    } catch {
      AggregatorGateway.sendJsonRpcError(
        res,
        400,
        -32602,
        'Invalid parameters: blockNumber must be a valid number or "latest"',
        req.body.id,
      );
      return;
    }

    const block = await aggregatorService.getBlockByNumber(blockNumber);

    if (!block) {
      AggregatorGateway.sendJsonRpcError(res, 404, -32001, `Block ${blockNumber.toString()} not found`, req.body.id);
      return;
    }

    res.json({
      jsonrpc: '2.0',
      result: {
        index: block.index.toString(),
        chainId: block.chainId,
        version: block.version,
        forkId: block.forkId,
        timestamp: block.timestamp.toString(),
        rootHash: block.rootHash.toDto(),
        previousBlockHash: HexConverter.encode(block.previousBlockHash),
        noDeletionProofHash: block.noDeletionProofHash ? HexConverter.encode(block.noDeletionProofHash) : null,
      },
      id: req.body.id,
    });
  }

  private static async handleGetBlockCommitments(
    req: Request,
    res: Response,
    aggregatorService: AggregatorService,
  ): Promise<void> {
    logger.info(`Received get_block_commitments request: ${req.body.params.blockNumber}`);

    if (!req.body.params.blockNumber) {
      AggregatorGateway.sendJsonRpcError(res, 400, -32602, 'Invalid parameters: blockNumber is required', req.body.id);
      return;
    }

    let blockNumber;
    try {
      blockNumber = BigInt(req.body.params.blockNumber);
    } catch {
      AggregatorGateway.sendJsonRpcError(
        res,
        400,
        -32602,
        'Invalid parameters: blockNumber must be a valid number',
        req.body.id,
      );
      return;
    }

    const commitments = await aggregatorService.getCommitmentsByBlockNumber(blockNumber);

    if (commitments === null) {
      AggregatorGateway.sendJsonRpcError(res, 404, -32001, `Block ${blockNumber.toString()} not found`, req.body.id);
      return;
    }

    res.json({
      jsonrpc: '2.0',
      result: commitments.map((commitment) => ({
        requestId: commitment.requestId.toDto(),
        transactionHash: commitment.transactionHash.toDto(),
        authenticator: commitment.authenticator.toDto(),
      })),
      id: req.body.id,
    });
  }

  private static async setupSmt(smtStorage: ISmtStorage, aggregatorServerId: string): Promise<Smt> {
    const smt = await SparseMerkleTree.create(HashAlgorithm.SHA256);
    const smtLeaves = await smtStorage.getAll();
    if (smtLeaves.length > 0) {
      logger.info(`Server ${aggregatorServerId} found ${smtLeaves.length} leaves from storage.`);
      logger.info('Constructing tree...');
      for (const leaf of smtLeaves) {
        await smt.addLeaf(leaf.path, leaf.value);
      }
      logger.info(`Tree with root hash ${smt.rootHash.toString()} constructed successfully.`);
    }
    return new Smt(smt);
  }

  private static startNextBlock(roundManager: RoundManager): void {
    if (!AggregatorGateway.blockCreationActive) {
      return;
    }

    // Clear any existing timer to prevent concurrent block creation
    if (AggregatorGateway.blockCreationTimer) {
      clearTimeout(AggregatorGateway.blockCreationTimer);
      AggregatorGateway.blockCreationTimer = null;
    }

    const time = Date.now();
    AggregatorGateway.blockCreationTimer = setTimeout(
      async () => {
        try {
          if (AggregatorGateway.blockCreationActive) {
            await roundManager.createBlock();

            // Only start next block if we're still active
            if (AggregatorGateway.blockCreationActive) {
              AggregatorGateway.startNextBlock(roundManager);
            }
          }
        } catch (error) {
          logger.error('Failed to create block:', error);

          if (AggregatorGateway.blockCreationActive) {
            AggregatorGateway.blockCreationTimer = setTimeout(() => {
              if (AggregatorGateway.blockCreationActive) {
                AggregatorGateway.startNextBlock(roundManager);
              }
            }, 1000); // 1 second delay before retrying
          }
        }
      },
      Math.ceil(time / 1000) * 1000 - time,
    );
  }

  /**
   * Stop the services started by aggregator.
   */
  public async stop(): Promise<void> {
    logger.info('Stopping aggregator gateway...');

    const isBlockCreationInProgress = AggregatorGateway.blockCreationActive && AggregatorGateway.blockCreationTimer;
    AggregatorGateway.blockCreationActive = false;

    // Wait for any in-progress block creation to complete
    if (isBlockCreationInProgress) {
      logger.info('Waiting for any block creation to complete before shutdown...');
      const blockCreationWaitTime = this.roundManager.config.blockCreationWaitTime ?? 10000;
      await new Promise<void>((resolve) => setTimeout(resolve, blockCreationWaitTime));
    }

    await this.blockRecordsStorage.stopWatchingChanges();

    await this.leaderElection?.shutdown();
    this.server?.close();

    if (AggregatorGateway.blockCreationTimer) {
      clearTimeout(AggregatorGateway.blockCreationTimer);
      AggregatorGateway.blockCreationTimer = null;
    }

    logger.info('Aggregator gateway stopped successfully');
  }

  /**
   * Check if this instance is the current leader.
   */
  public isLeader(): boolean {
    return this.leaderElection ? this.leaderElection.isCurrentLeader() : true;
  }

  /**
   * Get the server ID of this instance.
   */
  public getServerId(): string {
    return this.serverId;
  }

  /**
   * Returns the RoundManager instance.
   */
  public getRoundManager(): RoundManager {
    return this.roundManager;
  }

  private async setupBlockRecordsChangeListener(): Promise<void> {
    await this.blockRecordsStorage.startWatchingChanges();

    this.blockRecordsStorage.addChangeListener(async (blockRecords: BlockRecords) => {
      // Skip if this node is the leader (leader already has the latest data)
      if (this.isLeader()) {
        logger.debug('Ignoring BlockRecords change as this node is the leader');
        return;
      }

      if (blockRecords.requestIds.length === 0) {
        logger.debug(`BlockRecords for block ${blockRecords.blockNumber} has no requestIds, skipping SMT update`);
        return;
      }

      logger.info(
        `Follower node received BlockRecords change for block ${blockRecords.blockNumber} with ${blockRecords.requestIds.length} requestIds`,
      );

      const paths = blockRecords.requestIds.map((id: RequestId) => id.toBigInt());

      const maxRetries = 5;
      let retryCount = 0;
      let leaves: SmtNode[] = [];

      while (retryCount < maxRetries) {
        leaves = await this.smtStorage.getByPaths(paths);

        if (leaves.length === paths.length) {
          break;
        }

        logger.warn(
          `Only retrieved ${leaves.length}/${paths.length} SMT leaves for block ${blockRecords.blockNumber}. ` +
            `Retrying (${retryCount + 1}/${maxRetries})...`,
        );

        await new Promise((resolve) => setTimeout(resolve, 1000 * Math.pow(2, retryCount)));
        retryCount++;
      }

      if (leaves.length !== paths.length) {
        const errorMessage =
          `Failed to retrieve all SMT leaves after ${maxRetries} retries. ` +
          `Got ${leaves.length}/${paths.length} leaves for block ${blockRecords.blockNumber}. `;
        throw new Error(errorMessage);
      }

      logger.info(
        `Retrieved ${leaves.length} SMT leaves for block ${blockRecords.blockNumber}, updating in-memory SMT`,
      );

      const leavesToAdd = leaves.map((leaf) => ({
        path: leaf.path,
        value: leaf.value,
      }));

      await this.smt.addLeaves(leavesToAdd);

      logger.info(`Updated in-memory SMT for follower node, new root hash: ${this.smt.rootHash.toString()}`);
    });

    logger.info(`BlockRecords change listener initialized for server ${this.serverId}`);
  }
}
