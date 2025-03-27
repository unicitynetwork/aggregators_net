# Unicity Agent-Aggregator API

This repository contains the API definition and JavaScript implementations for communication between the Agent and Aggregation layers on the Unicity blockchain platform.

## Overview

Unicity's infrastructure comprises a decentralized Agent layer interacting with a hierarchical Proof Aggregation layer. The communication API enables agents to:
1. Submit state transition requests to the Aggregation layer.
2. Retrieve unicity proofs that include timestamped inclusion proofs and global non-deletion proofs.

## API Operations

### 1. Submit State Transition Request
- **Operation:** `aggregator_submit`
- **Description:** Allows an agent to submit a state transition request to the Aggregation layer.
- **Input:**
  - `requestId` (string, 64 digit hex number): The unique identifier for the request.
  - `payload` (string, 64 hex number): The hash of the state transition.
  - `authenticator` (structure {state - 64 digit hex of the original state hash, pubkey - hex, signatue - hex, sign_alg - string, hash_alg - string}): Self-authentication of the transition request submission, contains digital signature (or more generically, ZK proof) of the payload signed by the agent's private key (ZK proof of the respective computation linked to the initial state hash and transition hash).
- **Output:**
  - status (string): `success` Indicates if the request was successfully submitted.

### 2. Get Inclusion/exclusion proof
- **Operation:** `aggregator_get_path`
- **Description:** Retrieves the individual inclusion/exclusion proof for a specific state transition request (optionally, at specific block number)
- **Input:**
  - `requestId` (string, 64 digit hex number): The unique identifier for the state transition request as it was submitted to the unicity.
  - `blockNum` (optional, integer): the block number for which to generate the inclusion/exclusion proof (normally, a hash path between the root at the given blockNum and the respective leaf position corresponding to the requestId)
- **Output:**
  - `inclusionProof` (object, hash path in the unicity tree from the root to the respective leaf or null vertex): Contains proof elements showing the request's inclusion in the unicity SMT (or its exclusion otherwise).

### 3. Get No-Deletion proof
- **Operation:** `aggregator_get_nodel`
- **Description:** Retrieves the global nodeletion proof for the aggregator data structure at specific block number (the nodel proof is recursive, it proves already no deletion/modification of any aggregator records since the genesis till the current blocknum)
- **Input:**
  - `blockNum` (integer): the block number for which to generate the inclusion/exclusion proof (normally, a hash path between the root at the given blockNum and the respective leaf position corresponding to the requestId)
- **Output:**
  - `nonDeletionProof` (object): Zero-knowledge proof confirming no deletion has occurred since the genesis.

## High Availability

The Unicity Aggregator implements a high availability system ensuring service continuity when individual server instances fail.

### Leader Election System

The gateway uses a MongoDB-based leader election mechanism to ensure only one server processes requests at any time:

- **Single Active Server**: Only one server is designated as leader
- **Automatic Failover**: Standby servers automatically take over if the leader fails
- **Conflict Prevention**: MongoDB's atomic operations prevent split-brain scenarios

### How It Works

1. **Distributed Lock**: Servers compete for a lock document in MongoDB
2. **Heartbeats**: The active leader periodically updates its lock to maintain leadership
3. **Automatic Expiration**: If the leader fails, its lock expires after a configurable timeout
4. **Continuous Monitoring**: Standby servers regularly check for leadership opportunities

### Configuration

Configure the HA system through environment variables:

| Variable | Description | Default |
|---|---|---|
| `ENABLE_HIGH_AVAILABILITY` | Enable/disable HA mode | `false` |
| `LOCK_TTL_SECONDS` | Lock validity period | `30` |
| `LEADER_HEARTBEAT_INTERVAL_MS` | Leader heartbeat frequency | `10000` (10s) |
| `LEADER_ELECTION_POLLING_INTERVAL_MS` | Standby polling frequency | `5000` (5s) |

### Health Endpoint

The `/health` endpoint returns different status codes based on server role:
- `200 OK`: Server is active leader (or standalone mode)
- `503 Service Unavailable`: Server is in standby mode

This allows load balancers to route traffic only to the active server.

## SDK, Transport-Agnostic JavaScript Functions
The `AggregatorAPI` class provides transport-agnostic functions for submitting requests and fetching proofs.
### Constructor
 - **Arguments:**
   - `transport` (object): object implementing communication between agent and Unicity gateway
