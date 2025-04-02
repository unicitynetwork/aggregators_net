import axios, { type AxiosResponse } from 'axios';
import { MongoClient, Db } from 'mongodb';
import mongoose from 'mongoose';
import { GenericContainer, StartedTestContainer } from 'testcontainers';

import { AggregatorGateway } from '../src/AggregatorGateway.js';

describe('High Availability Tests', () => {
  let mongoClient: MongoClient;
  let db: Db;
  const gateways: AggregatorGateway[] = [];
  let mongoContainer: StartedTestContainer;
  let mongoUri: string;

  jest.setTimeout(60000);

  beforeAll(async () => {
    console.log('\n=========== STARTING HA TESTS ===========');

    mongoContainer = await new GenericContainer('mongo:7')
      .withExposedPorts(27017)
      .withCommand(['mongod', '--noauth'])
      .start();

    const mappedPort = mongoContainer.getMappedPort(27017);
    mongoUri = `mongodb://127.0.0.1:${mappedPort}/test?directConnection=true`;

    console.log('Connecting to MongoDB test container...');
    console.log(`Using connection URI: ${mongoUri}`);

    mongoClient = await MongoClient.connect(mongoUri);
    db = mongoClient.db();

    await db.collection('leader_election').deleteMany({});
  });

  afterAll(async () => {
    for (const gateway of gateways) {
      await gateway.stop();
    }

    if (db) {
      await db.collection('leader_election').deleteMany({});
    }

    await mongoose.disconnect();

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
    const gateway1 = await AggregatorGateway.create({ port: 3001, ...gatewayConfiguration });
    const gateway2 = await AggregatorGateway.create({ port: 3002, ...gatewayConfiguration });
    const gateway3 = await AggregatorGateway.create({ port: 3003, ...gatewayConfiguration });

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

    console.log(response1);
    console.log(response2);
    console.log(response3);
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
