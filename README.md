# Unicity Agent-Aggregator API

This repository contains the API definition and JavaScript implementations for communication between the Agent and Aggregation layers on the Unicity blockchain platform.

## Overview

Unicity's infrastructure comprises a decentralized Agent layer interacting with a hierarchical Proof Aggregation layer. The communication API enables agents to:
1. Submit state transition requests to the Aggregation layer.
2. Retrieve unicity proofs that include timestamped inclusion proofs and global non-deletion proofs.
For convenience the gateway serves interactive documentation at `/docs`. The page lists all available JSON-RPC methods and allows sending test requests directly from the browser.


## API Operations

### 1. Submit State Transition Request
- **Operation:** `submit_commitment`
- **Description:** Allows an agent to submit a state transition request to the Aggregation layer.
- **Input:**
  - `requestId` (string, 64 digit hex number): The unique identifier for the request.
  - `transactionHash` (string, 64 digit hex number): The hash of the state transition.
  - `authenticator` (object): Self-authentication of the transition request submission, contains digital signature (or more generically, ZK proof) of the transactionHash signed by the agent's private key. Structure:
    - `stateHash` (string, 64 digit hex): Hash of the original state
    - `publicKey` (string, hex): Agent's public key for authentication
    - `signature` (string, hex): Digital signature
    - `signAlg` (string): Signature algorithm standard
    - `hashAlg` (string): Hash algorithm standard
  - `receipt` (optional, boolean): If true, provides a signed receipt in the response.
- **Output:**
  - status (string): `success` Indicates if the request was successfully submitted.
  - receipt (optional, object): Signed receipt if requested, containing:
    - `algorithm` (string): Signing algorithm used by the aggregator
    - `publicKey` (string, hex): Aggregator's public key for signature verification
    - `signature` (string): Digital signature of the request hash
    - `request` (object): The signed request data containing:
      - `service` (string): "aggregator"
      - `method` (string): "submit_commitment"
      - `requestId` (string, hex): The request identifier
      - `transactionHash` (string, hex): The transaction hash
      - `stateHash` (string, hex): The state hash

### 2. Get Inclusion/exclusion proof
- **Operation:** `get_inclusion_proof`
- **Description:** Retrieves the individual inclusion/exclusion proof for a specific state transition request
- **Input:**
  - `requestId` (string, 64 digit hex number): The unique identifier for the state transition request as it was submitted to the unicity.
- **Output:**
  - `inclusionProof` (object, hash path in the unicity tree from the root to the respective leaf or null vertex): Contains proof elements showing the request's inclusion in the unicity SMT (or its exclusion otherwise).

### 3. Get No-Deletion proof
- **Operation:** `get_no_deletion_proof`
- **Description:** Retrieves the global no-deletion proof for the aggregator data structure (the no-deletion proof is recursive, proving no deletion/modification of any aggregator records since genesis)
- **Input:** None
- **Output:**
  - `nonDeletionProof` (object): Zero-knowledge proof confirming no deletion has occurred since the genesis.

## Block-Related API Operations

### 1. Get Block Height
- **Operation:** `get_block_height`
- **Description:** Retrieves the current height of the blockchain (the number of the latest block).
- **Input:** None
- **Output:**
  - `blockNumber` (string): The current block height as a string representing an integer.

### 2. Get Block
- **Operation:** `get_block`
- **Description:** Retrieves detailed information about a specific block.
- **Input:**
  - `blockNumber` (integer or "latest"): The block number to retrieve, or "latest" to get the most recent block.
- **Output:**
  - Block details including:
    - `index` (string): The block number.
    - `chainId` (string): The chain identifier.
    - `version` (string): Block version.
    - `forkId` (string): Fork identifier.
    - `timestamp` (string): Block creation timestamp.
    - `rootHash` (object): Root hash of the block.
    - `previousBlockHash` (string): Hash of the previous block.
    - `noDeletionProofHash` (string or null): Hash of the no-deletion proof if available.

### 3. Get Block Commitments
- **Operation:** `get_block_commitments`
- **Description:** Retrieves all commitments (state transition requests) included in a specific block.
- **Input:**
  - `blockNumber` (integer): The block number for which to retrieve commitments.
- **Output:**
  - Array of commitment objects, each containing:
    - `requestId` (string): The unique identifier of the state transition request.
    - `transactionHash` (string): Hash of the state transition.
    - `authenticator` (object): Authentication data for the commitment.

## High Availability

The Unicity Aggregator implements a high availability system ensuring service continuity when individual server instances fail.

