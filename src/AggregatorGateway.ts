import http from 'http';
import https from 'https';
import { existsSync, readFileSync } from 'node:fs';
import { Server } from 'node:http';

import { DefaultSigningService } from '@alphabill/alphabill-js-sdk/lib/signing/DefaultSigningService.js';
import { Authenticator } from '@unicitylabs/commons/lib/api/Authenticator.js';
import { RequestId } from '@unicitylabs/commons/lib/api/RequestId.js';
import { HashAlgorithm } from '@unicitylabs/commons/lib/hash/HashAlgorithm.js';
import { SparseMerkleTree } from '@unicitylabs/commons/lib/smt/SparseMerkleTree.js';
import { HexConverter } from '@unicitylabs/commons/lib/util/HexConverter.js';
import bodyParser from 'body-parser';
import cors from 'cors';
import dotenv from 'dotenv';
import express, { Request, Response } from 'express';

import { AggregatorService } from './AggregatorService.js';
import { AlphabillClient } from './alphabill/AlphabillClient.js';
import { Storage } from './database/mongo/Storage.js';
import { LeaderElection } from './ha/LeaderElection.js';
import { MongoLeadershipStorage } from './ha/storage/MongoLeadershipStorage.js';
import { ISmtStorage } from './smt/ISmtStorage.js';
import { MockAlphabillClient } from '../tests/mocks/MockAlphabillClient.js';
import { IAlphabillClient } from './alphabill/IAlphabillClient.js';

dotenv.config();

const sslCertPath = process.env.SSL_CERT_PATH ?? '';
const sslKeyPath = process.env.SSL_KEY_PATH ?? '';
const port =
  process.env.PORT || (sslCertPath && sslKeyPath && existsSync(sslCertPath) && existsSync(sslKeyPath)) ? 443 : 80;

const enableHA = process.env.ENABLE_HIGH_AVAILABILITY === 'true';
console.log(`High availability mode: ${enableHA ? 'ENABLED' : 'DISABLED'}`);

const app = express();
app.use(cors());
app.use(bodyParser.json());

// @ts-expect-error Express route typings mismatch
app.get('/health', (req: Request, res: Response) => {
  if (!enableHA || (leaderElection && leaderElection.isCurrentLeader())) {
    return res.status(200).json({ 
      status: 'ok', 
      role: enableHA ? 'leader' : 'standalone',
      serverId: process.env.HOSTNAME || 'unknown'
    });
  }
  return res.status(503).json({ 
    status: 'standby', 
    role: 'standby',
    serverId: process.env.HOSTNAME || 'unknown'
  });
});

let aggregatorService: AggregatorService;
let leaderElection: LeaderElection | null = null;
let server: Server | null = null;

async function main() {
  const storage = await Storage.init();
  const alphabillClient = await setupAlphabillClient();
  const smt = await setupSmt(storage.smt);
  
  aggregatorService = new AggregatorService(alphabillClient, smt, storage.records);
  
  // Setup high availability if enabled
  if (enableHA) {
    if (!storage.db) {
      throw new Error('MongoDB database connection not available for leader election');
    }
    
    const leadershipStorage = new MongoLeadershipStorage(storage.db, {
      ttlSeconds: parseInt(process.env.LOCK_TTL_SECONDS || '30'),
      collectionName: 'leader_election'
    });
    leaderElection = new LeaderElection(
      leadershipStorage,
      {
        heartbeatIntervalMs: parseInt(process.env.LEADER_HEARTBEAT_INTERVAL_MS || '10000'),
        electionPollingIntervalMs: parseInt(process.env.LEADER_ELECTION_POLLING_INTERVAL_MS || '5000'),
        lockTtlSeconds: parseInt(process.env.LOCK_TTL_SECONDS || '30'),
        lockId: 'aggregator_leader_lock',
        onBecomeLeader,
        onLoseLeadership
      }
    );
    
    await leaderElection.start();
    console.log('Leader election process started');
  } else {
    startHttpServer();
  }
  setupGracefulShutdown();
}

main().catch(error => {
  console.error('Fatal error in main process:', error);
  process.exit(1);
});

