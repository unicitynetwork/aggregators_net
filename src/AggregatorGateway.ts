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
import { AlphabillClient } from './alphabill/AlphabillClient.js';
import { IAlphabillClient } from './alphabill/IAlphabillClient.js';
import { Storage } from './database/mongo/Storage.js';
import { LeaderElection } from './ha/LeaderElection.js';
import { MongoLeadershipStorage } from './ha/storage/MongoLeadershipStorage.js';
import { ISmtStorage } from './smt/ISmtStorage.js';
import { MockAlphabillClient } from '../tests/mocks/MockAlphabillClient.js';

export interface IGatewayConfig {
  sslCertPath?: string;
  sslKeyPath?: string;
  port?: number;
  alphabill?: IAlphabillConfig;
  highAvailability?: IHighAvailabilityConfig;
  storage?: IStorageConfig;
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
  private serverId: string;
  private server: Server;
  private leaderElection: LeaderElection | null;

  private constructor(serverId: string, server: Server, leaderElection: LeaderElection | null) {
    this.serverId = serverId;
    this.server = server;
    this.leaderElection = leaderElection;
  }

  public static async create(config: IGatewayConfig = {}): Promise<AggregatorGateway> {
    config = {
      port: config.port || 80,
      sslCertPath: config.sslCertPath || '',
      sslKeyPath: config.sslKeyPath || '',
      highAvailability: {
        enabled: config.highAvailability?.enabled ?? false,
        lockTtlSeconds: config.highAvailability?.lockTtlSeconds || 30,
        leaderHeartbeatInterval: config.highAvailability?.leaderHeartbeatInterval || 10000,
        leaderElectionPollingInterval: config.highAvailability?.leaderElectionPollingInterval || 5000,
      },
      alphabill: {
        useMock: config.alphabill?.useMock ?? false,
        networkId: config.alphabill?.networkId,
        tokenPartitionId: config.alphabill?.tokenPartitionId,
        tokenPartitionUrl: config.alphabill?.tokenPartitionUrl,
        privateKey: config.alphabill?.privateKey,
      },
      storage: {
        uri: config.storage?.uri || 'mongodb://localhost:27017/',
      },
    };
    const serverId = 'server-' + Math.random().toString(36).substring(2, 10);
    const mongoUri = config.storage?.uri || 'mongodb://localhost:27017/';
    const storage = await Storage.init(mongoUri);

    const alphabillClient = await AggregatorGateway.setupAlphabillClient(config.alphabill ?? {}, serverId);
    const smt = await AggregatorGateway.setupSmt(storage.smt, serverId);
    const aggregatorService = new AggregatorService(alphabillClient, smt, storage.records);

    let leaderElection: LeaderElection | null = null;
    if (config.highAvailability?.enabled) {
      const { leaderHeartbeatInterval, leaderElectionPollingInterval, lockTtlSeconds } = config.highAvailability;
      if (!storage.db) {
        throw new Error('MongoDB database connection not available for leader election.');
      }

      const leadershipStorage = new MongoLeadershipStorage(storage.db, {
        ttlSeconds: lockTtlSeconds!,
        collectionName: 'leader_election',
      });

      leaderElection = new LeaderElection(leadershipStorage, {
        heartbeatInterval: leaderHeartbeatInterval!,
        electionPollingInterval: leaderElectionPollingInterval!,
        lockTtlSeconds: lockTtlSeconds!,
        lockId: 'aggregator_leader_lock',
        onBecomeLeader(): void {
          return AggregatorGateway.onBecomeLeader(serverId);
        },
        onLoseLeadership(): void {
          return AggregatorGateway.onLoseLeadership(serverId);
        },
        serverId: serverId,
      });
    } else {
      console.log('High availability mode is disabled.');
    }
    const app = express();
    app.use(cors());
    app.use(bodyParser.json());

    app.get('/health', (req: Request, res: Response): any => {
      if (!config.highAvailability?.enabled || (leaderElection && leaderElection.isCurrentLeader())) {
        return res.status(200).json({
          status: 'ok',
          role: config.highAvailability?.enabled ? 'leader' : 'standalone',
          serverId: serverId,
        });
      }
      return res.status(503).json({
        status: 'standby',
        role: 'standby',
        serverId: serverId,
      });
    });

    app.post('/', async (req: Request, res: Response): Promise<any> => {
      if (!aggregatorService) {
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

      if (config.highAvailability?.enabled && leaderElection && !leaderElection.isCurrentLeader()) {
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
            const response = await aggregatorService.submitStateTransition(requestId, transactionHash, authenticator);
            return res.send(JSON.stringify(response));
          }
          case 'get_inclusion_proof': {
            const requestId: RequestId = RequestId.fromDto(req.body.params.requestId);
            const inclusionProof = await aggregatorService.getInclusionProof(requestId);
            return res.send(JSON.stringify(inclusionProof));
          }
          case 'get_no_deletion_proof': {
            const nodeletionProof = await aggregatorService.getNodeletionProof();
            return res.send(JSON.stringify(nodeletionProof));
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
    });

    const { sslCertPath, sslKeyPath, port } = config;

    const server =
      sslCertPath && sslKeyPath && existsSync(sslCertPath) && existsSync(sslKeyPath)
        ? https.createServer({ cert: readFileSync(sslCertPath), key: readFileSync(sslKeyPath) }, app)
        : http.createServer(app);

    server.listen(port, () => {
      const protocol = server instanceof https.Server ? 'HTTPS' : 'HTTP';
      console.log(`Unicity Aggregator (${protocol}) listening on port ${port} with server ID ${serverId}`);
    });

    if (config.highAvailability?.enabled && leaderElection) {
      await leaderElection.start();
      console.log(`Leader election process started for server ${serverId}.`);
    }

    return new AggregatorGateway(serverId, server, leaderElection);
  }

  private static onBecomeLeader(aggregatorServerId: string): void {
    console.log(`Server ${aggregatorServerId} became the leader.`);
  }

  private static onLoseLeadership(aggregatorServerId: string): void {
    console.log(`Server ${aggregatorServerId} lost leadership.`);
  }

  private static async setupAlphabillClient(
    config: IAlphabillConfig,
    aggregatorServerId: string,
  ): Promise<IAlphabillClient> {
    const { useMock, privateKey, tokenPartitionUrl, tokenPartitionId, networkId } = config;
    if (useMock) {
      console.log(`Server ${aggregatorServerId} using mock AlphabillClient.`);
      return new MockAlphabillClient();
    }
    console.log(`Server ${aggregatorServerId} using real AlphabillClient.`);
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
      console.log(`Server ${aggregatorServerId} found %s leaves from storage.`, smtLeaves.length);
      console.log('Constructing tree...');
      smtLeaves.forEach((leaf) => smt.addLeaf(leaf.path, leaf.value));
      console.log('Tree with root hash %s constructed successfully.', smt.rootHash.toString());
    }
    return smt;
  }

  /**
   * Stop the services started by aggregator.
   */
  public async stop(): Promise<void> {
    await this.leaderElection?.shutdown();
    this.server?.close();
  }

  /**
   * Check if this instance is the current leader.
   */
  public isLeader(): boolean {
    return this.leaderElection?.isCurrentLeader() || false;
  }

  /**
   * Get the server ID of this instance.
   */
  public getServerId(): string {
    return this.serverId;
  }
}
