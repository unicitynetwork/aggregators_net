const { UnicityProvider } = require('../provider/UnicityProvider.js');
const { JSONRPCTransport } = require('../client/http_client.js');
const { SignerEC } = require('../signer/SignerEC.js');
const { hash } = require('../hasher/sha256hasher.js').SHA256Hasher;

const args = process.argv.slice(2);
if (args.length < 4) {
    console.error('Usage: register_request.js <endpoint_url> <secret> <state> <transition>');
    process.exit(1);
}

const [endpointUrl, secret, state, transition] = args;

const transport = new JSONRPCTransport(endpointUrl);
const signer = new SignerEC(CryptoJS.SHA256(secret).toString(CryptoJS.enc.Hex));
const provider = new UnicityProvider(transport, signer, hasher);

const stateHash = hash(state);  // Hash of the state
const payload = hash(transition);  // Hash of the transition

(async () => {
    try {
	const { requestId, result } = await provider.submitStateTransition(stateHash, payload);
        if (result.status === 'success') {
            console.log('Request successfully registered. Request ID:', requestId);
        } else {
            console.error('Failed to register request:', result);
        }
    } catch (err) {
        console.error('Error registering request:', err.message);
    }
})();