// Setup JSON-RPC endpoint
// @ts-expect-error Express route typings mismatch
app.post('/', (req: Request, res: Response) => {
  if (req.body.jsonrpc !== '2.0' || !req.body.params) {
    return res.sendStatus(400);
  }
  
  if (enableHA && leaderElection && !leaderElection.isCurrentLeader()) {
    return res.status(503).json({
      jsonrpc: '2.0',
      error: {
        code: -32000,
        message: 'Service unavailable (standby node)'
      },
      id: req.body.id
    });
  }
  
  switch (req.body.method) {
    case 'submit_transaction': {
      const requestId: RequestId = RequestId.createFromBytes(HexConverter.decode(req.body.params.requestId));
      const payload: Uint8Array = HexConverter.decode(req.body.params.payload);
      const authenticator: Authenticator = Authenticator.fromDto(req.body.params.authenticator);
      return res.send(JSON.stringify(aggregatorService.submitStateTransition(requestId, payload, authenticator)));
    }
    case 'get_inclusion_proof': {
      const requestId: RequestId = RequestId.createFromBytes(HexConverter.decode(req.body.params.requestId));
      return res.send(JSON.stringify(aggregatorService.getInclusionProof(requestId)));
    }
    case 'get_no_deletion_proof': {
      return res.send(JSON.stringify(aggregatorService.getNodeletionProof()));
    }
    default: {
      return res.sendStatus(400);
    }
  }
});

function onBecomeLeader() {
  console.log('This instance became the leader, starting server...');
  startHttpServer();
}

function onLoseLeadership() {
  console.log('This instance lost leadership, stopping server...');
  stopHttpServer();
}

function startHttpServer() {
  if (server) {
    console.log('Server is already running');
    return;
  }
  
  if (sslCertPath && sslKeyPath && existsSync(sslCertPath) && existsSync(sslKeyPath)) {
    const options = {
      cert: readFileSync(sslCertPath),
      key: readFileSync(sslKeyPath),
    };
    server = https.createServer(options, app);
  } else {
    server = http.createServer(app);
  }
  
  server.listen(port, () => {
    const protocol = server instanceof https.Server ? 'HTTPS' : 'HTTP';
    console.log(`Unicity Aggregator (${protocol}) listening on port ${port}`);
  });
}

function stopHttpServer() {
  if (server) {
    server.close(() => {
      console.log('Server stopped');
      server = null;
    });
  }
}

function setupGracefulShutdown() {
  const signals = ['SIGINT', 'SIGTERM', 'SIGQUIT'];
  signals.forEach(signal => {
    process.on(signal, async () => {
      console.log(`Received ${signal}, shutting down gracefully...`);
      
      if (enableHA && leaderElection) {
        await leaderElection.shutdown();
      }
      
      if (server) {
        server.close(() => {
          console.log('HTTP server closed');
          process.exit(0);
        });
      } else {
        process.exit(0);
      }
    });
  });
}

async function setupAlphabillClient(): Promise<IAlphabillClient> {
  const useMockClient = process.env.USE_MOCK_ALPHABILL === 'true';
  
  if (useMockClient) {
    console.log('Using mock AlphabillClient');
    return new MockAlphabillClient();
  }
  
  console.log('Using real AlphabillClient');
  const privateKey = process.env.ALPHABILL_PRIVATE_KEY;
  if (!privateKey) {
    throw new Error('Alphabill private key must be defined in hex encoding.');
  }
  const signingService = new DefaultSigningService(HexConverter.decode(privateKey));
  const alphabillTokenPartitionUrl = process.env.ALPHABILL_TOKEN_PARTITION_URL;
  if (!alphabillTokenPartitionUrl) {
    throw new Error('Alphabill token partition URL must be defined.');
  }
  const networkId = process.env.ALPHABILL_NETWORK_ID;
  if (!networkId) {
    throw new Error('Alphabill network ID must be defined.');
  }
  const alphabillClient = new AlphabillClient(signingService, alphabillTokenPartitionUrl, Number(networkId));
  await alphabillClient.initialSetup();
  return alphabillClient;
}

async function setupSmt(smtStorage: ISmtStorage): Promise<SparseMerkleTree> {
  const smt = await SparseMerkleTree.create(HashAlgorithm.SHA256);
  const smtLeaves = await smtStorage.getAll();
  if (smtLeaves.length > 0) {
    console.log('Found %s leaves from storage.', smtLeaves.length);
    console.log('Constructing tree...');
    smtLeaves.forEach((leaf) => smt.addLeaf(leaf.path, leaf.value));
    console.log('Tree with root hash %s constructed successfully.', smt.rootHash.toString());
  }
  return smt;
}
