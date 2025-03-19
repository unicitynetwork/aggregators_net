import mongoose from 'mongoose';
import { ISmtStorage } from '../../smt/ISmtStorage.js';
import { IAggregatorRecordStorage } from '../../records/IAggregatorRecordStorage.js';
import { SmtStorage } from './SmtStorage.js';
import { AggregatorRecordStorage } from './AggregatorRecordStorage.js';

export class Storage {
    public readonly smt: ISmtStorage;
    public readonly records: IAggregatorRecordStorage;

    private constructor() {
        this.smt = new SmtStorage();
        this.records = new AggregatorRecordStorage();
    }

    static async init(): Promise<Storage> {
        const mongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017,localhost:27018,localhost:27019/?replicaSet=rs0';

        try {
            console.log('Connecting to MongoDB...');
            await mongoose.connect(mongoUri, {
                serverSelectionTimeoutMS: 30000,
                connectTimeoutMS: 15000,
                heartbeatFrequencyMS: 1000,
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

    async close(): Promise<void> {
        try {
            await mongoose.disconnect();
            console.log('MongoDB connection closed');
        } catch (error) {
            console.error('Error closing MongoDB connection:', error);
            throw error;
        }
    }
}