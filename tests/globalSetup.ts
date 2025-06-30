import { GenericContainer, StartedTestContainer, Wait } from 'testcontainers';

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

const logger = {
  info: (message: string, ...args: any[]) => console.log(`[INFO] ${message}`, ...args),
  debug: (message: string, ...args: any[]) => console.log(`[DEBUG] ${message}`, ...args)
};

let globalReplicaSet: IReplicaSet | null = null;

export default async function globalSetup() {
  console.log('Starting global MongoDB Docker replica set for all tests...');
  
  globalReplicaSet = await setupReplicaSet('global-test-');
  
  (global as any).__MONGO_URI__ = globalReplicaSet.uri;
  (global as any).__MONGO_REPLICA_SET__ = globalReplicaSet;
  
  console.log(`Global MongoDB replica set started at ${globalReplicaSet.uri}`);
}

async function setupReplicaSet(containerNamePrefix: string = 'mongo'): Promise<IReplicaSet> {
  const ports = [27017, 27018, 27019];

  logger.info(`Starting MongoDB containers on ports: ${ports.join(', ')}`);

  const containers = await Promise.all(
    ports.map((port) =>
      new GenericContainer('mongo:8')
        .withName(`${containerNamePrefix}${port}`)
        .withNetworkMode('host')
        .withCommand(['mongod', '--replSet', 'rs0', '--port', `${port}`, '--bind_ip', 'localhost'])
        .withWaitStrategy(Wait.forLogMessage('Waiting for connections').withStartupTimeout(120000))
        .start(),
    ),
  );

  logger.info('Initializing replica set...');
  const initResult = await containers[0].exec([
    'mongosh',
    '--quiet',
    '--eval',
    `
        config = {
            _id: "rs0",
            members: [
                { _id: 0, host: "localhost:${ports[0]}" },
                { _id: 1, host: "localhost:${ports[1]}" },
                { _id: 2, host: "localhost:${ports[2]}" }
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
        `${ports[0]}`,
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

  const portStrings = ports.map((p) => `localhost:${p}`);
  return {
    containers,
    uri: `mongodb://${portStrings.join(',')}/test?replicaSet=rs0`,
  };
}