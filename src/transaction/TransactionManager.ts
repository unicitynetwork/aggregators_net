import mongoose from 'mongoose';

import logger from '../logger.js';
import { ITransactionManager } from './ITransactionManager.js';

/**
 * Manages MongoDB transactions across multiple storage operations.
 * Provides a unified way to execute multiple database operations within a single atomic transaction.
 */
export class TransactionManager implements ITransactionManager<mongoose.ClientSession> {
  /**
   * Executes the provided operation within a MongoDB transaction.
   * If the operation succeeds, the transaction is committed. If it fails, the transaction is aborted.
   *
   * @param operation A function that takes a session and performs database operations
   * @returns The result of the operation
   * @throws If the operation fails, the transaction is aborted and the error is rethrown
   */
  public async withTransaction<T>(operation: (session: mongoose.ClientSession) => Promise<T>): Promise<T> {
    const session = await mongoose.startSession();

    try {
      session.startTransaction();

      logger.debug('Transaction started');
      const result = await operation(session);

      await session.commitTransaction();
      logger.debug('Transaction committed successfully');

      return result;
    } catch (error) {
      logger.error('Transaction failed, aborting:', error);
      try {
        await session.abortTransaction();
      } catch (abortError) {
        logger.error('Error aborting transaction:', abortError);
      }
      throw error;
    } finally {
      await session.endSession();
      logger.debug('Transaction session ended');
    }
  }
}
