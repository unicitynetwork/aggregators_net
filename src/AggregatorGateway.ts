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
import express, { Express, Request, Response } from 'express';

import { AggregatorService } from './AggregatorService.js';
import { AlphabillClient } from './alphabill/AlphabillClient.js';
import { IAlphabillClient } from './alphabill/IAlphabillClient.js';
import { Storage } from './database/mongo/Storage.js';
import { LeaderElection } from './ha/LeaderElection.js';
import { MongoLeadershipStorage } from './ha/storage/MongoLeadershipStorage.js';
import { ISmtStorage } from './smt/ISmtStorage.js';
import { MockAlphabillClient } from '../tests/mocks/MockAlphabillClient.js';

export interface GatewayConfig {
  port?: number;
  sslCertPath?: string;
  sslKeyPath?: string;
  enableHA?: boolean;
  useAlphabillMock?: boolean;
  alphabillPrivateKey?: string;
  alphabillTokenPartitionUrl?: string;
  alphabillNetworkId?: string;
  lockTtlSeconds?: number;
  leaderHeartbeatIntervalMs?: number;
  leaderElectionPollingIntervalMs?: number;
  mongoUri?: string;
}

export class AggregatorGateway {
  private app: Express;
  private server: Server | null = null;
  private aggregatorService: AggregatorService | null = null;
  private leaderElection: LeaderElection | null = null;
  private config: GatewayConfig;
  private storage: Storage | null = null;
  private serverId: string;
  private isRunning = false;

