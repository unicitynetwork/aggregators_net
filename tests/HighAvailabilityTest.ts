import { MongoClient, Db } from 'mongodb';
import mongoose from 'mongoose';
import axios from 'axios';
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
    const gateway1 = new AggregatorGateway({
      port: 3001,
      enableHA: true,
      useAlphabillMock: true,
      lockTtlSeconds: 10,
      leaderHeartbeatIntervalMs: 2000,
      leaderElectionPollingIntervalMs: 3000,
      mongoUri: mongoUri
    });
    
    const gateway2 = new AggregatorGateway({
      port: 3002,
      enableHA: true,
      useAlphabillMock: true,
      lockTtlSeconds: 10,
      leaderHeartbeatIntervalMs: 2000,
      leaderElectionPollingIntervalMs: 3000,
      mongoUri: mongoUri
    });
    
    const gateway3 = new AggregatorGateway({
      port: 3003,
      enableHA: true,
      useAlphabillMock: true,
      lockTtlSeconds: 10,
      leaderHeartbeatIntervalMs: 2000,
      leaderElectionPollingIntervalMs: 3000,
      mongoUri: mongoUri
    });
    
    gateways.push(gateway1, gateway2, gateway3);
    
    await gateway1.init();
    await gateway2.init();
    await gateway3.init();
    
    console.log('Starting gateways with staggered delays...');
    await gateway1.start();
    await new Promise(resolve => setTimeout(resolve, 500));
    await gateway2.start();
    await new Promise(resolve => setTimeout(resolve, 500));
    await gateway3.start();
    
    console.log('Starting initial leader election...');
    
    let hasLeader = false;
    const maxAttempts = 15;
    let attempts = 0;
    
    const startTime = Date.now();
    
    while (!hasLeader && attempts < maxAttempts) {
      attempts++;
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      if (gateway1.isLeader() || gateway2.isLeader() || gateway3.isLeader()) {
        hasLeader = true;
        const electionTime = Date.now() - startTime;
        console.log(`Initial leader detected after ${electionTime}ms (${attempts} polling attempts)`);
      }
    }
    
    expect(hasLeader).toBe(true);
    
    const [response1, response2, response3] = await Promise.all([
      axios.get('http://localhost:3001/health').catch(e => e.response || { status: 0, data: null }),
      axios.get('http://localhost:3002/health').catch(e => e.response || { status: 0, data: null }),
      axios.get('http://localhost:3003/health').catch(e => e.response || { status: 0, data: null })
    ]);
    
    const leaders = [response1, response2, response3].filter(
      response => response && response.status === 200 && response.data?.role === 'leader'
    );
    
    expect(leaders.length).toBe(1);
    console.log('Leader elected:', leaders[0].data.serverId);
    
    const standbys = [response1, response2, response3].filter(
      response => response && response.status === 503 && response.data?.role === 'standby'
    );
    
    expect(standbys.length).toBe(2);
    console.log('----- TEST 1 COMPLETED -----\n');
  });
  
  it('Should elect a new leader when current leader goes down', async () => {
    console.log('\n----- TEST 2: Leader Failover -----');
    let responses = await Promise.all([
      axios.get('http://localhost:3001/health').catch(e => e.response || { status: 0, data: null }),
      axios.get('http://localhost:3002/health').catch(e => e.response || { status: 0, data: null }),
      axios.get('http://localhost:3003/health').catch(e => e.response || { status: 0, data: null })
    ]);
    
    const leaderIndex = responses.findIndex(
      response => response && response.status === 200 && response.data?.role === 'leader'
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
    let remainingGateways = gateways.filter(g => g !== currentLeader);
    
    const startTime = Date.now();
    
    while (!newLeaderFound && attempts < maxAttempts) {
      attempts++;
      
      if (remainingGateways.some(gateway => gateway.isLeader())) {
        newLeaderFound = true;
        const electionTime = Date.now() - startTime;
        console.log(`New leader detected after ${electionTime}ms (${attempts} polling attempts)`);
      } else {
        console.log(`No leader detected yet. Attempt ${attempts}/${maxAttempts}`);
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }
    
    expect(newLeaderFound).toBe(true);
    
    const remainingResponses = await Promise.all(
      [
        gateways[0] !== currentLeader ? axios.get('http://localhost:3001/health').catch(e => e.response || { status: 0, data: null }) : null,
        gateways[1] !== currentLeader ? axios.get('http://localhost:3002/health').catch(e => e.response || { status: 0, data: null }) : null,
        gateways[2] !== currentLeader ? axios.get('http://localhost:3003/health').catch(e => e.response || { status: 0, data: null }) : null
      ].filter(Boolean) as Promise<any>[]
    );
    
    const newLeaders = remainingResponses.filter(
      response => response && response.status === 200 && response.data?.role === 'leader'
    );
    
    expect(newLeaders.length).toBe(1);
    const newLeaderId = newLeaders[0].data.serverId;
    console.log('New leader elected:', newLeaderId);
    
    expect(newLeaderId).not.toBe(currentLeaderId);
    console.log('----- TEST 2 COMPLETED -----\n');
  });
});