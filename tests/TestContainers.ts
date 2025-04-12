import { MongoDBContainer } from '@testcontainers/mongodb';
import mongoose from 'mongoose';
import { StartedTestContainer } from 'testcontainers';

import logger from '../src/index.js';

export async function startMongoDb(): Promise<StartedTestContainer> {
  const container = await new MongoDBContainer('mongo:7').start();
  const uri = container.getConnectionString();
  logger.info(`Connecting to MongoDB, using connection URI: ${uri}.`);
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 5000, directConnection: true });
  logger.info('Connected successfully.');
  return container;
}

export async function stopMongoDb(container: StartedTestContainer): Promise<void> {
  logger.info('\nStopping MongoDB container...');
  await container.stop({ timeout: 10 });
  logger.info('Test completed.');
}
