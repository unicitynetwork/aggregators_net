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
  - `requestId` (string): The unique identifier for the request.
  - `payload` (string): The hash of the state transition.
  - `authenticator` (string): Digital signature of the payload signed by the agent's private key.
- **Output:**
  - `success` (boolean): Indicates if the request was successfully submitted.

### 2. Get Inclusion/exclusion proof
- **Operation:** `aggregator_get_path`
- **Description:** Retrieves the individual inclusion/exclusion proof for a specific state transition request at specific block number
- **Input:**
  - `requestId` (string): The unique identifier for the state transition request.
  - `blockNum` (integer): the block number for which to generate the inclusion/exclusion proof (normally, a hash path between the root at the given blockNum and the respective leaf position corresponding to the requestId)
- **Output:**
  - `inclusionProof` (object): Contains proof elements showing the request's inclusion in the SMT (or its exclusion otherwise).
  - `nonDeletionProof` (object): Zero-knowledge proof confirming no deletion has occurred.

### 3. Get No-Deletion proof
- **Operation:** `aggregator_get_nodel`
- **Description:** Retrieves the global nodeletion proof for the aggregator data structure at specific block number (the nodel proof is recursive, it proves already no deletion/modification of any aggregator records since the genesis till the current blocknum)
- **Input:**
  - `blockNum` (integer): the block number for which to generate the inclusion/exclusion proof (normally, a hash path between the root at the given blockNum and the respective leaf position corresponding to the requestId)
- **Output:**
  - `nonDeletionProof` (object): Zero-knowledge proof confirming no deletion has occurred since the genesis.

## Transport-Agnostic JavaScript Functions

The `AggregatorAPI` class provides transport-agnostic functions for submitting requests and fetching proofs.

## JSON-RPC Client and Server Libraries

### JSON-RPC Client

The client uses JSON-RPC to communicate with the Aggregation layer.

### JSON-RPC Server

The server processes JSON-RPC requests and calls the corresponding handler functions.


## Summary

- **Transport-Agnostic Functions:** `AggregatorAPI` defines core functions for submitting and retrieving proofs.
- **JSON-RPC Client & Server:** Provides JSON-RPC-based communication for practical implementation.

This setup provides a robust, transport-agnostic way to communicate between the Agent and Aggregation layers, with JSON-RPC implementations for easy integration.
