const express = require("express");
const bodyParser = require("body-parser");

const crypto = require('crypto');
const fs = require('fs');
const { JSONRPCServer } = require('json-rpc-2.0');
const elliptic = require('elliptic');

// Elliptic curve for signing/verifying
const ec = new elliptic.ec('secp256k1');


// Persistent storage file
const STORAGE_FILE = './records.json';

// Load records from the file, or initialize an empty object
/*let records = {};
if (fs.existsSync(STORAGE_FILE)) {
    records = JSON.parse(fs.readFileSync(STORAGE_FILE));
}*/

// Helper: Verify authenticator
function verifyAuthenticator(requestId, payload, authenticator) {
    const { pubkey, signature, sign_alg, hash_alg } = authenticator;

    // Verify request_id is correct: SHA256(publicKey + state)
    const hash = crypto.createHash('sha256');
    hash.update(Buffer.concat([Buffer.from(pubkey, 'hex'), Buffer.from(payload, 'utf-8')]));
    const expectedRequestId = hash.digest('hex');

    if (expectedRequestId !== requestId) {
        return false;
    }

    // Verify the signature on the payload
    const publicKey = ec.keyFromPublic(pubkey, 'hex');
    const messageHash = crypto.createHash('sha256').update(payload).digest();

    return publicKey.verify(messageHash, signature);
}

class AggregatorGateway {
  constructor() {
//    this.app = express();
//    this.app.use(bodyParser.json());
//    this.storage = storage;
//    this.aggregator = aggregator;
//    this.nodelprover = nodelprover;

    // Initialize the JSON-RPC server
    this.records = {};
    if (fs.existsSync(STORAGE_FILE)) {
	this.records = JSON.parse(fs.readFileSync(STORAGE_FILE));
    }

    this.jsonRpcServer = new JSONRPCServer();

/*    this.methods = {
      aggregator_submit: this.submitStateTransition.bind(this),
      aggregator_get_path: this.getInclusionProof.bind(this),
      aggregator_get_nodel: this.getNodeletionProof.bind(this),
    };*/
    this.jsonRpcServer.addMethod('aggregator_submit', this.submitStateTransition);
    this.jsonRpcServer.addMethod('aggregator_get_path', this.getInclusionProof);
    this.jsonRpcServer.addMethod('aggregator_get_nodel', this.getNodeletionProof);
  }

  async submitStateTransition({ requestId, payload, authenticator }) {
    // Validate input and process the state transition submission
    console.log(JSON.stringify({ requestId, payload, authenticator }));
    if (this.records[requestId]) {
	if(this.records[requestId].payload == payload){
    	    console.log('OK');
    	    return { status: 'success'};
	}
        throw new Error('Request ID already exists');
    }

    if (!verifyAuthenticator(requestId, payload, authenticator)) {
        throw new Error('Invalid authenticator');
    }

    // Store record (append-only)
    this.records[requestId] = { leaf: true, payload, authenticator };

    // Persist records to file
    fs.writeFileSync(STORAGE_FILE, JSON.stringify(this.records));

    console.log('OK');

    return { success: true };
  }

  async getInclusionProof({ requestId }) {
    // Fetch inclusion and non-deletion proofs from the Aggregation Layer
    return { path: [this.records[request_id]] };
  }

  async getNodeletionProof({ requestId }) {
    // Fetch inclusion and non-deletion proofs from the Aggregation Layer
    return {
      nonDeletionProof: { status: true },
    };
  }

  listen(port){
    const app = express();
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
