import http from 'http';
import https from 'https';
import { existsSync, readFileSync } from 'node:fs';
import { Server } from 'node:http';

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
import { RoundManager } from './RoundManager.js';
import { ISmtStorage } from './smt/ISmtStorage.js';
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

  private constructor(
    serverId: string,
    server: Server,
    leaderElection: LeaderElection | null,
    roundManager: RoundManager,
  ) {
    this.serverId = serverId;
    this.server = server;
    this.leaderElection = leaderElection;
    this.roundManager = roundManager;
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
    const serverId = 'server-' + Math.random().toString(36).substring(2, 10);
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
    const aggregatorService = new AggregatorService(roundManager, smt, storage.recordStorage);

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
    app.use(cors());
    app.use(bodyParser.json());

    app.get('/health', (req: Request, res: Response): any => {
      return res.status(200).json({
        status: 'ok',
        role:
          config.highAvailability?.enabled !== false
            ? leaderElection && leaderElection.isCurrentLeader()
              ? 'leader'
              : 'follower'
            : 'standalone',
        serverId: serverId,
      });
    });

    app.post('/', async (req: Request, res: Response): Promise<any> => {
      if (!aggregatorService) {
        return res.status(500).json({
          jsonrpc: '2.0',
          error: {
            code: -32603,
            message: 'Internal error: Service not initialized.',
          },
          id: req.body.id,
        });
      }

      if (req.body.jsonrpc !== '2.0' || !req.body.params) {
        return res.status(400).json({
          jsonrpc: '2.0',
          error: {
            code: -32600,
            message: 'Invalid Request: Not a valid JSON-RPC 2.0 request',
          },
          id: req.body.id,
        });
      }

      try {
        switch (req.body.method) {
          case 'submit_commitment': {
            logger.info(`Received submit_commitment request: ${req.body.params.requestId}`);
            const requestId: RequestId = RequestId.fromDto(req.body.params.requestId);
            const transactionHash: DataHash = DataHash.fromDto(req.body.params.transactionHash);
            const authenticator: Authenticator = Authenticator.fromDto(req.body.params.authenticator);
            const commitment = new Commitment(requestId, transactionHash, authenticator);
            const response = await aggregatorService.submitCommitment(commitment);
            if (response.status !== SubmitCommitmentStatus.SUCCESS) {
              return res.status(400).send(response.toDto());
            }
            return res.send(JSON.stringify(response.toDto()));
          }
          case 'get_inclusion_proof': {
            logger.info(`Received get_inclusion_proof request: ${req.body.params.requestId}`);
            const requestId: RequestId = RequestId.fromDto(req.body.params.requestId);
            const inclusionProof = await aggregatorService.getInclusionProof(requestId);
            if (inclusionProof == null) {
              return res.sendStatus(404);
            }
            return res.send(JSON.stringify(inclusionProof.toDto()));
          }
          case 'get_no_deletion_proof': {
            const noDeletionProof = await aggregatorService.getNodeletionProof();
            if (noDeletionProof == null) {
              return res.sendStatus(404);
            }
            return res.send(JSON.stringify(noDeletionProof));
          }
          default: {
            return res.sendStatus(400);
          }
        }
      } catch (error) {
        logger.error(`Error processing ${req.body.method}:`, error);
        return res.status(500).json({
          jsonrpc: '2.0',
          error: {
            code: -32603,
            message: `Internal error: ${error instanceof Error ? error.message : 'Unknown error'}`,
          },
          id: req.body.id,
        });
      }
    });

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

    return new AggregatorGateway(serverId, server, leaderElection, roundManager);
  }

  private static onBecomeLeader(aggregatorServerId: string, roundManager: RoundManager): void {
    logger.info(`Server ${aggregatorServerId} became the leader.`);
    this.blockCreationActive = true;
    this.startNextBlock(roundManager);
  }

  private static onLoseLeadership(aggregatorServerId: string): void {
    logger.info(`Server ${aggregatorServerId} lost leadership.`);
    this.blockCreationActive = false;
    if (this.blockCreationTimer) {
      clearTimeout(this.blockCreationTimer);
      this.blockCreationTimer = null;
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

  private static async setupSmt(smtStorage: ISmtStorage, aggregatorServerId: string): Promise<SparseMerkleTree> {
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
    return smt;
  }

  private static startNextBlock(roundManager: RoundManager): void {
    if (!this.blockCreationActive) {
      return;
    }

    const time = Date.now();
    this.blockCreationTimer = setTimeout(
      async () => {
        try {
          if (this.blockCreationActive) {
            await roundManager.createBlock();
            if (this.blockCreationActive) {
              this.startNextBlock(roundManager);
            }
          }
        } catch (error) {
          logger.error('Failed to create block:', error);
          if (this.blockCreationActive) {
            this.startNextBlock(roundManager);
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
    await this.leaderElection?.shutdown();
    this.server?.close();
    AggregatorGateway.blockCreationActive = false;
    if (AggregatorGateway.blockCreationTimer) {
      clearTimeout(AggregatorGateway.blockCreationTimer);
      AggregatorGateway.blockCreationTimer = null;
    }
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
}