### submitStateTransition
 - **Implements:** `aggregator_submit`
 - **Arguments:**
   - `requestId` (string, 64 digit hex) - unique ID of the state transition request. Normally, this id is calculated from the original state hash and public key (or some other public input for ZK proof)
   - `payload` (string, 64 digit hex) - hash of the agent transition
   - `authenticator` (object, structure {state - 64 digit hex of the original state hash, pubkey - hex, signatue - hex, sign_alg - string, hash_alg - string}) - authenticating the request submission, links payload to requestId, so that only authenticated transition request could be submitted (ex., agent owner uses his private key to sign the tranistion request, or keyless agent submits ZK proof of correct transition from its source state to a new state). Structure:
     - `state` (string, 64 digit hex) - hash of the origin/source state of the transition
     - `pubkey` (string, hex) - public ID for the authentication
     - `signature` (string, hex) - signature/ZK-proof of the payload for the pubkey
     - `sign_alg` (string) - signature algorithm standard
     - `hash_alg` (string) - hash algorithm standard
 - **Returns:**
   - `result` (object) - responce from transport
### getInclusionProof
 - **Implements:** `aggregator_get_path`
 - **Arguments:**
   - `requestId` (string, 64 digit hex) - unique ID of the state transition request
   - `blockNum` (Optional, integer) - number of a specific block for which to extract the proof. Note, there is no guarantee proofs can be extracted for "ancient" blocks
 - **Returns:**
   - `result` (object) - responce from transport
### getNodelProof
 - **Implements:** `aggregator_get_nodel`
 - **Arguments:**
   - `blockNum` (Optional, integer) - number of a specific block for which to extract the proof. Note, there is no guarantee proofs can be extracted for "ancient" blocks
 - **Returns:**
   - `result` (object) - responce from transport

## JSON-RPC Client and Server Libraries

### JSON-RPC Client

The client uses JSON-RPC to communicate with the Aggregation layer.
#### send
 - **Implements:** Delivers API request to the Unicity Aggregator Layer gateway endpoint
 - **Arguments:**
   - `method` (string) - Unicity API method (ex., aggregator_submit, aggregator_get_path or aggregator_get_nodel)
   - `params` (object) - Struct containing parameters

### JSON-RPC Server

The server processes JSON-RPC requests and calls the corresponding handler functions.

## Example
You can submit and query the status of transaction requests via command-line tools. Use the source code of these tools as a reference.

### register_request.js
Use this to submit your state transition request via command line to the Unicity Aggregator Layer
 - **Usage:** node register_request.js <endpoint_url> <secret> <state> <transition>
   - `endpoint_url` - URL of the Unicity Aggregator Layer Gateway endpoint
   - `secret` - a secret phrase to be used for generating self-authenticated state transition request
   - `state` - a string containg origin state definition
   - `transition` - a string containing state transition from the origin state to some new state
- **Output:** result of the request submission. Note, successful submission does not guarantee that the strate transition request has been registered within the uni8city aggregation layer. It only means that the aggregaor gateway has received and validated the submission. In order to get the proof of the request submission use `get_request.js`

### get_request.js
Use this to request the profs about your state transition request via command line to the Unicity Aggregator Layer
 - **Usage:** node get_request.js <endpoint_url> <request_id>
   - `endpoint_url` - URL of the Unicity Aggregator Layer Gateway endpoint
   - `request_id` - the request id
- **Output:** the proofs

## Integration with your project
 - Include this github project as submodule in your project.
 - Import `UnicityProvider.js`, `JSONRPCTransport`, `SignerEC` and `SHA256Hasher` into your nodejs app.
 - Initialize Unicity provider as here (endpointUrl - url of the Unicity aggregator endpoint, secret - your agent secret, )
```
const transport = new JSONRPCTransport(endpointUrl);
const signer = new SignerEC(crypto.createHash('sha256').update(secret).digest('hex'));
const hasher = new SHA256Hasher();
const provider = new UnicityProvider(transport, signer, hasher);
```
 - Hint: calculate hash of the original `plaintext` as 64 digit hex string `crypto.createHash('sha256').update(plaintext).digest('hex')`
 - Submit state transition request as here (stateHash - hash of the original state as 64 digit hex string, payload - hash of the serialized state transition as 64 digit hex string)
```
try {
	const { requestId, result } = await provider.submitStateTransition(stateHash, payload);
        if (result.status === 'success') {
            console.log('Request successfully registered. Request ID:', requestId);
        } else {
            console.error('Failed to register request:', result);
        }
    } catch (err) {
        console.error('Error registering request:', err.message);
    }
```
 - get proof of the state transition request as here
```
try {
	const { status, path, nodel } = await provider.extractProofs(requestId);
	console.log(`STATUS: ${status}`);
	console.log(`PATH: ${JSON.stringify(path, null, 4)}`);
    } catch (err) {
        console.error('Error getting request:', err.message);
    }
```

## Summary

- **Transport-Agnostic Functions:** `AggregatorAPI` defines core functions for submitting and retrieving proofs.
- **JSON-RPC Client & Server:** Provides JSON-RPC-based communication for practical implementation.

This setup provides a robust, transport-agnostic way to communicate between the Agent and Aggregation layers, with JSON-RPC implementations for easy integration.
