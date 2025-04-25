import { HexConverter } from '@unicitylabs/commons/lib/util/HexConverter.js';
import mongoose from 'mongoose';
import { StartedTestContainer } from 'testcontainers';

import { AggregatorStorage } from '../../src/AggregatorStorage.js';
import logger from '../../src/logger.js';
import { SmtNode } from '../../src/smt/SmtNode.js';
import { delay, setupReplicaSet } from '../TestUtils.js';

describe('Mongo Replica Set Tests', () => {
  jest.setTimeout(60000);

  let containers: StartedTestContainer[];

  beforeAll(async () => {
    const replicaSet = await setupReplicaSet();
    containers = replicaSet.containers;
    process.env.MONGODB_URI = replicaSet.uri;
  });

  afterAll(() => {
    for (const container of containers) {
      try {
        container.stop({ timeout: 10 });
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
      await delay(1000);
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
