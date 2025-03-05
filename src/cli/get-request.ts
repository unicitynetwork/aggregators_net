import { JsonRpcHttpTransport } from '@unicitylabs/shared/src/client/JsonRpcHttpTransport';
import { Command } from 'commander';

const command = new Command();

command
  .name('get-request')
  .description(
    'Use this to request the profs about your state transition request via command line to the Unicity Aggregator Layer.',
  )
  .argument('<endpoint_url>', 'URL of the Unicity Aggregator Layer Gateway endpoint.')
  .argument('<request_id>', 'The request id.')
  .option('-d, --debug', 'Enable debugging mode.')
  .action((endpointUrl, requestId, options) => {
    if (options.debug) {
      console.info('Called %s with options %o', command.name(), options);
    }
    const transport = new JsonRpcHttpTransport(endpointUrl);
    const provider = new UnicityProvider(transport);

    (async (): Promise<void> => {
      try {
        const { status, path } = await provider.extractProofs(requestId);
        console.log(`STATUS: ${status}`);
        console.log(`PATH: ${JSON.stringify(path, null, 4)}`);
      } catch (err) {
        console.error('Error getting request:', err);
      }
    })();
  })
  .parse();
