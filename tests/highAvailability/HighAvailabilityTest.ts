import { MongoDBContainer, StartedMongoDBContainer } from '@testcontainers/mongodb';
import axios, { type AxiosResponse } from 'axios';
import mongoose from 'mongoose';

import { AggregatorGateway } from '../../src/AggregatorGateway.js';

describe('High Availability Tests', () => {
  const gateways: AggregatorGateway[] = [];
  let mongoContainer: StartedMongoDBContainer;
  let mongoUri: string;

  jest.setTimeout(60000);

  beforeAll(async () => {
    console.log('\n=========== STARTING HA TESTS ===========');

    mongoContainer = await new MongoDBContainer('mongo:7').start();
    mongoUri = mongoContainer.getConnectionString();
    console.log(`Connecting to MongoDB test container, using connection URI: ${mongoUri}.`);

    await mongoose.connect(mongoUri, { serverSelectionTimeoutMS: 5000, directConnection: true });
  });

  afterAll(async () => {
    console.log('Stopping all gateways...');
    for (const gateway of gateways) {
      gateway.stop();
    }

    // Wait a moment to ensure all connections are properly closed
    console.log('Waiting for connections to close...');
    await new Promise((resolve) => setTimeout(resolve, 1000));

    // Close mongoose connection
    console.log('Closing MongoDB connection...');
    await mongoose.connection.close();

    // Wait again to ensure all connections have been closed
    await new Promise((resolve) => setTimeout(resolve, 1000));

    if (mongoContainer) {
      console.log('\nStopping MongoDB container...');
      mongoContainer.stop({ timeout: 10 });
    }

    console.log('\n=========== FINISHED ALL HA TESTS ===========');
  });

  it('Should elect a single leader among multiple server instances', async () => {
    console.log('\n----- TEST 1: Leader Election -----');
    const gatewayConfiguration = {
      highAvailability: {
        enabled: true,
        lockTtlSeconds: 10,
        leaderHeartbeatInterval: 2000,
        leaderElectionPollingInterval: 3000,
      },
      alphabill: {
        useMock: true,
      },
      storage: {
        uri: mongoUri,
      },
    };
    console.log('Starting gateways...');
    const gateway1 = await AggregatorGateway.create({ aggregatorConfig: { port: 3001 }, ...gatewayConfiguration });
    const gateway2 = await AggregatorGateway.create({ aggregatorConfig: { port: 3002 }, ...gatewayConfiguration });
    const gateway3 = await AggregatorGateway.create({ aggregatorConfig: { port: 3003 }, ...gatewayConfiguration });

    gateways.push(gateway1, gateway2, gateway3);
    console.log('Starting initial leader election...');

    let hasLeader = false;
    const maxAttempts = 15;
    let attempts = 0;

    const startTime = Date.now();

    while (!hasLeader && attempts < maxAttempts) {
      attempts++;
      await new Promise((resolve) => setTimeout(resolve, 1000));

      if (gateway1.isLeader() || gateway2.isLeader() || gateway3.isLeader()) {
        hasLeader = true;
        const electionTime = Date.now() - startTime;
        console.log(`Initial leader detected after ${electionTime}ms (${attempts} polling attempts)`);
      }
    }

    expect(hasLeader).toBe(true);

    const [response1, response2, response3] = await Promise.all([
      axios.get('http://localhost:3001/health').catch((e) => e.response || { status: 0, data: null }),
      axios.get('http://localhost:3002/health').catch((e) => e.response || { status: 0, data: null }),
      axios.get('http://localhost:3003/health').catch((e) => e.response || { status: 0, data: null }),
    ]);

    console.log(response1.data);
    console.log(response2.data);
    console.log(response3.data);

    // All servers should return 200 OK
    expect(response1.status).toBe(200);
    expect(response2.status).toBe(200);
    expect(response3.status).toBe(200);

    const leaders = [response1, response2, response3].filter(
      (response) => response && response.status === 200 && response.data?.role === 'leader',
    );

    expect(leaders.length).toBe(1);
    console.log('Leader elected:', leaders[0].data.serverId);

    const followers = [response1, response2, response3].filter(
      (response) => response && response.status === 200 && response.data?.role === 'follower',
    );

    expect(followers.length).toBe(2);
    console.log('----- TEST 1 COMPLETED -----\n');
  });

  it('Should elect a new leader when current leader goes down', async () => {
    console.log('\n----- TEST 2: Leader Failover -----');
    const responses = await Promise.all([
      axios.get('http://localhost:3001/health').catch((e) => e.response || { status: 0, data: null }),
      axios.get('http://localhost:3002/health').catch((e) => e.response || { status: 0, data: null }),
      axios.get('http://localhost:3003/health').catch((e) => e.response || { status: 0, data: null }),
    ]);

    const leaderIndex = responses.findIndex(
      (response) => response && response.status === 200 && response.data?.role === 'leader',
    );

    expect(leaderIndex).not.toBe(-1);
    const currentLeader = gateways[leaderIndex];
    const currentLeaderId = currentLeader.getServerId();
    console.log('Current leader:', currentLeaderId);

    await currentLeader.stop();
    console.log('Current leader stopped, waiting for new leader election...');

    let newLeaderFound = false;
    const maxAttempts = 15;
    let attempts = 0;
    const remainingGateways = gateways.filter((g) => g !== currentLeader);

    const startTime = Date.now();

    while (!newLeaderFound && attempts < maxAttempts) {
      attempts++;

      if (remainingGateways.some((gateway) => gateway.isLeader())) {
        newLeaderFound = true;
        const electionTime = Date.now() - startTime;
        console.log(`New leader detected after ${electionTime}ms (${attempts} polling attempts)`);
      } else {
        console.log(`No leader detected yet. Attempt ${attempts}/${maxAttempts}`);
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }

    expect(newLeaderFound).toBe(true);

    const remainingResponses = await Promise.all(
      [
        gateways[0] !== currentLeader
          ? axios.get('http://localhost:3001/health').catch((e) => e.response || { status: 0, data: null })
          : null,
        gateways[1] !== currentLeader
          ? axios.get('http://localhost:3002/health').catch((e) => e.response || { status: 0, data: null })
          : null,
        gateways[2] !== currentLeader
          ? axios.get('http://localhost:3003/health').catch((e) => e.response || { status: 0, data: null })
          : null,
      ].filter(Boolean) as Promise<AxiosResponse>[],
    );

    // All remaining servers should return 200 OK
    remainingResponses.forEach((response) => {
      expect(response.status).toBe(200);
    });

    const newLeaders = remainingResponses.filter(
      (response) => response && response.status === 200 && response.data?.role === 'leader',
    );

    expect(newLeaders.length).toBe(1);
    const newLeaderId = newLeaders[0].data.serverId;
    console.log('New leader elected:', newLeaderId);

    expect(newLeaderId).not.toBe(currentLeaderId);

    const newFollowers = remainingResponses.filter(
      (response) => response && response.status === 200 && response.data?.role === 'follower',
    );

    expect(newFollowers.length).toBe(1);
    console.log('----- TEST 2 COMPLETED -----\n');
  });

  it('Should allow all servers to process requests', async () => {
    console.log('\n----- TEST 3: All Servers Processing Requests -----');

    const mockRequest = {
      jsonrpc: '2.0',
      method: 'get_no_deletion_proof',
      params: {},
      id: 1,
    };

    const responses = await Promise.all(
      gateways
        .filter((g) => !g.isLeader())
        .map((_, i) => {
          const port = 3001 + i;
          return axios
            .post(`http://localhost:${port}/`, mockRequest)
            .catch((e) => e.response || { status: 0, data: null });
        }),
    );

    responses.forEach((response) => {
      // We expect error 500 due to unimplemented method, but it should not be 503 Service Unavailable
      expect(response.status).not.toBe(503);

      // Even with an error, it should have processed the request rather than rejecting it
      if (response.data && response.data.error) {
        expect(response.data.error.message).not.toContain('Service unavailable (standby node)');
        expect(response.data.error.message).toContain('Internal error');
      }
    });

    console.log('All servers are able to process requests');
    console.log('----- TEST 3 COMPLETED -----\n');
  });
});
