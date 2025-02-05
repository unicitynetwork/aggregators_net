const express = require("express");
const cors = require('cors');
const bodyParser = require("body-parser");
const https = require("https");
const http = require("http");

const crypto = require('crypto');
const fs = require('fs');
const { JSONRPCServer } = require('json-rpc-2.0');

const { SignerEC, verify } = require('@unicitylabs/shared/signer/SignerEC.js');
const { hash, objectHash } = require('@unicitylabs/shared/hasher/sha256hasher.js').SHA256Hasher;

const { SMT } = require('@unicitylabs/prefix-hash-tree');

const { wordArrayToHex, hexToWordArray, isWordArray, smthash } = require("@unicitylabs/shared");
const { serializeHashPath } = require("@unicitylabs/shared/provider/UnicityProvider.js");

require('dotenv').config();

const sslCertPath = process.env.SSL_CERT_PATH;
const sslKeyPath = process.env.SSL_KEY_PATH;
const port = process.env.PORT || ((sslCertPath && sslKeyPath && fs.existsSync(sslCertPath) && fs.existsSync(sslKeyPath)) ? 443 : 80);

// Persistent storage file
const STORAGE_FILE = './records.json';

// Helper: Verify authenticator
async function verifyAuthenticator(requestId, payload, authenticator) {
    const { state, pubkey, signature, sign_alg, hash_alg } = authenticator;

    const expectedRequestId = hash(pubkey + state);

    if (expectedRequestId !== requestId) {
        return false;
    }

    return verify(pubkey, payload, signature);
}

function recordToLeaf(id, rec) {
    const path = BigInt('0x' + id);
    const value = hexToWordArray(objectHash(rec));
    return { path, value }
}

class AggregatorGateway {
    constructor() {
        // Initialize the JSON-RPC server
        this.records = {};
        if (fs.existsSync(STORAGE_FILE)) {
            this.records = JSON.parse(fs.readFileSync(STORAGE_FILE));
        }
        console.log("Found " + Object.entries(this.records).length + " commits");
        this.smt = new SMT(smthash, Object.entries(this.records).map(([key, val]) => { return recordToLeaf(key, val) }));
        console.log("Aggregator tree with root " + this.smt.root.getValue() + " constructed");
        this.jsonRpcServer = new JSONRPCServer();

        this.jsonRpcServer.addMethod('aggregator_submit', submitStateTransition);
        this.jsonRpcServer.addMethod('aggregator_get_path', getInclusionProof);
        this.jsonRpcServer.addMethod('aggregator_get_nodel', getNodeletionProof);
    }

    submitStateTransition({ requestId, payload, authenticator }) {
        // Validate input and process the state transition submission
        console.log(JSON.stringify({ requestId, payload, authenticator }, null, 4));
        if (this.records[requestId]) {
            if (this.records[requestId].payload == payload) {
                console.log(`${requestId} - FOUND`);
                return { status: 'success', requestId };
            }
            throw new Error('Request ID already exists');
        }

        if (!(verifyAuthenticator(requestId, payload, authenticator))) {
            throw new Error('Invalid authenticator');
        }

        // Store record (append-only)
        this.records[requestId] = { leaf: true, payload, authenticator };

        // Persist records to file
        fs.writeFileSync(STORAGE_FILE, JSON.stringify(this.records));
        const leaf = recordToLeaf(requestId, this.records[requestId]);
        this.smt.addLeaf(leaf.path, leaf.value);

        console.log(`${requestId} - REGISTERED, root ${this.smt.root.getValue()}`);

        return { status: 'success', requestId };
    }

    getInclusionProof({ requestId }) {
        // Fetch inclusion and non-deletion proofs from the Aggregation Layer
        const path = this.smt.getPath(BigInt('0x' + requestId));
        return serializeHashPath(path, this.records[requestId]);
    }

    getNodeletionProof({ requestId }) {
        // Fetch inclusion and non-deletion proofs from the Aggregation Layer
        return {
            nonDeletionProof: { status: 'success' },
        };
    }

    listen(port) {
        const app = express();
        app.use(cors());
        app.use(bodyParser.json());
        app.post('/', (req, res) => {
            this.jsonRpcServer.receive(req.body).then((jsonRpcResponse) => {
                res.json(jsonRpcResponse);
            });
        });
        if (sslCertPath && sslKeyPath && fs.existsSync(sslCertPath) && fs.existsSync(sslKeyPath)) {
            const options = {
                cert: fs.readFileSync(sslCertPath),
                key: fs.readFileSync(sslKeyPath),
            };

            https.createServer(options, app).listen(port, () => {
                console.log(`unicity-mock (HTTPS) listening on port ${port}`);
            });
        } else {
            http.createServer(app).listen(port, () => {
                console.log(`unicity-mock (HTTP) listening on port ${port}`);
            });
        }
    }

}

const gateway = new AggregatorGateway();
gateway.listen(port);

function submitStateTransition(obj) {
    return gateway.submitStateTransition(obj);
}

function getInclusionProof(obj) {
    return gateway.getInclusionProof(obj);
}

function getNodeletionProof(obj) {
    return gateway.getNodeletionProof(obj);
}