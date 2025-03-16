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
                serverSelectionTimeoutMS: 5000,
                connectTimeoutMS: 10000
            });

            mongoose.connection.on('error', (error) => {
                console.error('MongoDB connection error:', error);
                process.exit(1);
            });

            mongoose.connection.on('disconnected', () => {
                console.error('MongoDB disconnected. Exiting...');
                process.exit(1);
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