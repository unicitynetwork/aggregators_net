import mongoose from 'mongoose';
const { MongoErrorLabel } = mongoose.mongo;

import logger from '../logger.js';

/**
 * Configuration options for transaction retry behavior
 */
export interface TransactionRetryOptions {
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
}

/**
 * Default retry configuration
 */
const DEFAULT_RETRY_OPTIONS: Required<TransactionRetryOptions> = {
  maxRetries: 3,
  baseDelayMs: 100,
  maxDelayMs: 5000,
};

/**
 * Determines if an error is retryable based on MongoDB error codes and labels.
 * This is specifically for transaction retry logic.
 * Note: Regular write operations are automatically retried by the driver when retryWrites=true.
 */
function isRetryableError(error: any): boolean {
  // Check for MongoDB error labels
  if (error.errorLabels && Array.isArray(error.errorLabels)) {
    if (error.errorLabels.includes(MongoErrorLabel.TransientTransactionError) || 
        error.errorLabels.includes(MongoErrorLabel.UnknownTransactionCommitResult)) {
      return true;
    }
  }

  // Check for WriteConflict error code
  if (error.code === 112 || error.codeName === 'WriteConflict') {
    return true;
  }

  return false;
}

/**
 * Executes a function within a MongoDB transaction with automatic retry logic.
 */
export async function withTransaction<T>(
  operation: (session: mongoose.ClientSession) => Promise<T>,
  options: TransactionRetryOptions = {}
): Promise<T> {
  const config = { ...DEFAULT_RETRY_OPTIONS, ...options };
  
  for (let attempt = 1; attempt <= config.maxRetries; attempt++) {
    const session = await mongoose.startSession();

    try {
      session.startTransaction();
      
      const result = await operation(session);
      
      await session.commitTransaction();
      logger.debug(`Transaction completed successfully on attempt ${attempt}`);
      return result;
      
    } catch (error) {
      logger.error(`Transaction failed on attempt ${attempt}/${config.maxRetries}:`, error);
      
      try {
        await session.abortTransaction();
      } catch (abortError) {
        logger.error('Error aborting transaction:', abortError);
      }

      // Check if this is a retryable error
      const isRetryable = isRetryableError(error);

      if (attempt === config.maxRetries || !isRetryable) {
        throw error;
      }

      // Calculate delay with exponential backoff
      const delayMs = Math.min(config.baseDelayMs * Math.pow(2, attempt - 1), config.maxDelayMs);
      
      logger.debug(`Retrying transaction in ${delayMs}ms...`);
      await new Promise(resolve => setTimeout(resolve, delayMs));
      
    } finally {
      await session.endSession();
    }
  }

  throw new Error('Transaction failed after maximum retries'); // Should never reach here
} 