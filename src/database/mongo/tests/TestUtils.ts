import { GenericContainer, StartedTestContainer } from 'testcontainers';
import mongoose from 'mongoose';

export async function setupTestDatabase(): Promise<{
    container: StartedTestContainer;
    uri: string;
}> {
    const container = await new GenericContainer("mongo:7")
        .withExposedPorts(27017)
        .withCommand(["mongod", "--noauth"])
        .start();

    const mappedPort = container.getMappedPort(27017);
    const uri = `mongodb://127.0.0.1:${mappedPort}/test?directConnection=true`;
    
    console.log('Connecting to MongoDB...');
    console.log(`Using connection URI: ${uri}`);
    
    await mongoose.connect(uri, { serverSelectionTimeoutMS: 5000 });
    console.log('Connected successfully');

    await mongoose.connection.dropDatabase();

    return { container, uri };
}

export async function teardownTestDatabase(container: StartedTestContainer): Promise<void> {
    await mongoose.disconnect();
    console.log('\nStopping MongoDB container...');
    await container.stop();
    console.log('Test completed');
}