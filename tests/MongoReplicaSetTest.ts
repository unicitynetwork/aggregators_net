import mongoose from 'mongoose';
import { GenericContainer, StartedTestContainer, Wait } from 'testcontainers';

import { Storage } from '../src/database/mongo/Storage.js';
import { SmtNode } from '../src/smt/SmtNode.js';

interface ReplicaSetMember {
  _id: number;
  name: string;
  health: number;
  state: number;
  stateStr: string;
}

interface ReplicaSetStatus {
  ok: number;
  members?: ReplicaSetMember[];
}

async function setupReplicaSet() {
  const containers = await Promise.all(
    [27017, 27018, 27019].map((port) =>
      new GenericContainer('mongo:7')
        .withName(`mongo${port}`)
        .withNetworkMode('host')
        .withCommand(['mongod', '--replSet', 'rs0', '--port', `${port}`, '--bind_ip', 'localhost'])
        .withStartupTimeout(120000)
        .withWaitStrategy(Wait.forLogMessage('Waiting for connections'))
        .start(),
    ),
  );

  console.log('Started MongoDB containers on ports: 27017, 27018, 27019');
  console.log('Initializing replica set...');
  const initResult = await containers[0].exec([
    'mongosh',
    '--quiet',
    '--eval',
    `
        config = {
            _id: "rs0",
            members: [
                { _id: 0, host: "localhost:27017" },
                { _id: 1, host: "localhost:27018" },
                { _id: 2, host: "localhost:27019" }
            ]
        };
        rs.initiate(config);
        `,
  ]);
  console.log('Initiate result:', initResult.output);

  // Wait and verify replica set is ready
  console.log('Waiting for replica set initialization...');
  let isReady = false;
  let lastStatus = '';
  const maxAttempts = 30;
  let attempts = 0;
  const startTime = Date.now();

  while (!isReady && attempts < maxAttempts) {
    try {
      const status = await containers[0].exec([
        'mongosh',
        '--port',
        '27017',
        '--quiet',
        '--eval',
        'if (rs.status().ok) { print(JSON.stringify(rs.status())); } else { print("{}"); }',
      ]);

      let rsStatus: ReplicaSetStatus;
      try {
        rsStatus = JSON.parse(status.output);
      } catch (e) {
        console.log('Invalid JSON response:', status.output);
        rsStatus = { ok: 0 };
      }

      if (rsStatus.members?.some((m: ReplicaSetMember) => m.stateStr === 'PRIMARY')) {
        const primaryNode = rsStatus.members.find((m) => m.stateStr === 'PRIMARY')!;
        const electionTime = (Date.now() - startTime) / 1000;
        console.log(`Replica set primary elected after ${electionTime.toFixed(1)}s`);
        console.log('Initial primary node:', primaryNode.name);
        isReady = true;
      } else {
        const currentStatus = rsStatus.members?.map((m) => m.stateStr).join(',') || '';
        if (currentStatus !== lastStatus) {
          console.log('Current replica set status:', currentStatus);
          lastStatus = currentStatus;
        }
        await new Promise((resolve) => setTimeout(resolve, 1000));
        attempts++;
      }
    } catch (error) {
      console.log('Error checking replica status:', error);
      await new Promise((resolve) => setTimeout(resolve, 1000));
      attempts++;
    }
  }

  if (!isReady) {
    throw new Error('Replica set failed to initialize');
  }

  const uri =
    'mongodb://localhost:27017,localhost:27018,localhost:27019/?replicaSet=rs0&serverSelectionTimeoutMS=15000';
  console.log('Using connection URI:', uri);

  return { containers, uri };
}

