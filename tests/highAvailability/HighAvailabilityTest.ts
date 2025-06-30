import { SigningService } from '@unicitylabs/commons/lib/signing/SigningService.js';
import { HexConverter } from '@unicitylabs/commons/lib/util/HexConverter.js';
import axios from 'axios';

import { AggregatorGateway } from '../../src/AggregatorGateway.js';
import { MockValidationService } from '../mocks/MockValidationService.js';
import logger from '../../src/logger.js';
import { getHealth, connectToSharedMongo, clearAllCollections, disconnectFromSharedMongo } from '../TestUtils.js';

describe('High Availability Tests', () => {
  const gateways: AggregatorGateway[] = [];
  let mongoUri: string;

  jest.setTimeout(60000);

  beforeAll(async () => {
    logger.info('=========== STARTING HA TESTS ===========');
    mongoUri = await connectToSharedMongo();
  });

  afterAll(async () => {
    logger.info('Stopping all gateways...');
    for (const gateway of gateways) {
      await gateway.stop();
    }

    await clearAllCollections();
    await disconnectFromSharedMongo();

    logger.info('=========== FINISHED ALL HA TESTS ===========');
  });

  it('Should elect a single leader among multiple server instances', async () => {
    logger.info('----- TEST 1: Leader Election -----');
    
    const mockValidationService1 = new MockValidationService();
    const mockValidationService2 = new MockValidationService();
    const mockValidationService3 = new MockValidationService();
    
    const gatewayConfiguration = {
      highAvailability: {
        enabled: true,
        lockTtlSeconds: 10,
        leaderHeartbeatInterval: 2000,
        leaderElectionPollingInterval: 3000,
      },
      alphabill: {
        useMock: true,
        privateKey: HexConverter.encode(SigningService.generatePrivateKey()),
      },
      storage: {
        uri: mongoUri,
      },
    };
    logger.info('Starting gateways...');
    const gateway1 = await AggregatorGateway.create({
      aggregatorConfig: {
        port: 3001,
        serverId: 'test-server-1',
        blockCreationWaitTime: 2000,
      },
      ...gatewayConfiguration,
      validationService: mockValidationService1,
    });
    const gateway2 = await AggregatorGateway.create({
      aggregatorConfig: {
        port: 3002,
        serverId: 'test-server-2',
        blockCreationWaitTime: 2000,
      },
      ...gatewayConfiguration,
      validationService: mockValidationService2,
    });
    const gateway3 = await AggregatorGateway.create({
      aggregatorConfig: {
        port: 3003,
        serverId: 'test-server-3',
        blockCreationWaitTime: 2000,
      },
      ...gatewayConfiguration,
      validationService: mockValidationService3,
    });

    gateways.push(gateway1, gateway2, gateway3);
    logger.info('Starting initial leader election...');

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
        logger.info(`Initial leader detected after ${electionTime}ms (${attempts} polling attempts)`);
      }
    }

    expect(hasLeader).toBe(true);

    const [response1, response2, response3] = await Promise.all([
      getHealth(3001).catch(() => null),
      getHealth(3002).catch(() => null),
      getHealth(3003).catch(() => null),
    ]);

    // All servers should return valid data
    expect(response1).not.toBeNull();
    expect(response2).not.toBeNull();
    expect(response3).not.toBeNull();

    const leaders = [response1, response2, response3].filter(
      (response) => response && response.role === 'leader',
    );

    expect(leaders.length).toBe(1);
    logger.info(`Leader elected: ${leaders[0].serverId}`);

    const followers = [response1, response2, response3].filter(
      (response) => response && response.role === 'follower',
    );

    expect(followers.length).toBe(2);
    logger.info('----- TEST 1 COMPLETED -----');
  });

  it('Should elect a new leader when current leader goes down', async () => {
    logger.info('----- TEST 2: Leader Failover -----');
    const responses = await Promise.all([
      getHealth(3001).catch(() => null),
      getHealth(3002).catch(() => null),
      getHealth(3003).catch(() => null),
    ]);

    const leaderIndex = responses.findIndex(
      (response) => response && response.role === 'leader',
    );

    expect(leaderIndex).not.toBe(-1);
    const currentLeader = gateways[leaderIndex];
    const currentLeaderId = currentLeader.getServerId();
    logger.info(`Current leader: ${currentLeaderId}`);

    await currentLeader.stop();
    logger.info('Current leader stopped, waiting for new leader election...');

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
        logger.info(`New leader detected after ${electionTime}ms (${attempts} polling attempts)`);
      } else {
        logger.info(`No leader detected yet. Attempt ${attempts}/${maxAttempts}`);
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }

    expect(newLeaderFound).toBe(true);

    const remainingResponses = await Promise.all(
      [
        gateways[0] !== currentLeader ? getHealth(3001).catch(() => null) : null,
        gateways[1] !== currentLeader ? getHealth(3002).catch(() => null) : null,
        gateways[2] !== currentLeader ? getHealth(3003).catch(() => null) : null,
      ].filter(Boolean) as Promise<any>[],
    );

    // All remaining servers should return valid data
    remainingResponses.forEach((response) => {
      expect(response).not.toBeNull();
    });

    const newLeaders = remainingResponses.filter(
      (response) => response && response.role === 'leader',
    );

    expect(newLeaders.length).toBe(1);
    const newLeaderId = newLeaders[0].serverId;
    logger.info(`New leader elected: ${newLeaderId}`);

    expect(newLeaderId).not.toBe(currentLeaderId);

    const newFollowers = remainingResponses.filter(
      (response) => response && response.role === 'follower',
    );

    expect(newFollowers.length).toBe(1);
    logger.info('----- TEST 2 COMPLETED -----');
  });

  it('Should allow all servers to process requests', async () => {
    logger.info('----- TEST 3: All Servers Processing Requests -----');

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

    logger.info('All servers are able to process requests');
    logger.info('----- TEST 3 COMPLETED -----');
  });
});
