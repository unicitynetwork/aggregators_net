import mongoose from 'mongoose';

import { CommitmentStorage } from './commitment/CommitmentStorage.js';
import { ICommitmentStorage } from './commitment/ICommitmentStorage.js';
import { BlockStorage } from './hashchain/BlockStorage.js';
import { IBlockStorage } from './hashchain/IBlockStorage.js';
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

  private constructor() {
    this.smtStorage = new SmtStorage();
    this.blockStorage = new BlockStorage();
    this.recordStorage = new AggregatorRecordStorage();
    this.blockRecordsStorage = new BlockRecordsStorage();
    this.commitmentStorage = new CommitmentStorage();
  }

  public static async init(uri: string): Promise<AggregatorStorage> {
    try {
      console.log('Connecting to MongoDB URI %s.', uri);
      await mongoose.connect(uri, {
        connectTimeoutMS: 15000,
        heartbeatFrequencyMS: 1000,
        serverSelectionTimeoutMS: 30000,
      });

      mongoose.connection.on('error', (error) => {
        console.error('MongoDB connection error: ', error);
      });

      mongoose.connection.on('disconnected', () => {
        console.log('MongoDB disconnected.');
      });

      mongoose.connection.on('reconnected', () => {
        console.log('MongoDB reconnected successfully.');
      });

      console.log('Connected to MongoDB successfully.');
      return new AggregatorStorage();
    } catch (error) {
      console.error('Failed to connect to MongoDB: ', error);
      throw error;
    }
  }

  public async close(): Promise<void> {
    try {
      await mongoose.disconnect();
      console.log('MongoDB connection closed.');
    } catch (error) {
      console.error('Error closing MongoDB connection: ', error);
      throw error;
    }
  }
}