### Leader Election System

The gateway uses a MongoDB-based leader election mechanism where all servers process requests but only the leader creates blocks:

- **Distributed Processing**: All servers can handle API requests, improving scalability
- **Leader Role**: Only one server (the leader) is responsible for block creation and hash submission to the BFT consensus layer
- **Automatic Failover**: If the leader fails, another server automatically takes over block creation responsibilities
- **Conflict Prevention**: MongoDB's atomic operations prevent split-brain scenarios

### How It Works

1. **Distributed Lock**: Servers compete for a lock document in MongoDB to determine the leader
2. **Heartbeats**: The active leader periodically updates its lock to maintain leadership
3. **Automatic Expiration**: If the leader fails, its lock expires after a configurable timeout
4. **Continuous Monitoring**: Follower servers regularly check for leadership opportunities

### Configuration

The high availability mode is **enabled by default**. Configure the HA system through environment variables:

| Variable | Description | Default |
|---|---|---|
| `DISABLE_HIGH_AVAILABILITY` | Disable HA mode (set to 'true' to disable) | `false` |
| `LOCK_TTL_SECONDS` | Lock validity period | `30` |
| `LEADER_HEARTBEAT_INTERVAL` | Leader heartbeat frequency | `10000` (10s) |
| `LEADER_ELECTION_POLLING_INTERVAL` | Follower polling frequency | `5000` (5s) |

### Health Endpoint

The `/health` endpoint provides status information about the server:
- Returns `200 OK` for all servers, with role information in the response body:
  - `{"status": "ok", "role": "leader", "serverId": "server-id"}` - Server is the active leader
  - `{"status": "ok", "role": "follower", "serverId": "server-id"}` - Server is a follower
  - `{"status": "ok", "role": "standalone", "serverId": "server-id"}` - Server is in standalone mode (HA disabled)

This allows load balancers to monitor all servers while providing role information.

## SDK Integration

For token operations and state transitions, use the [Unicity State Transition SDK](https://github.com/unicitynetwork/state-transition-sdk).

### Basic Usage

```javascript
// Create aggregator client
const aggregatorClient = new AggregatorClient('https://gateway-test.unicity.network');
const client = new StateTransitionClient(aggregatorClient);

// Get inclusion proof and create transaction
const inclusionProof = await client.getInclusionProof(commitment);
const transaction = await client.createTransaction(commitment, inclusionProof);
```

For complete documentation, examples, and API reference, visit the [State Transition SDK repository](https://github.com/unicitynetwork/state-transition-sdk).

## Command Line Interface (CLI)
You can submit and query the status of transaction requests via command-line tools from the separate [Unicity CLI repository](https://github.com/unicitynetwork/cli).

## Integration with your project

To integrate token operations and state transitions into your project:

1. **Use the State Transition SDK** for token functionality:
   ```bash
   npm install @unicitylabs/state-transition-sdk
   ```

2. **For direct API access**, make HTTP POST requests to the aggregator gateway using JSON-RPC 2.0 format:
   ```javascript
   const response = await fetch('https://gateway-test.unicity.network/', {
     method: 'POST',
     headers: { 'Content-Type': 'application/json' },
     body: JSON.stringify({
       jsonrpc: '2.0',
       method: 'submit_commitment',
       params: {
         requestId: '<34-byte hex request ID>',
         transactionHash: '<34-byte hex transaction hash>',
         authenticator: {
           stateHash: '<34-byte hex state hash>',
           publicKey: '<33-byte hex public key (compressed)>',
           signature: '<65-byte hex signature [R || S || V]>',
           algorithm: 'secp256k1',
         }
       },
       id: 1
     })
   });
   ```

3. **For command-line operations**, use the [Unicity CLI](https://github.com/unicitynetwork/cli)

For complete integration examples and usage patterns, see the [State Transition SDK documentation](https://github.com/unicitynetwork/state-transition-sdk).

## Summary

This repository provides the **Unicity Agent-Aggregator API** with the following components:

- **JSON-RPC API**: Core operations for submitting commitments and retrieving proofs
- **Block Operations**: Querying blockchain state and block information  
- **High Availability**: Leader election and distributed processing capabilities
- **CLI Tools**: Available in the [Unicity CLI repository](https://github.com/unicitynetwork/cli)
- **SDK Integration**: Token operations via the [State Transition SDK](https://github.com/unicitynetwork/state-transition-sdk)

This setup provides a robust, scalable way to communicate between the Agent and Aggregation layers on the Unicity blockchain platform.
