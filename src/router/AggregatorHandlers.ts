import { Authenticator } from '@unicitylabs/commons/lib/api/Authenticator.js';
import { RequestId } from '@unicitylabs/commons/lib/api/RequestId.js';
import { DataHash } from '@unicitylabs/commons/lib/hash/DataHash.js';
import { HexConverter } from '@unicitylabs/commons/lib/util/HexConverter.js';
import { SubmitCommitmentStatus } from '@unicitylabs/commons/lib/api/SubmitCommitmentResponse.js';
import { Request, Response } from 'express';

import { AggregatorService } from '../AggregatorService.js';
import { Commitment } from '../commitment/Commitment.js';
import logger from '../logger.js';
import { sendJsonRpcError, parseBoolean } from './JsonRpcUtils.js';

export async function handleSubmitCommitment(
  req: Request,
  res: Response,
  aggregatorService: AggregatorService,
): Promise<void> {
  logger.info(`Received submit_commitment request: ${req.body.params.requestId}`);

  const missingFields = [];
  if (!req.body.params.requestId) missingFields.push('requestId');
  if (!req.body.params.transactionHash) missingFields.push('transactionHash');
  if (!req.body.params.authenticator) missingFields.push('authenticator');

  if (missingFields.length > 0) {
    sendJsonRpcError(
      res,
      400,
      -32602,
      `Invalid parameters: Missing required fields: ${missingFields.join(', ')}`,
      req.body.id,
    );
    return;
  }

  let commitment: Commitment;
  try {
    const requestId: RequestId = RequestId.fromJSON(req.body.params.requestId);
    const transactionHash: DataHash = DataHash.fromJSON(req.body.params.transactionHash);
    const authenticator: Authenticator = Authenticator.fromJSON(req.body.params.authenticator);
    commitment = new Commitment(requestId, transactionHash, authenticator);
  } catch (error) {
    sendJsonRpcError(res, 400, -32602, 'Invalid parameters: Could not create commitment', req.body.id, {
      details: error instanceof Error ? error.message : 'Unknown error',
    });
    return;
  }

  const response = await aggregatorService.submitCommitment(commitment, parseBoolean(req.body.params.receipt));
  if (response.status !== SubmitCommitmentStatus.SUCCESS) {
    sendJsonRpcError(res, 400, -32000, 'Failed to submit commitment', req.body.id, response.toJSON());
    return;
  }

  res.json({
    jsonrpc: '2.0',
    result: response.toJSON(),
    id: req.body.id,
  });
}

export async function handleGetInclusionProof(
  req: Request,
  res: Response,
  aggregatorService: AggregatorService,
): Promise<void> {
  logger.info(`Received get_inclusion_proof request: ${req.body.params.requestId}`);

  if (!req.body.params.requestId) {
    sendJsonRpcError(res, 400, -32602, 'Invalid parameters: Missing required field: requestId', req.body.id);
    return;
  }

  let requestId: RequestId;
  try {
    requestId = RequestId.fromJSON(req.body.params.requestId);
  } catch (error) {
    sendJsonRpcError(res, 400, -32602, 'Invalid parameters: Invalid requestId format', req.body.id, {
      details: error instanceof Error ? error.message : 'Unknown error',
    });
    return;
  }

  const inclusionProof = await aggregatorService.getInclusionProof(requestId);
  if (inclusionProof == null) {
    sendJsonRpcError(res, 404, -32001, 'Inclusion proof not found', req.body.id);
    return;
  }
  res.json({
    jsonrpc: '2.0',
    result: inclusionProof.toJSON(),
    id: req.body.id,
  });
}

export async function handleGetNoDeletionProof(
  req: Request,
  res: Response,
  aggregatorService: AggregatorService,
): Promise<void> {
  const noDeletionProof = await aggregatorService.getNoDeletionProof();
  if (noDeletionProof == null) {
    sendJsonRpcError(res, 404, -32001, 'No deletion proof not found', req.body.id);
    return;
  }
  res.json({
    jsonrpc: '2.0',
    result: noDeletionProof,
    id: req.body.id,
  });
}

export async function handleGetBlockHeight(
  req: Request,
  res: Response,
  aggregatorService: AggregatorService,
): Promise<void> {
  logger.info('Received get_block_height request');
  const currentBlockNumber = await aggregatorService.getCurrentBlockNumber();
  res.json({
    jsonrpc: '2.0',
    result: { blockNumber: currentBlockNumber.toString() },
    id: req.body.id,
  });
}

export async function handleGetBlock(req: Request, res: Response, aggregatorService: AggregatorService): Promise<void> {
  logger.info(`Received get_block request: ${req.body.params.blockNumber}`);

  if (!req.body.params.blockNumber) {
    sendJsonRpcError(res, 400, -32602, 'Invalid parameters: blockNumber is required', req.body.id);
    return;
  }

  let blockNumber;
  try {
    // Handle "latest" as a special case
    if (req.body.params.blockNumber === 'latest') {
      blockNumber = await aggregatorService.getCurrentBlockNumber();
    } else {
      blockNumber = BigInt(req.body.params.blockNumber);
    }
  } catch {
    sendJsonRpcError(
      res,
      400,
      -32602,
      'Invalid parameters: blockNumber must be a valid number or "latest"',
      req.body.id,
    );
    return;
  }

  const block = await aggregatorService.getBlockByNumber(blockNumber);

  if (!block) {
    sendJsonRpcError(res, 404, -32001, `Block ${blockNumber.toString()} not found`, req.body.id);
    return;
  }

  res.json({
    jsonrpc: '2.0',
    result: {
      index: block.index.toString(),
      chainId: block.chainId,
      version: block.version,
      forkId: block.forkId,
      timestamp: block.timestamp.toString(),
      rootHash: block.rootHash.toJSON(),
      previousBlockHash: HexConverter.encode(block.previousBlockHash),
      noDeletionProofHash: block.noDeletionProofHash ? HexConverter.encode(block.noDeletionProofHash) : null,
    },
    id: req.body.id,
  });
}

export async function handleGetBlockCommitments(
  req: Request,
  res: Response,
  aggregatorService: AggregatorService,
): Promise<void> {
  logger.info(`Received get_block_commitments request: ${req.body.params.blockNumber}`);

  if (!req.body.params.blockNumber) {
    sendJsonRpcError(res, 400, -32602, 'Invalid parameters: blockNumber is required', req.body.id);
    return;
  }

  let blockNumber;
  try {
    blockNumber = BigInt(req.body.params.blockNumber);
  } catch {
    sendJsonRpcError(res, 400, -32602, 'Invalid parameters: blockNumber must be a valid number', req.body.id);
    return;
  }

  const commitments = await aggregatorService.getCommitmentsByBlockNumber(blockNumber);

  if (commitments === null) {
    sendJsonRpcError(res, 404, -32001, `Block ${blockNumber.toString()} not found`, req.body.id);
    return;
  }

  res.json({
    jsonrpc: '2.0',
    result: commitments.map((commitment) => ({
      requestId: commitment.requestId.toJSON(),
      transactionHash: commitment.transactionHash.toJSON(),
      authenticator: commitment.authenticator.toJSON(),
    })),
    id: req.body.id,
  });
}
