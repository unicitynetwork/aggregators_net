import { MongoDBContainer } from '@testcontainers/mongodb';
import mongoose from 'mongoose';
import { StartedTestContainer } from 'testcontainers';

export async function startMongoDb(): Promise<StartedTestContainer> {
  const container = await new MongoDBContainer('mongo:7').start();
  const uri = container.getConnectionString();
  console.log(`Connecting to MongoDB, using connection URI: ${uri}.`);
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 5000, directConnection: true });
  console.log('Connected successfully.');
  return container;
}

export async function stopMongoDb(container: StartedTestContainer): Promise<void> {
  console.log('\nStopping MongoDB container...');
  await container.stop({ timeout: 10 });
  console.log('Test completed.');
}
