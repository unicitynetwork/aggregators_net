import mongoose from 'mongoose';

import { CommitmentStorage } from './commitment/CommitmentStorage.js';
import { ICommitmentStorage } from './commitment/ICommitmentStorage.js';
import { BlockStorage } from './hashchain/BlockStorage.js';
import { IBlockStorage } from './hashchain/IBlockStorage.js';
import logger from './index.js';
import { AggregatorRecordStorage } from './records/AggregatorRecordStorage.js';
import { IAggregatorRecordStorage } from './records/IAggregatorRecordStorage.js';
import { ISmtStorage } from './smt/ISmtStorage.js';
import { SmtStorage } from './smt/SmtStorage.js';

export class AggregatorStorage {
  public readonly smtStorage: ISmtStorage;
  public readonly blockStorage: IBlockStorage;
  public readonly recordStorage: IAggregatorRecordStorage;
  public readonly commitmentStorage: ICommitmentStorage;

  private constructor() {
    this.smtStorage = new SmtStorage();
    this.blockStorage = new BlockStorage();
    this.recordStorage = new AggregatorRecordStorage();
    this.commitmentStorage = new CommitmentStorage();
  }

  public static async init(uri: string): Promise<AggregatorStorage> {
    try {
      logger.info('Connecting to MongoDB URI %s.', uri);
      await mongoose.connect(uri, {
        connectTimeoutMS: 15000,
        heartbeatFrequencyMS: 1000,
        serverSelectionTimeoutMS: 30000,
      });

      mongoose.connection.on('error', (error) => {
        logger.error('MongoDB connection error: ', error);
      });

      mongoose.connection.on('disconnected', () => {
        logger.info('MongoDB disconnected.');
      });

      mongoose.connection.on('reconnected', () => {
        logger.info('MongoDB reconnected successfully.');
      });

      logger.info('Connected to MongoDB successfully.');
      return new AggregatorStorage();
    } catch (error) {
      logger.error('Failed to connect to MongoDB: ', error);
      throw error;
    }
  }

  public async close(): Promise<void> {
    try {
      await mongoose.disconnect();
      logger.info('MongoDB connection closed.');
    } catch (error) {
      logger.error('Error closing MongoDB connection: ', error);
      throw error;
    }
  }
}
