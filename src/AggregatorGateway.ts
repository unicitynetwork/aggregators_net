import http from 'http';
import https from 'https';
import { existsSync, readFileSync } from 'node:fs';
import { Server } from 'node:http';
import os from 'node:os';

import { DefaultSigningService } from '@alphabill/alphabill-js-sdk/lib/signing/DefaultSigningService.js';
import { HashAlgorithm } from '@unicitylabs/commons/lib/hash/HashAlgorithm.js';
import { SigningService } from '@unicitylabs/commons/lib/signing/SigningService.js';
import { SparseMerkleTree } from '@unicitylabs/commons/lib/smt/SparseMerkleTree.js';
import { HexConverter } from '@unicitylabs/commons/lib/util/HexConverter.js';

import { AggregatorService } from './AggregatorService.js';
import { AggregatorStorage } from './AggregatorStorage.js';
import { AlphabillClient } from './consensus/alphabill/AlphabillClient.js';
import { IAlphabillClient } from './consensus/alphabill/IAlphabillClient.js';
import { LeaderElection } from './highAvailability/LeaderElection.js';
import { LeadershipStorage } from './highAvailability/LeadershipStorage.js';
import logger from './logger.js';
import { BlockRecords } from './records/BlockRecords.js';
import { IBlockRecordsStorage } from './records/IBlockRecordsStorage.js';
import { RoundManager } from './RoundManager.js';
import { setupRouter } from './router/AggregatorRouter.js';
import { ISmtStorage } from './smt/ISmtStorage.js';
import { Smt } from './smt/Smt.js';
import { SmtNode } from './smt/SmtNode.js';
import { SubmitCommitmentStatus } from './SubmitCommitmentResponse.js';
import { MockAlphabillClient } from '../tests/consensus/alphabill/MockAlphabillClient.js';
import { ValidationService, IValidationService } from './ValidationService.js';

export interface IGatewayConfig {
  aggregatorConfig?: IAggregatorConfig;
  alphabill?: IAlphabillConfig;
  highAvailability?: IHighAvailabilityConfig;
  storage?: IStorageConfig;
  validationService?: IValidationService;
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
  private validationService: IValidationService | undefined;

  private constructor(
    serverId: string,
    server: Server,
    leaderElection: LeaderElection | null,
    roundManager: RoundManager,
    blockRecordsStorage: IBlockRecordsStorage,
    smtStorage: ISmtStorage,
    smt: Smt,
    validationService: IValidationService | undefined,
  ) {
    this.serverId = serverId;
    this.server = server;
    this.leaderElection = leaderElection;
    this.roundManager = roundManager;
    this.blockRecordsStorage = blockRecordsStorage;
    this.smtStorage = smtStorage;
    this.smt = smt;

    this.setupBlockRecordsChangeListener();
    this.validationService = validationService;
  }

  public static async create(config: IGatewayConfig = {}): Promise<AggregatorGateway> {
    const DEFAULT_MONGODB_URI = 'mongodb://localhost:27017/';
    const DEFAULT_TOKEN_PARTITION_URL = 'http://localhost:9001/rpc';
    const DEFAULT_INITIAL_BLOCK_HASH = '185f8db32271fe25f561a6fc938b2e264306ec304eda518007d1764826381969';

    config = {
      aggregatorConfig: {
        chainId: config.aggregatorConfig?.chainId ?? 1,
        version: config.aggregatorConfig?.version ?? 1,
        forkId: config.aggregatorConfig?.forkId ?? 1,
        initialBlockHash: config.aggregatorConfig?.initialBlockHash ?? DEFAULT_INITIAL_BLOCK_HASH,
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
        networkId: config.alphabill?.networkId ?? 3,
        tokenPartitionId: config.alphabill?.tokenPartitionId ?? 2,
        tokenPartitionUrl: config.alphabill?.tokenPartitionUrl ?? DEFAULT_TOKEN_PARTITION_URL,
        privateKey: config.alphabill?.privateKey,
      },
      storage: {
        uri: config.storage?.uri ?? DEFAULT_MONGODB_URI,
      },
      validationService: config.validationService,
    };

    const serverId = config.aggregatorConfig!.serverId || `${os.hostname()}-${process.pid}`;
    const storage = await AggregatorStorage.init(config.storage!.uri!);

    if (!config.alphabill?.privateKey) {
      throw new Error('Alphabill private key must be defined in hex encoding.');
    }

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

    const signingService = new SigningService(HexConverter.decode(config.alphabill.privateKey));

    const validationService = config.validationService || new ValidationService();
    await validationService.initialize(mongoUri);

    const aggregatorService = new AggregatorService(
      roundManager,
      smt,
      storage.recordStorage,
      storage.blockStorage,
      storage.blockRecordsStorage,
      signingService,
      validationService,
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

    const app = setupRouter(
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
      validationService
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
    const { useMock, tokenPartitionUrl, tokenPartitionId, networkId, privateKey } = config;
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

  private static async setupSmt(smtStorage: ISmtStorage, aggregatorServerId: string): Promise<Smt> {
    const smt = new SparseMerkleTree(HashAlgorithm.SHA256);
    const smtWrapper = new Smt(smt);

    let totalLeaves = 0;
    const chunkSize = 1000;

    logger.info(`Server ${aggregatorServerId} loading SMT leaves in chunks of ${chunkSize}...`);

    await smtStorage.getAllInChunks(chunkSize, async (chunk) => {
      await smtWrapper.addLeaves(chunk);
      totalLeaves += chunk.length;

      if (totalLeaves % (chunkSize * 5) === 0) {
        logger.info(`Server ${aggregatorServerId} processed ${totalLeaves} leaves...`);
      }
    });

    if (totalLeaves > 0) {
      const rootHash = await smtWrapper.rootHash();
      logger.info(`Server ${aggregatorServerId} loaded ${totalLeaves} leaves from storage.`);
      logger.info(`Tree with root hash ${rootHash.toString()} constructed successfully.`);
    } else {
      logger.info(`Server ${aggregatorServerId} found no existing leaves in storage.`);
    }

    return smtWrapper;
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
      const blockCreationWaitTime = this.roundManager.config.blockCreationWaitTime!;
      await new Promise<void>((resolve) => setTimeout(resolve, blockCreationWaitTime));
    }

    await this.blockRecordsStorage.cleanup();

    await this.leaderElection?.shutdown();
    this.server?.close();

    if (AggregatorGateway.blockCreationTimer) {
      clearTimeout(AggregatorGateway.blockCreationTimer);
      AggregatorGateway.blockCreationTimer = null;
    }

    if (this.validationService) {
      await this.validationService.terminate();
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

  private setupBlockRecordsChangeListener(): void {
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
