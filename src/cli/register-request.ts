import { JsonRpcHttpTransport } from '@unicitylabs/shared/lib/client/JsonRpcHttpTransport';
import { DataHasher, HashAlgorithm } from '@unicitylabs/shared/lib/hash/DataHasher';
import { SigningService } from '@unicitylabs/shared/lib/signing/SigningService';
import { Command } from 'commander';

const command = new Command();

command
  .name('register-request')
  .description(
    'Use this to request the proofs about your state transition request via command line to the Unicity Aggregator Layer.',
  )
  .argument('<endpoint_url>', 'URL of the Unicity Aggregator Layer Gateway endpoint.')
  .argument('<secret>', 'A secret phrase to be used for generating self-authenticated state transition request.')
  .argument('<state>', 'A string containing origin state definition.')
  .argument('<transition>', 'A string containing state transition from the origin state to some new state.')
  .option('-d, --debug', 'Enable debugging mode.')
  .action(async (endpointUrl, secret, state, transition, options) => {
    if (options.debug) {
      console.error('Called %s with options %o', command.name(), options);
    }
    const transport = new JsonRpcHttpTransport(endpointUrl);
    const secretHash = await new DataHasher(HashAlgorithm.SHA256).update(secret).digest();
    const signer = new SigningService(secretHash);
    const provider = new UnicityProvider(transport, signer);

    const stateHash = new DataHasher(HashAlgorithm.SHA256).update(state).digest();
    const payload = new DataHasher(HashAlgorithm.SHA256).update(transition).digest();

    await (async (): Promise<void> => {
      const { requestId, result } = await provider.submitStateTransition(stateHash, payload);
      if (result.status === 'success') {
        console.log('Request successfully registered. Request ID:', requestId);
      } else {
        console.error('Failed to register request:', result);
      }
    })();
  })
  .parse();
