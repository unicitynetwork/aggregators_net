import { HexConverter } from '@unicitylabs/commons/lib/util/HexConverter.js';
import mongoose from 'mongoose';
import { GenericContainer, StartedTestContainer, Wait } from 'testcontainers';

import { AggregatorStorage } from '../../src/AggregatorStorage.js';
import logger from '../../src/logger.js';
import { SmtNode } from '../../src/smt/SmtNode.js';

interface IReplicaSetMember {
  _id: number;
  name: string;
  health: number;
  state: number;
  stateStr: string;
}

interface IReplicaSetStatus {
  ok: number;
  members?: IReplicaSetMember[];
}

interface IReplicaSet {
  containers: StartedTestContainer[];
  uri: string;
}

describe('Mongo Replica Set Tests', () => {
  jest.setTimeout(60000);

  let containers: StartedTestContainer[];

  beforeAll(async () => {
    const replicaSet = await setupReplicaSet();
    containers = replicaSet.containers;
    process.env.MONGODB_URI = replicaSet.uri;
  });

  afterAll(async () => {
    if (mongoose.connection.readyState !== 0) {
      logger.info('Closing mongoose connection...');
      await mongoose.connection.close();
    }

    for (const container of containers) {
      try {
        await container.stop({ timeout: 10 });
      } catch (e) {
        logger.error('Error stopping container:', e);
      }
    }
  });

  // NB: Enable host networking on Docker.
  it('Replica Failover Test', async () => {
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

    logger.info(`Current primary is on port ${primaryPort}`);

    if (!process.env.MONGODB_URI) {
      throw new Error('MongoDB URI not set in environment');
    }
    const storage = await AggregatorStorage.init(process.env.MONGODB_URI);

    logger.info('Storing test data...');
    const testLeaf = new SmtNode(BigInt(1), new Uint8Array([1, 2, 3]));
    await storage.smtStorage.put(testLeaf);
    logger.info('Test data stored successfully');
    const initialLeaves = await storage.smtStorage.getAll();
    logger.info(`Initially stored ${initialLeaves.length} leaves`);

    logger.info('Stopping primary node to simulate failure...');
    const failoverStart = Date.now();

    let failoverComplete = false;
    mongoose.connection.once('reconnected', () => {
      logger.info(`MongoDB driver reconnected after ${(Date.now() - failoverStart) / 1000}s`);
    });

    // Stop the primary
    await containers[primaryIndex].stop({ timeout: 10 });

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
            logger.info(`New primary details:
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
          logger.debug(e);
          // No primary elected yet
        }
      } catch (error) {
        logger.debug(error);
        // Ignore errors during election
      }
      logger.info(`Waiting for primary election... (${(Date.now() - failoverStart) / 1000}s)`);
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    if (!failoverComplete) {
      throw new Error('Failover timed out after 30 seconds');
    }

    logger.info('Reading data after primary failure...');
    const leaves = await storage.smtStorage.getAll();
    logger.info(`Successfully retrieved ${leaves.length} leaves after failover`);

    if (leaves.length === 0) {
      throw new Error('No leaves found after failover');
    }

    const retrievedLeaf = leaves[0];
    logger.info('Data verification:');
    expect(retrievedLeaf.path).toEqual(testLeaf.path);
    expect(HexConverter.encode(retrievedLeaf.value)).toEqual(HexConverter.encode(testLeaf.value));

    logger.info('Testing write after failover...');
    const newLeaf = new SmtNode(BigInt(2), new Uint8Array([4, 5, 6]));
    await storage.smtStorage.put(newLeaf);
    logger.info('Successfully wrote new leaf after failover');
  });
});

async function setupReplicaSet(): Promise<IReplicaSet> {
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

  logger.info('Started MongoDB containers on ports: 27017, 27018, 27019');
  logger.info('Initializing replica set...');
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
  logger.info('Initiate result:', initResult.output);

  // Wait and verify replica set is ready
  logger.info('Waiting for replica set initialization...');
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

      let rsStatus: IReplicaSetStatus;
      try {
        rsStatus = JSON.parse(status.output);
      } catch (e) {
        logger.info('Invalid JSON response:', status.output);
        logger.debug(e);
        rsStatus = { ok: 0 };
      }

      if (rsStatus.members?.some((m: IReplicaSetMember) => m.stateStr === 'PRIMARY')) {
        const primaryNode = rsStatus.members.find((m) => m.stateStr === 'PRIMARY')!;
        const electionTime = (Date.now() - startTime) / 1000;
        logger.info(`Replica set primary elected after ${electionTime.toFixed(1)}s`);
        logger.info('Initial primary node:', primaryNode.name);
        isReady = true;
      } else {
        const currentStatus = rsStatus.members?.map((m) => m.stateStr).join(',') || '';
        if (currentStatus !== lastStatus) {
          logger.info('Current replica set status:', currentStatus);
          lastStatus = currentStatus;
        }
        await new Promise((resolve) => setTimeout(resolve, 1000));
        attempts++;
      }
    } catch (error) {
      logger.info('Error checking replica status:', error);
      await new Promise((resolve) => setTimeout(resolve, 1000));
      attempts++;
    }
  }

  if (!isReady) {
    throw new Error('Replica set failed to initialize');
  }

  const uri =
    'mongodb://localhost:27017,localhost:27018,localhost:27019/?replicaSet=rs0&serverSelectionTimeoutMS=15000';
  logger.info('Using connection URI:', uri);

  return { containers, uri };
}
