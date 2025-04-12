import { MongoDBContainer } from '@testcontainers/mongodb';
import mongoose from 'mongoose';
import { StartedTestContainer } from 'testcontainers';

import logger from '../src/Logger.js';

export async function startMongoDb(): Promise<StartedTestContainer> {
  const container = await new MongoDBContainer('mongo:7').start();
  const uri = container.getConnectionString();
  logger.info(`Connecting to MongoDB URI %s.`, uri);
  await mongoose
    .connect(uri, { serverSelectionTimeoutMS: 5000, directConnection: true })
    .then(() => logger.info('Connected successfully.'))
    .catch((err) => logger.error('Failed to connect to MongoDB: ', err));
  return container;
}

export async function stopMongoDb(container: StartedTestContainer): Promise<void> {
  logger.info('Stopping MongoDB container...');
  await container.stop({ timeout: 10 });
  logger.info('Test completed.');
}
