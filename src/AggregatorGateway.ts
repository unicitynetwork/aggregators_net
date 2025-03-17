import http from 'http';
import https from 'https';
import { existsSync, readFileSync } from 'node:fs';

import { HashAlgorithm } from '@unicitylabs/commons/lib/hash/DataHasher';
import { SigningService } from '@unicitylabs/commons/lib/signing/SigningService';
import { SparseMerkleTree } from '@unicitylabs/commons/lib/smt/SparseMerkleTree';
import bodyParser from 'body-parser';
import cors from 'cors';
import express from 'express';
import 'dotenv/config';

import { AlphabillClient } from './alphabill/AlphabillClient.js';
import { AggregatorJsonRpcServer } from './json-rpc/AggregatorJsonRpcServer.js';
import { JSONRPCServer } from 'json-rpc-2.0';
import { NetworkIdentifier } from '@alphabill/alphabill-js-sdk/lib/NetworkIdentifier';õ
import { Storage } from './database/mongo/Storage.js';
import { ISmtStorage } from './smt/ISmtStorage.js';

const sslCertPath = process.env.SSL_CERT_PATH ?? '';
const sslKeyPath = process.env.SSL_KEY_PATH ?? '';
const port =
  process.env.PORT || (sslCertPath && sslKeyPath && existsSync(sslCertPath) && existsSync(sslKeyPath)) ? 443 : 80;

const aggregatorJsonRpcServer = await setupAggregatorServer()
const app = express();
app.use(cors());
app.use(bodyParser.json());
app.post('/', (req, res) => {
  aggregatorJsonRpcServer.receive(req.body).then((jsonRpcResponse) => {
    res.json(jsonRpcResponse);
  });
});
app.listen(port);
startServer(sslCertPath, sslKeyPath, port);

async function setupAggregatorServer(): Promise<JSONRPCServer> {
  const alphabillClient = await setupAlphabillClient();
  const storage = await Storage.init();
  const smt = await setupSmt(storage.smt);
  return new AggregatorJsonRpcServer(alphabillClient, smt, storage.records);
}

async function setupAlphabillClient(): Promise<AlphabillClient> {
  const secret = null; // TODO
  const nonce = null;
  const signingService = SigningService.createFromSecret(secret, nonce);
  const alphabillTokenPartitionUrl = null; // TODO
  const networkId = NetworkIdentifier.TESTNET; // TODO
  const alphabillClient = new AlphabillClient(signingService, alphabillTokenPartitionUrl, networkId);
  await alphabillClient.initialSetup();
  return alphabillClient;
}

async function setupSmt(smtStorage: ISmtStorage): Promise<SparseMerkleTree> {
  const smt = SparseMerkleTree.create(HashAlgorithm.SHA256);
  const smtLeaves = await smtStorage.getAll();
  if (smtLeaves.length > 0) {
    console.log('Found %s leaves from storage.', smtLeaves.length);
    console.log('Constructing tree...');
    smtLeaves.forEach((leaf) => smt.addLeaf(leaf.path, leaf.value));
    console.log('Tree with root hash %s constructed successfully.', smt.rootHash.toString());
  }
  return smt;
}

function startServer(sslCertPath: string, sslKeyPath: string, port: number) {
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
