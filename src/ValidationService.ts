import { resolve } from 'path';
import { availableParallelism } from 'os';
import { existsSync } from 'fs';
// @ts-ignore - threads.js has module resolution issues
import { spawn, Pool, Worker } from 'threads';
import { SubmitCommitmentStatus } from '@unicitylabs/commons/lib/api/SubmitCommitmentResponse.js';
import { HexConverter } from '@unicitylabs/commons/lib/util/HexConverter.js';
import { Commitment } from './commitment/Commitment.js';
import logger from './logger.js';

export interface ValidationResult {
  status: SubmitCommitmentStatus;
  exists: boolean;
}

export interface IValidationService {
  initialize(mongoUri: string): Promise<void>;
  validateCommitment(commitment: Commitment): Promise<ValidationResult>;
  terminate(): Promise<void>;
}

type ValidationWorker = {
  validateCommitment(request: {
    commitment: {
      requestId: string;
      transactionHash: string;
      authenticator: {
        algorithm: string;
        publicKey: string;
        signature: string;
        stateHash: string;
      };
    };
    mongoUri: string;
  }): Promise<ValidationResult>;
};

export class ValidationService implements IValidationService {
  private pool: Pool<ValidationWorker> | null = null;
  private mongoUri: string = '';

  constructor(private readonly threads: number = Math.min(4, availableParallelism())) {}

  public async initialize(mongoUri: string): Promise<void> {
    this.mongoUri = mongoUri;
    
    const workerPath = resolve(process.cwd(), 'dist/workers/validation-worker.cjs');
    
    if (!existsSync(workerPath)) {
      throw new Error(`Validation worker not found at ${workerPath}. Make sure to run 'npm run build' first.`);
    }

    logger.info(`Initializing validation service with ${this.threads} worker threads`);

    this.pool = Pool(() => spawn<ValidationWorker>(new Worker(workerPath)), {
      size: this.threads,
      concurrency: this.threads
    });

    logger.info('Validation service initialized successfully');
  }

  public async validateCommitment(commitment: Commitment): Promise<ValidationResult> {
    if (!this.pool) {
      throw new Error('ValidationService not initialized. Call initialize() first.');
    }

    const request = {
      commitment: {
        requestId: commitment.requestId.toJSON(),
        transactionHash: commitment.transactionHash.toJSON(),
        authenticator: {
          algorithm: commitment.authenticator.algorithm,
          publicKey: HexConverter.encode(commitment.authenticator.publicKey),
          signature: HexConverter.encode(commitment.authenticator.signature.encode()),
          stateHash: commitment.authenticator.stateHash.toJSON()
        }
      },
      mongoUri: this.mongoUri
    };

    const result = await this.pool.queue(async (worker: ValidationWorker) => {
      return await worker.validateCommitment(request);
    });

    return result;
  }

  public async terminate(): Promise<void> {
    if (this.pool) {
      logger.info('Terminating validation service worker pool...');
      await this.pool.terminate();
      this.pool = null;
      logger.info('Validation service terminated');
    }
  }
} 