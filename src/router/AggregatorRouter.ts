import bodyParser from 'body-parser';
import cors from 'cors';
import express, { Request, Response } from 'express';

import { IGatewayConfig } from '../AggregatorGateway.js';
import { AggregatorService } from '../AggregatorService.js';
import { generateDocsHtml } from '../docs/jsonRpcDocs.js';
import { LeaderElection } from '../highAvailability/LeaderElection.js';
import logger from '../logger.js';
import {
  handleSubmitCommitment,
  handleGetInclusionProof,
  handleGetNoDeletionProof,
  handleGetBlockHeight,
  handleGetBlock,
  handleGetBlockCommitments,
} from './AggregatorHandlers.js';
import { sendJsonRpcError } from './JsonRpcUtils.js';

export function setupRouter(
  config: IGatewayConfig,
  aggregatorService: AggregatorService,
  serverId: string,
  leaderElection: LeaderElection | null,
  maxConcurrentRequests: number,
): express.Application {
  const app = express();
  let activeRequests = 0;

  app.use(cors());
  app.use(bodyParser.json());

  app.get('/docs', (req: Request, res: Response) => {
    res.setHeader('Content-Type', 'text/html');
    res.send(generateDocsHtml());
  });

  app.get('/health', async (req: Request, res: Response) => {
    let smtRootHash: string | null = null;
    try {
      const hash = await aggregatorService?.getSmt().rootHash();
      smtRootHash = hash?.toString() ?? null;
    } catch (error) {
      logger.error('Error getting SMT root hash in health endpoint:', error);
    }

    res.status(200).json({
      status: 'ok',
      role:
        config.highAvailability?.enabled !== false
          ? leaderElection && leaderElection.isCurrentLeader()
            ? 'leader'
            : 'follower'
          : 'standalone',
      serverId: serverId,
      maxConcurrentRequests: maxConcurrentRequests,
      activeRequests: activeRequests,
      smtRootHash: smtRootHash,
    });
  });

  app.post('/', async (req: Request, res: Response) => {
    // Check if we're at capacity before processing the request
    if (config.aggregatorConfig?.concurrencyLimit && activeRequests >= maxConcurrentRequests) {
      logger.warn(`Concurrency limit reached (${activeRequests}/${maxConcurrentRequests}). Request rejected.`);
      sendJsonRpcError(res, 503, -32000, 'Server is at capacity. Please try again later.', req.body?.id || null);
      return;
    }

    if (config.aggregatorConfig?.concurrencyLimit) {
      activeRequests++;
      let countDecremented = false;

      // decrement counter only once
      const decrementCounter = (): void => {
        if (!countDecremented) {
          countDecremented = true;
          activeRequests--;
        }
      };

      // Listen for normal completion
      res.on('finish', decrementCounter);

      // Also listen for abrupt connection close
      res.on('close', decrementCounter);
    }

    if (!aggregatorService) {
      sendJsonRpcError(res, 500, -32603, 'Internal error: Service not initialized.', req.body.id);
      return;
    }

    if (req.body.jsonrpc !== '2.0' || !req.body.params) {
      sendJsonRpcError(res, 400, -32600, 'Invalid Request: Not a valid JSON-RPC 2.0 request', req.body.id);
      return;
    }

    try {
      switch (req.body.method) {
        case 'submit_commitment':
          await handleSubmitCommitment(req, res, aggregatorService);
          break;
        case 'get_inclusion_proof':
          await handleGetInclusionProof(req, res, aggregatorService);
          break;
        case 'get_no_deletion_proof':
          await handleGetNoDeletionProof(req, res, aggregatorService);
          break;
        case 'get_block_height':
          await handleGetBlockHeight(req, res, aggregatorService);
          break;
        case 'get_block':
          await handleGetBlock(req, res, aggregatorService);
          break;
        case 'get_block_commitments':
          await handleGetBlockCommitments(req, res, aggregatorService);
          break;
        default:
          res.sendStatus(400);
          break;
      }
    } catch (error) {
      logger.error(`Error processing ${req.body.method}:`, error);
      sendJsonRpcError(
        res,
        500,
        -32603,
        `Internal error: ${error instanceof Error ? error.message : 'Unknown error'}`,
        req.body.id,
      );
    }
  });

  return app;
}