async function testReplicaFailover() {
  let containers: StartedTestContainer[] = [];

  try {
    const result = await setupReplicaSet();
    containers = result.containers;
    process.env.MONGODB_URI = result.uri;

    // Find which container is primary
    const status = await containers[0].exec([
      'mongosh',
      '--port',
      '27017',
      '--quiet',
      '--eval',
      'rs.status().members.find(m => m.stateStr === "PRIMARY")?.name',
    ]);
    const primaryPort = parseInt(status.output.trim().split(':')[1]);
    const primaryIndex = containers.findIndex((_, index) => 27017 + index === primaryPort);

    console.log(`Current primary is on port ${primaryPort}`);

    const storage = await Storage.init();

    console.log('\nStoring test data...');
    const testLeaf = new SmtNode(BigInt(1), new Uint8Array([1, 2, 3]));
    await storage.smt.put(testLeaf);
    console.log('Test data stored successfully');
    const initialLeaves = await storage.smt.getAll();
    console.log(`Initially stored ${initialLeaves.length} leaves`);

    console.log('\nStopping primary node to simulate failure...');
    const failoverStart = Date.now();

    let failoverComplete = false;
    mongoose.connection.once('reconnected', () => {
      console.log(`MongoDB driver reconnected after ${(Date.now() - failoverStart) / 1000}s`);
    });

    // Stop the primary
    await containers[primaryIndex].stop();

    // Wait for primary election with timeout
    const maxWaitTime = 30000;
    const waitStart = Date.now();
    let newPrimary = '';

    while (!newPrimary && Date.now() - waitStart < maxWaitTime) {
      const secondaryIndex = (primaryIndex + 1) % 3;
      try {
        const status = await containers[secondaryIndex].exec([
          'mongosh',
          '--port',
          `${27017 + secondaryIndex}`,
          '--quiet',
          '--eval',
          `
                    const status = rs.status();
                    const primary = status.members.find(m => m.stateStr === "PRIMARY");
                    if (primary) {
                        print(JSON.stringify({
                            name: primary.name,
                            uptime: primary.uptime,
                            electionDate: primary.electionDate,
                            stateStr: primary.stateStr,
                            health: primary.health
                        }));
                    }
                    `,
        ]);

        try {
          const primaryInfo = JSON.parse(status.output.trim());
          if (primaryInfo.name) {
            const electionTime = (Date.now() - failoverStart) / 1000;
            console.log(`New primary details:
                            Node: ${primaryInfo.name}
                            Uptime: ${primaryInfo.uptime}s
                            Election time: ${electionTime.toFixed(1)}s
                            Health: ${primaryInfo.health}
                        `);
            newPrimary = primaryInfo.name;
            failoverComplete = true;
            break;
          }
        } catch (e) {
          // No primary elected yet
        }
      } catch (error) {
        // Ignore errors during election
      }
      console.log(`Waiting for primary election... (${(Date.now() - failoverStart) / 1000}s)`);
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    if (!failoverComplete) {
      throw new Error('Failover timed out after 30 seconds');
    }

    console.log('\nReading data after primary failure...');
    const leaves = await storage.smt.getAll();
    console.log(`Successfully retrieved ${leaves.length} leaves after failover`);

    if (leaves.length === 0) {
      throw new Error('No leaves found after failover');
    }

    const retrievedLeaf = leaves[0];
    console.log('\nData verification:');
    console.log('Path matches:', retrievedLeaf.path === testLeaf.path);
    console.log('Value matches:', Buffer.compare(retrievedLeaf.value, testLeaf.value) === 0);

    console.log('\nTesting write after failover...');
    const newLeaf = new SmtNode(BigInt(2), new Uint8Array([4, 5, 6]));
    await storage.smt.put(newLeaf);
    console.log('Successfully wrote new leaf after failover');
  } catch (error) {
    console.error('Test failed:', error);
    throw error;
  } finally {
    await mongoose.disconnect();
    for (const container of containers) {
      try {
        await container.stop();
      } catch (e) {
        console.error('Error stopping container:', e);
      }
    }
  }
}

testReplicaFailover().catch((error) => {
  console.error('Test failed:', error);
  process.exit(1);
});
