import mongoose, { ConnectOptions } from 'mongoose';

import { CommitmentStorage } from './commitment/CommitmentStorage.js';
import { ICommitmentStorage } from './commitment/ICommitmentStorage.js';
import { BlockStorage } from './hashchain/BlockStorage.js';
import { IBlockStorage } from './hashchain/IBlockStorage.js';
import logger from './logger.js';
import { AggregatorRecordStorage } from './records/AggregatorRecordStorage.js';
import { BlockRecordsStorage } from './records/BlockRecordsStorage.js';
import { IAggregatorRecordStorage } from './records/IAggregatorRecordStorage.js';
import { IBlockRecordsStorage } from './records/IBlockRecordsStorage.js';
import { ISmtStorage } from './smt/ISmtStorage.js';
import { SmtStorage } from './smt/SmtStorage.js';

export class AggregatorStorage {
  public readonly smtStorage: ISmtStorage;
  public readonly blockStorage: IBlockStorage;
  public readonly recordStorage: IAggregatorRecordStorage;
  public readonly blockRecordsStorage: IBlockRecordsStorage;
  public readonly commitmentStorage: ICommitmentStorage;

  private constructor(
    smtStorage: ISmtStorage,
    blockStorage: IBlockStorage,
    recordStorage: IAggregatorRecordStorage,
    blockRecordsStorage: IBlockRecordsStorage,
    commitmentStorage: ICommitmentStorage
  ) {
    this.smtStorage = smtStorage;
    this.blockStorage = blockStorage;
    this.recordStorage = recordStorage;
    this.blockRecordsStorage = blockRecordsStorage;
    this.commitmentStorage = commitmentStorage;
  }

  public static async init(uri: string, serverId: string): Promise<AggregatorStorage> {
    try {
      logger.info('Connecting to MongoDB...');
      const mongooseOptions: ConnectOptions = {
        connectTimeoutMS: 15000,
        heartbeatFrequencyMS: 1000,
        serverSelectionTimeoutMS: 30000,
        writeConcern: {
          w: 'majority', // Wait for the majority of the replicas to acknowledge the write
          j: true, // Wait for the journal to flush the write to disk
        },
      };
      try {
        await mongoose.connect(uri, mongooseOptions);
        logger.info('Connected to MongoDB successfully.');
        logger.debug('Connection details:', {
          host: mongoose.connection.host,
          port: mongoose.connection.port,
          name: mongoose.connection.name,
        });
      } catch (error) {
        logger.error('Failed to connect to MongoDB: ', error);
        throw error;
      }

      mongoose.connection.on('error', (error) => {
        logger.error('MongoDB connection error: ', error);
      });

      mongoose.connection.on('disconnected', () => {
        logger.info('MongoDB disconnected.');
      });

      mongoose.connection.on('reconnected', () => {
        logger.info('MongoDB reconnected successfully.');
      });

      const smtStorage = new SmtStorage();
      const blockStorage = new BlockStorage();
      const recordStorage = new AggregatorRecordStorage();
      const blockRecordsStorage = await BlockRecordsStorage.create(serverId);
      const commitmentStorage = new CommitmentStorage();

      const storage = new AggregatorStorage(
        smtStorage,
        blockStorage,
        recordStorage,
        blockRecordsStorage,
        commitmentStorage
      );

      return storage;
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
