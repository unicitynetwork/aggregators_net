import http from 'http';
import https from 'https';
import { existsSync, readFileSync } from 'node:fs';
import { Server } from 'node:http';
import os from 'node:os';

import { DefaultSigningService } from '@unicitylabs/bft-js-sdk/lib/signing/DefaultSigningService.js';
import { HashAlgorithm } from '@unicitylabs/commons/lib/hash/HashAlgorithm.js';
import { SigningService } from '@unicitylabs/commons/lib/signing/SigningService.js';
import { SparseMerkleTree } from '@unicitylabs/commons/lib/smt/SparseMerkleTree.js';
import { HexConverter } from '@unicitylabs/commons/lib/util/HexConverter.js';

import { AggregatorService } from './AggregatorService.js';
import { AggregatorStorage } from './AggregatorStorage.js';
import { BftClient } from './consensus/bft/BftClient.js';
import { IBftClient } from './consensus/bft/IBftClient.js';
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
import { MockBftClient } from '../tests/consensus/bft/MockBftClient.js';
import { ValidationService, IValidationService } from './ValidationService.js';
import { RequestId } from '@unicitylabs/commons/lib/api/RequestId.js';

export interface IGatewayConfig {
  aggregatorConfig?: IAggregatorConfig;
  bft?: IBftConfig;
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

export interface IBftConfig {
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
  private blockCreationActive = false;
  private blockCreationTimer: NodeJS.Timeout | null = null;
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
      bft: {
        useMock: config.bft?.useMock ?? false,
        networkId: config.bft?.networkId ?? 3,
        tokenPartitionId: config.bft?.tokenPartitionId ?? 2,
        tokenPartitionUrl: config.bft?.tokenPartitionUrl ?? DEFAULT_TOKEN_PARTITION_URL,
        privateKey: config.bft?.privateKey,
      },
      storage: {
        uri: config.storage?.uri ?? DEFAULT_MONGODB_URI,
      },
      validationService: config.validationService,
    };

    const serverId = config.aggregatorConfig!.serverId || `${os.hostname()}-${process.pid}`;
    const storage = await AggregatorStorage.init(config.storage!.uri!, serverId);

    if (!config.bft?.privateKey) {
      throw new Error('BFT private key must be defined in hex encoding.');
    }

    const bftClient = await AggregatorGateway.setupBftClient(config.bft!, serverId);
    const smt = await AggregatorGateway.setupSmt(storage.smtStorage, serverId);
    const roundManager = new RoundManager(
      config.aggregatorConfig!,
      bftClient,
      smt,
      storage.blockStorage,
      storage.recordStorage,
      storage.blockRecordsStorage,
      storage.commitmentStorage,
      storage.smtStorage,
    );

    const signingService = new SigningService(HexConverter.decode(config.bft!.privateKey!));

