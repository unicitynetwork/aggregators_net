import path, { dirname } from 'path';
import { fileURLToPath } from 'url';
import { availableParallelism } from 'os';
import { existsSync } from 'fs';
import { spawn, Pool, Worker, ModuleThread } from 'threads';
import { HexConverter } from '@unicitylabs/commons/lib/util/HexConverter.js';
import { Commitment } from './commitment/Commitment.js';
import { ValidationRequest, ValidationResult } from './workers/validation-worker.js';
import logger from './logger.js';

export interface IValidationService {
  initialize(mongoUri: string): Promise<void>;
  validateCommitment(commitment: Commitment): Promise<ValidationResult>;
  terminate(): Promise<void>;
}

interface ValidationWorkerMethods {
  validateCommitment(request: ValidationRequest): Promise<ValidationResult>;
  [methodName: string]: (...args: any[]) => any;
}

type ValidationWorker = ModuleThread<ValidationWorkerMethods>;

export class ValidationService implements IValidationService {
  private pool: Pool<ValidationWorker> | null = null;
  private mongoUri: string = '';

  constructor(private readonly threads: number = Math.min(4, availableParallelism())) {}

  public async initialize(mongoUri: string): Promise<void> {
    this.mongoUri = mongoUri;
    
    const workerPath = path.resolve(__dirname, './workers/validation-worker.cjs');
    
    if (!existsSync(workerPath)) {
      throw new Error(`Validation worker not found at ${workerPath}. Make sure to run 'npm run build' first.`);
    }

    logger.info(`Initializing validation service with ${this.threads} worker threads`);
    logger.info(`Using worker at: ${workerPath}`);

    this.pool = Pool(() => spawn<ValidationWorkerMethods>(new Worker(workerPath)), {
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