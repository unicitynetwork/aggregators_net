import { MongoDBContainer, StartedMongoDBContainer } from '@testcontainers/mongodb';
import axios, { type AxiosResponse } from 'axios';
import { MongoClient } from 'mongodb';
import mongoose from 'mongoose';

import { AggregatorGateway } from '../../src/AggregatorGateway.js';

describe('High Availability Tests', () => {
  let mongoClient: MongoClient;
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
    for (const gateway of gateways) {
      await gateway.stop();
    }

    if (mongoClient) {
      await mongoClient.close();
    }

    if (mongoContainer) {
      console.log('\nStopping MongoDB container...');
      await mongoContainer.stop();
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
    const leaders = [response1, response2, response3].filter(
      (response) => response && response.status === 200 && response.data?.role === 'leader',
    );

    expect(leaders.length).toBe(1);
    console.log('Leader elected:', leaders[0].data.serverId);

    const standbys = [response1, response2, response3].filter(
      (response) => response && response.status === 503 && response.data?.role === 'standby',
    );

    expect(standbys.length).toBe(2);
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

    const newLeaders = remainingResponses.filter(
      (response) => response && response.status === 200 && response.data?.role === 'leader',
    );

    expect(newLeaders.length).toBe(1);
    const newLeaderId = newLeaders[0].data.serverId;
    console.log('New leader elected:', newLeaderId);

    expect(newLeaderId).not.toBe(currentLeaderId);
    console.log('----- TEST 2 COMPLETED -----\n');
  });
});