    const validationService = config.validationService || new ValidationService();
    await validationService.initialize(config.storage!.uri!);

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
        serverId: serverId,
      });
    } else {
      logger.info('High availability mode is disabled.');
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

    const gateway = new AggregatorGateway(
      serverId,
      server,
      leaderElection,
      roundManager,
      storage.blockRecordsStorage,
      storage.smtStorage,
      smt,
      validationService
    );

    if (config.highAvailability?.enabled && leaderElection) {
      leaderElection.setOnBecomeLeader(() => gateway.onBecomeLeader());
      leaderElection.setOnLoseLeadership(() => gateway.onLoseLeadership());
      await leaderElection.start();
      logger.info(`Leader election process started for server ${serverId}.`);
    } else {
      gateway.blockCreationActive = true;
      gateway.startNextBlock();
    }

    return gateway;
  }

  private onBecomeLeader(): void {
    logger.info(`Server ${this.serverId} became the leader.`);
    this.blockCreationActive = true;
    this.startNextBlock();
  }

  private onLoseLeadership(): void {
    logger.info(`Server ${this.serverId} lost leadership.`);
    this.blockCreationActive = false;
    if (this.blockCreationTimer) {
      clearTimeout(this.blockCreationTimer);
      this.blockCreationTimer = null;
    }
  }

  private static async setupBftClient(
    config: IBftConfig,
    aggregatorServerId: string,
  ): Promise<IBftClient> {
    const { useMock, tokenPartitionUrl, tokenPartitionId, networkId, privateKey } = config;
    if (useMock) {
      logger.info(`Server ${aggregatorServerId} using mock BftClient.`);
      return new MockBftClient();
    }
    logger.info(`Server ${aggregatorServerId} using real BftClient.`);

    if (!privateKey) {
      throw new Error('Bft private key must be defined in hex encoding.');
    }
    const signingService = new DefaultSigningService(HexConverter.decode(privateKey));
    if (!tokenPartitionUrl) {
      throw new Error('Bft token partition URL must be defined.');
    }
    if (!tokenPartitionId) {
      throw new Error('Bft token partition ID must be defined.');
    }
    if (!networkId) {
      throw new Error('Bft network ID must be defined.');
    }
    return await BftClient.create(signingService, tokenPartitionUrl, tokenPartitionId, networkId);
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

  private startNextBlock(): void {
    if (!this.blockCreationActive) {
      return;
    }

    // Clear any existing timer to prevent concurrent block creation
    if (this.blockCreationTimer) {
      clearTimeout(this.blockCreationTimer);
      this.blockCreationTimer = null;
    }

    const time = Date.now();
    this.blockCreationTimer = setTimeout(
      async () => {
        try {
          if (this.blockCreationActive) {
            await this.roundManager.createBlock();

            // Only start next block if we're still active
            if (this.blockCreationActive) {
              this.startNextBlock();
            }
          }
        } catch (error) {
          logger.error('Failed to create block:', error);

          if (this.blockCreationActive) {
            this.blockCreationTimer = setTimeout(() => {
              if (this.blockCreationActive) {
                this.startNextBlock();
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
    logger.info(`Stopping aggregator gateway for server ${this.serverId}...`);

    const isBlockCreationInProgress = this.blockCreationActive && this.blockCreationTimer;
    this.blockCreationActive = false;

    // Wait for any in-progress block creation to complete
    if (isBlockCreationInProgress) {
      logger.info('Waiting for any block creation to complete before shutdown...');
      const blockCreationWaitTime = this.roundManager.config.blockCreationWaitTime!;
      await new Promise<void>((resolve) => setTimeout(resolve, blockCreationWaitTime));
    }

    await this.blockRecordsStorage.cleanup();

    await this.leaderElection?.shutdown();
    this.server?.close();

    if (this.blockCreationTimer) {
      clearTimeout(this.blockCreationTimer);
      this.blockCreationTimer = null;
    }

    if (this.validationService) {
      await this.validationService.terminate();
    }

    logger.info(`Aggregator gateway stopped successfully for server ${this.serverId}`);
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
        const missingPaths = paths.filter((path) => !leaves.some((leaf) => leaf.path === path));
        const errorMessage =
          `FATAL: Failed to retrieve all SMT leaves after ${maxRetries} retries. ` +
          `Got ${leaves.length}/${paths.length} leaves for block ${blockRecords.blockNumber}. ` +
          `Missing paths: ${missingPaths.map((p) => p.toString()).join(', ')}. ` +
          `SMT synchronization is broken - process will exit to force restart and full SMT reload.`;
        
        logger.error(errorMessage);
        process.exit(1);
      }

      logger.info(
        `Retrieved ${leaves.length} SMT leaves for block ${blockRecords.blockNumber}, updating in-memory SMT`,
      );

      const leavesToAdd = leaves.map((leaf) => ({
        path: leaf.path,
        value: leaf.value,
      }));

      await this.smt.addLeaves(leavesToAdd);

      logger.info(`Updated in-memory SMT for follower node, new root hash: ${(await this.smt.rootHash()).toString()}`);
    });

    logger.info(`BlockRecords change listener initialized for server ${this.serverId}`);
  }
}
