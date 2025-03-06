import http from 'http';
import https from 'https';
import { existsSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';

import { HashAlgorithm } from '@unicitylabs/shared/lib/hash/DataHasher';
import { SparseMerkleTree } from '@unicitylabs/shared/lib/smt/SparseMerkleTree';
import bodyParser from 'body-parser';
import cors from 'cors';
import express from 'express';
import 'dotenv/config';

import { AggregatorJsonRpcServer } from './json-rpc/AggregatorJsonRpcServer.js';
import { Record } from './Record.js';
import { FileStorage } from './storage/FileStorage.js';

const sslCertPath = process.env.SSL_CERT_PATH;
const sslKeyPath = process.env.SSL_KEY_PATH;
const port =
  process.env.PORT || (sslCertPath && sslKeyPath && existsSync(sslCertPath) && existsSync(sslKeyPath)) ? 443 : 80;
const STORAGE_FILE = './records.json';

const smt = await SparseMerkleTree.create(HashAlgorithm.SHA256);

let records = new Map<bigint, Record>();
if (existsSync(STORAGE_FILE)) {
  console.log('Reading records file from storage %s.', STORAGE_FILE);
  records = JSON.parse(await readFile(STORAGE_FILE, 'utf8'));
  console.log('Found %d records from storage.', records.size);
  console.log('Constructing tree...');
  Object.entries(records).map(async ([key, val]) => await smt.addLeaf(BigInt('0x' + key), val));
  console.log('Tree with root hash %s constructed successfully.', smt.rootHash.toString());
}

const storage = new FileStorage(STORAGE_FILE);
const aggregatorJsonRpcServer = new AggregatorJsonRpcServer(records, smt, storage);

const app = express();
app.use(cors());
app.use(bodyParser.json());
app.post('/', (req, res) => {
  aggregatorJsonRpcServer.receive(req.body).then((jsonRpcResponse) => {
    res.json(jsonRpcResponse);
  });
});
app.listen(port);

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
