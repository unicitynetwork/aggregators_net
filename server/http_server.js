const express = require("express");
const cors = require('cors');
const bodyParser = require("body-parser");

const crypto = require('crypto');
const fs = require('fs');
const { JSONRPCServer } = require('json-rpc-2.0');

const { SignerEC } = require('@unicitylabs/shared');
const { hash } = require('@unicitylabs/shared/hasher/sha256hasher.js').SHA256Hasher;


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

class AggregatorGateway {
  constructor() {
    // Initialize the JSON-RPC server
    this.records = {};
    if (fs.existsSync(STORAGE_FILE)) {
	this.records = JSON.parse(fs.readFileSync(STORAGE_FILE));
    }
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

    console.log(`${requestId} - REGISTERED`);

    return { status: 'success', requestId };
  }

  async getInclusionProof({ requestId }) {
    // Fetch inclusion and non-deletion proofs from the Aggregation Layer
    return { path: [this.records[requestId]] };
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