  constructor(config: GatewayConfig = {}) {
    this.config = {
      port: config.port || 80,
      sslCertPath: config.sslCertPath || '',
      sslKeyPath: config.sslKeyPath || '',
      enableHA: config.enableHA !== undefined ? config.enableHA : false,
      useAlphabillMock: config.useAlphabillMock !== undefined ? config.useAlphabillMock : false,
      alphabillPrivateKey: config.alphabillPrivateKey,
      alphabillTokenPartitionUrl: config.alphabillTokenPartitionUrl,
      alphabillNetworkId: config.alphabillNetworkId,
      lockTtlSeconds: config.lockTtlSeconds || 30,
      leaderHeartbeatIntervalMs: config.leaderHeartbeatIntervalMs || 10000,
      leaderElectionPollingIntervalMs: config.leaderElectionPollingIntervalMs || 5000,
      mongoUri: config.mongoUri || 'mongodb://localhost:27017/alphabill-aggregator',
    };

    this.serverId = 'server-' + Math.random().toString(36).substring(2, 10);

    this.app = express();
    this.app.use(cors());
    this.app.use(bodyParser.json());

    this.app.get('/health', ((req: Request, res: Response) => {
      if (!this.config.enableHA || (this.leaderElection && this.leaderElection.isCurrentLeader())) {
        return res.status(200).json({
          status: 'ok',
          role: this.config.enableHA ? 'leader' : 'standalone',
          serverId: this.serverId,
        });
      }
      return res.status(503).json({
        status: 'standby',
        role: 'standby',
        serverId: this.serverId,
      });
    }) as any);

    // Setup JSON-RPC endpoint
    this.app.post('/', ((req: Request, res: Response) => {
      if (!this.aggregatorService) {
        return res.status(500).json({
          jsonrpc: '2.0',
          error: {
            code: -32603,
            message: 'Internal error: Service not initialized',
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

      if (this.config.enableHA && this.leaderElection && !this.leaderElection.isCurrentLeader()) {
        return res.status(503).json({
          jsonrpc: '2.0',
          error: {
            code: -32000,
            message: 'Service unavailable (standby node)',
          },
          id: req.body.id,
        });
      }

      try {
        switch (req.body.method) {
          case 'submit_transaction': {
            const requestId: RequestId = RequestId.fromDto(req.body.params.requestId);
            const transactionHash: DataHash = DataHash.fromDto(req.body.params.transactionHash);
            const authenticator: Authenticator = Authenticator.fromDto(req.body.params.authenticator);
            return res.send(
              JSON.stringify(this.aggregatorService.submitStateTransition(requestId, transactionHash, authenticator)),
            );
          }
          case 'get_inclusion_proof': {
            const requestId: RequestId = RequestId.fromDto(req.body.params.requestId);
            return res.send(JSON.stringify(this.aggregatorService.getInclusionProof(requestId)));
          }
          case 'get_no_deletion_proof': {
            return res.send(JSON.stringify(this.aggregatorService.getNodeletionProof()));
          }
          default: {
            return res.sendStatus(400);
          }
        }
      } catch (error) {
        console.error(`Error processing ${req.body.method}:`, error);
        return res.status(500).json({
          jsonrpc: '2.0',
          error: {
            code: -32603,
            message: `Internal error: ${error instanceof Error ? error.message : 'Unknown error'}`,
          },
          id: req.body.id,
        });
      }
    }) as any);
  }

  /**
   * Initialize the gateway by setting up storage, clients, and services
   */
  public async init(): Promise<void> {
    const mongoUri = this.config.mongoUri || 'mongodb://localhost:27017/alphabill-aggregator';
    this.storage = await Storage.init(mongoUri);

    const alphabillClient = await this.setupAlphabillClient();
    const smt = await this.setupSmt(this.storage.smt);

    this.aggregatorService = new AggregatorService(alphabillClient, smt, this.storage.records);

    // Setup high availability if enabled
    if (this.config.enableHA) {
      if (!this.storage.db) {
        throw new Error('MongoDB database connection not available for leader election');
      }

      const leadershipStorage = new MongoLeadershipStorage(this.storage.db, {
        ttlSeconds: this.config.lockTtlSeconds as number,
        collectionName: 'leader_election',
      });

      this.leaderElection = new LeaderElection(leadershipStorage, {
        heartbeatIntervalMs: this.config.leaderHeartbeatIntervalMs as number,
        electionPollingIntervalMs: this.config.leaderElectionPollingIntervalMs as number,
        lockTtlSeconds: this.config.lockTtlSeconds as number,
        lockId: 'aggregator_leader_lock',
        onBecomeLeader: () => this.onBecomeLeader(),
        onLoseLeadership: () => this.onLoseLeadership(),
        serverId: this.serverId,
      });
    }
  }

  public async start(): Promise<void> {
    if (!this.aggregatorService) {
      throw new Error('Gateway not initialized. Call init() first.');
    }

    if (this.isRunning) return;

    this.isRunning = true;

    this.startHttpServer();

    if (this.config.enableHA && this.leaderElection) {
      await this.leaderElection.start();
      console.log(`Leader election process started for server ${this.serverId}`);
    }
  }

  /**
   * Stop the gateway
   */
  public async stop(): Promise<void> {
    if (!this.isRunning) return;

    this.isRunning = false;

    if (this.config.enableHA && this.leaderElection) {
      await this.leaderElection.shutdown();
    }

    if (this.server) {
      await new Promise<void>((resolve) => {
        this.server?.close(() => {
          this.server = null;
          resolve();
        });
      });
    }
  }

  /**
   * Check if this instance is the current leader
   */
  public isLeader(): boolean {
    return !this.config.enableHA || this.leaderElection?.isCurrentLeader() || false;
  }

  /**
   * Get the server ID of this instance
   */
  public getServerId(): string {
    return this.serverId;
  }

  private onBecomeLeader(): void {
    console.log(`Server ${this.serverId} became the leader`);
  }

  private onLoseLeadership(): void {
    console.log(`Server ${this.serverId} lost leadership`);
  }

  private startHttpServer(): void {
    if (this.server) return;

    const { sslCertPath, sslKeyPath, port } = this.config;

    this.server =
      sslCertPath && sslKeyPath && existsSync(sslCertPath) && existsSync(sslKeyPath)
        ? https.createServer(
            {
              cert: readFileSync(sslCertPath),
              key: readFileSync(sslKeyPath),
            },
            this.app,
          )
        : http.createServer(this.app);

    this.server.listen(port, () => {
      const protocol = this.server instanceof https.Server ? 'HTTPS' : 'HTTP';
      console.log(`Unicity Aggregator (${protocol}) listening on port ${port} with server ID ${this.serverId}`);
    });
  }

  private async setupAlphabillClient(): Promise<IAlphabillClient> {
    const { useAlphabillMock, alphabillPrivateKey, alphabillTokenPartitionUrl, alphabillNetworkId } = this.config;

    if (useAlphabillMock) {
      console.log(`Server ${this.serverId} using mock AlphabillClient`);
      return new MockAlphabillClient();
    }

    console.log(`Server ${this.serverId} using real AlphabillClient`);
    if (!alphabillPrivateKey) {
      throw new Error('Alphabill private key must be defined in hex encoding.');
    }
    const signingService = new DefaultSigningService(HexConverter.decode(alphabillPrivateKey));

    if (!alphabillTokenPartitionUrl) {
      throw new Error('Alphabill token partition URL must be defined.');
    }

    if (!alphabillNetworkId) {
      throw new Error('Alphabill network ID must be defined.');
    }

    const alphabillClient = new AlphabillClient(signingService, alphabillTokenPartitionUrl, Number(alphabillNetworkId));
    await alphabillClient.initialSetup();
    return alphabillClient;
  }

  private async setupSmt(smtStorage: ISmtStorage): Promise<SparseMerkleTree> {
    const smt = await SparseMerkleTree.create(HashAlgorithm.SHA256);
    const smtLeaves = await smtStorage.getAll();
    if (smtLeaves.length > 0) {
      console.log(`Server ${this.serverId} found %s leaves from storage.`, smtLeaves.length);
      console.log('Constructing tree...');
      smtLeaves.forEach((leaf) => smt.addLeaf(leaf.path, leaf.value));
      console.log('Tree with root hash %s constructed successfully.', smt.rootHash.toString());
    }
    return smt;
  }
}
