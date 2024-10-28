# Unicity Agent-Aggregator API

This repository contains the API definition and JavaScript implementations for communication between the Agent and Aggregation layers on the Unicity blockchain platform.

## Overview

Unicity's infrastructure comprises a decentralized Agent layer interacting with a hierarchical Proof Aggregation layer. The communication API enables agents to:
1. Submit state transition requests to the Aggregation layer.
2. Retrieve unicity proofs that include timestamped inclusion proofs and global non-deletion proofs.

## API Operations

### 1. Submit State Transition Request
- **Operation:** `submitStateTransition`
- **Description:** Allows an agent to submit a state transition request to the Aggregation layer.
- **Input:**
  - `requestId` (string): The unique identifier for the request.
  - `payload` (string): The hash of the state transition.
  - `authenticator` (string): Digital signature of the payload signed by the agent's private key.
- **Output:**
  - `success` (boolean): Indicates if the request was successfully submitted.
  - `transactionId` (string): A unique identifier for tracking the state transition request.

### 2. Get Unicity Proof
- **Operation:** `getUnicityProof`
- **Description:** Retrieves the unicity proof for a specific state transition request.
- **Input:**
  - `requestId` (string): The unique identifier for the state transition request.
- **Output:**
  - `inclusionProof` (object): Contains proof elements showing the request's inclusion in the SMT.
  - `nonDeletionProof` (object): Zero-knowledge proof confirming no deletion has occurred.

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
