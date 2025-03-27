import { Db } from 'mongodb';
import mongoose from 'mongoose';

import { AggregatorRecordStorage } from './AggregatorRecordStorage.js';
import { SmtStorage } from './SmtStorage.js';
import { IAggregatorRecordStorage } from '../../records/IAggregatorRecordStorage.js';
import { ISmtStorage } from '../../smt/ISmtStorage.js';

export class Storage {
  public readonly smt: ISmtStorage;
  public readonly records: IAggregatorRecordStorage;
  public readonly db: Db;

  private constructor() {
    this.smt = new SmtStorage();
    this.records = new AggregatorRecordStorage();

    if (!mongoose.connection.db) {
      throw new Error('MongoDB connection not initialized');
    }
    // Use type assertion to handle version mismatch between mongoose's mongodb and direct mongodb import
    this.db = mongoose.connection.db as unknown as Db;
  }

  public static async init(uri: string): Promise<Storage> {
    try {
      console.log('Connecting to MongoDB URI %s', uri);
      await mongoose.connect(uri, {
        connectTimeoutMS: 15000,
        heartbeatFrequencyMS: 1000,
        serverSelectionTimeoutMS: 30000,
      });

      mongoose.connection.on('error', (error) => {
        console.error('MongoDB connection error:', error);
      });

      mongoose.connection.on('disconnected', () => {
        console.log('MongoDB disconnected');
      });

      mongoose.connection.on('reconnected', () => {
        console.log('MongoDB reconnected successfully');
      });

      console.log('Connected to MongoDB successfully');
      return new Storage();
    } catch (error) {
      console.error('Failed to connect to MongoDB:', error);
      throw error;
    }
  }

  public async close(): Promise<void> {
    try {
      await mongoose.disconnect();
      console.log('MongoDB connection closed');
    } catch (error) {
      console.error('Error closing MongoDB connection:', error);
      throw error;
    }
  }
}
