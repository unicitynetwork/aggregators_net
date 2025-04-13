import mongoose from 'mongoose';

import { CommitmentStorage } from './commitment/CommitmentStorage.js';
import { ICommitmentStorage } from './commitment/ICommitmentStorage.js';
import { BlockStorage } from './hashchain/BlockStorage.js';
import { IBlockStorage } from './hashchain/IBlockStorage.js';
import logger from './logger.js';
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
      const mongooseOptions = {
        connectTimeoutMS: 15000,
        heartbeatFrequencyMS: 1000,
        serverSelectionTimeoutMS: 30000,
      };
      await mongoose
        .connect(uri, mongooseOptions)
        .then(() => logger.info('Connected to MongoDB successfully.'))
        .catch((err) => logger.error('Failed to connect to MongoDB: ', err));

      mongoose.connection.on('error', (error) => {
        logger.error('MongoDB connection error: ', error);
      });

      mongoose.connection.on('disconnected', () => {
        logger.info('MongoDB disconnected.');
      });

      mongoose.connection.on('reconnected', () => {
        logger.info('MongoDB reconnected successfully.');
      });

      return new AggregatorStorage();
    } catch (error) {
      logger.error('Failed to connect to MongoDB: ', error);
      throw error;
    }
  }

  public async close(): Promise<void> {
    await mongoose
      .disconnect()
      .then(() => 'MongoDB connection closed.')
      .catch((err) => logger.error('Error closing MongoDB connection: ', err));
  }
}
