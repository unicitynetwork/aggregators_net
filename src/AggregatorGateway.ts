import http from 'http';
import https from 'https';
import { existsSync, readFileSync } from 'node:fs';

import { DefaultSigningService } from '@alphabill/alphabill-js-sdk/lib/signing/DefaultSigningService.js';
import { Authenticator } from '@unicitylabs/commons/lib/api/Authenticator.js';
import { RequestId } from '@unicitylabs/commons/lib/api/RequestId.js';
import { DataHash } from '@unicitylabs/commons/lib/hash/DataHash.js';
import { HashAlgorithm } from '@unicitylabs/commons/lib/hash/HashAlgorithm.js';
import { SparseMerkleTree } from '@unicitylabs/commons/lib/smt/SparseMerkleTree.js';
import { HexConverter } from '@unicitylabs/commons/lib/util/HexConverter.js';
import bodyParser from 'body-parser';
import cors from 'cors';
import dotenv from 'dotenv';
import express from 'express';

import { AggregatorService } from './AggregatorService.js';
import { AlphabillClient } from './alphabill/AlphabillClient.js';
import { Storage } from './database/mongo/Storage.js';
import { ISmtStorage } from './smt/ISmtStorage.js';

dotenv.config();

const aggregatorService = await setupAggregatorService();
const app = express();
app.use(cors());
app.use(bodyParser.json());
// @ts-expect-error TODO: Add return types
app.post('/', (req, res) => {
  if (req.body.jsonrpc !== '2.0' || !req.body.params) {
    return res.sendStatus(400);
  }
  switch (req.body.method) {
    case 'submit_transaction': {
      const requestId: RequestId = RequestId.fromDto(req.body.params.requestId);
      const transactionHash: DataHash = DataHash.fromDto(req.body.params.transactionHash);
      const authenticator: Authenticator = Authenticator.fromDto(req.body.params.authenticator);
      return res.send(
        JSON.stringify(aggregatorService.submitStateTransition(requestId, transactionHash, authenticator)),
      );
    }
    case 'get_inclusion_proof': {
      const requestId: RequestId = RequestId.fromDto(req.body.params.requestId);
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
startServer();

async function setupAggregatorService(): Promise<AggregatorService> {
  const alphabillClient = await setupAlphabillClient();
  const storage = await Storage.init();
  const smt = await setupSmt(storage.smt);
  return new AggregatorService(alphabillClient, smt, storage.records);
}

async function setupAlphabillClient(): Promise<AlphabillClient> {
  let alphabillClient;
  try {
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
    alphabillClient = new AlphabillClient(signingService, alphabillTokenPartitionUrl, Number(networkId));
    await alphabillClient.initialSetup();
  } catch (error) {
    console.error('Failed to initialize Alphabill client:', error);
    process.exit(1);
  }
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

function startServer(): void {
  const sslCertPath = process.env.SSL_CERT_PATH ?? '';
  const sslKeyPath = process.env.SSL_KEY_PATH ?? '';
  const port =
    process.env.PORT || (sslCertPath && sslKeyPath && existsSync(sslCertPath) && existsSync(sslKeyPath)) ? 443 : 80;

  if (sslCertPath && sslKeyPath && existsSync(sslCertPath) && existsSync(sslKeyPath)) {
    const options = {
      cert: readFileSync(sslCertPath),
      key: readFileSync(sslKeyPath),
    };
    https.createServer(options, app).listen(port, () => {
      console.log(`Unicity (HTTPS) listening on port ${port}`);
    });
  } else {
    http.createServer(app).listen(port, () => {
      console.log(`Unicity (HTTP) listening on port ${port}`);
    });
  }
}
