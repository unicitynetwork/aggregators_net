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

## Transport-Agnostic JavaScript Functions
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

### JSON-RPC Server

The server processes JSON-RPC requests and calls the corresponding handler functions.


## Summary

- **Transport-Agnostic Functions:** `AggregatorAPI` defines core functions for submitting and retrieving proofs.
- **JSON-RPC Client & Server:** Provides JSON-RPC-based communication for practical implementation.

This setup provides a robust, transport-agnostic way to communicate between the Agent and Aggregation layers, with JSON-RPC implementations for easy integration.
