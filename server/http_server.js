const express = require("express");
const cors = require('cors');
const bodyParser = require("body-parser");

const crypto = require('crypto');
const fs = require('fs');
const { JSONRPCServer } = require('json-rpc-2.0');

const objectHash = require("object-hash");

const { SignerEC } = require('@unicitylabs/shared/signer/SignerEC.js');
const { hash } = require('@unicitylabs/shared/hasher/sha256hasher.js').SHA256Hasher;

const { SMT } = require('@unicitylabs/prefix-hash-tree');

const { wordArrayToHex, isWordArray, smthash } = require("@unicitylabs/shared");
const { serializeHashPath } = require("@unicitylabs/shared/provider/UnicityProvider.js");

console.log(JSON.stringify(require("@unicitylabs/shared/provider/UnicityProvider.js"), null, 4));

// Persistent storage file
const STORAGE_FILE = './records.json';

// Helper: Verify authenticator
async function verifyAuthenticator(requestId, payload, authenticator) {
    const { state, pubkey, signature, sign_alg, hash_alg } = authenticator;

    const expectedRequestId = hash(pubkey+state);

    if (expectedRequestId !== requestId) {
        return false;
    }

    return SignerEC.verify(pubkey, payload, signature);
}

function recordToLeaf(id, rec){
    const path = BigInt('0x'+id);
    const value = BigInt('0x'+objectHash(rec, {algorithm: 'sha256'}));
    return {path, value }
}

class AggregatorGateway {
  constructor() {
    // Initialize the JSON-RPC server
    this.records = {};
    if (fs.existsSync(STORAGE_FILE)) {
	this.records = JSON.parse(fs.readFileSync(STORAGE_FILE));
    }
    this.smt = new SMT(smthash, Object.entries(this.records).map(([key, val]) => {return recordToLeaf(key, val)}));
    this.jsonRpcServer = new JSONRPCServer();

    this.jsonRpcServer.addMethod('aggregator_submit', submitStateTransition);
    this.jsonRpcServer.addMethod('aggregator_get_path', getInclusionProof);
    this.jsonRpcServer.addMethod('aggregator_get_nodel', getNodeletionProof);
  }

  async submitStateTransition({ requestId, payload, authenticator }) {
    // Validate input and process the state transition submission
    console.log(JSON.stringify({ requestId, payload, authenticator }, null, 4));
    if (this.records[requestId]) {
	if(this.records[requestId].payload == payload){
    	    console.log(`${requestId} - FOUND`);
    	    return { status: 'success', requestId };
	}
        throw new Error('Request ID already exists');
    }

    if (!(await verifyAuthenticator(requestId, payload, authenticator))) {
        throw new Error('Invalid authenticator');
    }

    // Store record (append-only)
    this.records[requestId] = { leaf: true, payload, authenticator };

    // Persist records to file
    fs.writeFileSync(STORAGE_FILE, JSON.stringify(this.records));
    const leaf = recordToLeaf(requestId, this.records[requestId]);
    this.smt.addLeaf(leaf.path, leaf.value);

    console.log(`${requestId} - REGISTERED`);

    return { status: 'success', requestId };
  }

  async getInclusionProof({ requestId }) {
    // Fetch inclusion and non-deletion proofs from the Aggregation Layer
//    return { path: [this.records[requestId]] };
    const path = this.smt.getPath(BigInt('0x'+requestId));
/*    return {path: [...path.map((entry) => {return {prefix: entry.prefix?.toString(16), 
	covalue: wordArrayToHex(entry.covalue), value:isWordArray(entry.value)?
	('0x'+wordArrayToHex(entry.value)):(typeof entry.value === 'bigint')?
	('0x'+entry.value.toString(16)):entry.value};}), ...[this.records[requestId]]]};*/
    return serializeHashPath(path, this.records[requestId]);
  }

  async getNodeletionProof({ requestId }) {
    // Fetch inclusion and non-deletion proofs from the Aggregation Layer
    return {
      nonDeletionProof: { status: 'success' },
    };
  }

  listen(port){
    const app = express();
    app.use(cors());
    app.use(bodyParser.json());
    app.post('/', (req, res) => {
	this.jsonRpcServer.receive(req.body).then((jsonRpcResponse) => {
    	    res.json(jsonRpcResponse);
	});
    });
    app.listen(port, () => {
	console.log(`unicity-mock listening on port ${port}`);
    });
  }

}

const gateway = new AggregatorGateway();
gateway.listen(8847);

function submitStateTransition(obj){
    return gateway.submitStateTransition(obj);
}

function getInclusionProof(obj){
    return gateway.getInclusionProof(obj);
}

function getNodeletionProof(obj){
    return gateway.getNodeletionProof(obj);
}
