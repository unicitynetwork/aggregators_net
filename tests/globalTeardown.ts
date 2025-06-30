import { StartedTestContainer } from 'testcontainers';

interface IReplicaSet {
  containers: StartedTestContainer[];
  uri: string;
}

export default async function globalTeardown() {
  console.log('Stopping global MongoDB replica set...');
  
  const globalReplicaSet = (global as any).__MONGO_REPLICA_SET__ as IReplicaSet | null;
  
  if (globalReplicaSet?.containers) {
    try {
      await Promise.all(globalReplicaSet.containers.map(container => container.stop()));
      console.log('Global MongoDB replica set stopped successfully');
    } catch (error) {
      console.error('Error stopping global MongoDB replica set:', error);
    }
  } else {
    console.warn('No global MongoDB replica set found to stop');
  }
  
  // Clean up global variables
  delete (global as any).__MONGO_URI__;
  delete (global as any).__MONGO_REPLICA_SET__;
} 