const crypto = require('crypto');
const { UnicityProvider } = require('../provider/UnicityProvider.js');
const { JSONRPCTransport } = require('../client/http_client.js');
const { SignerEC } = require('../signer/SignerEC.js');
const { SHA256Hasher } = require('../hasher/sha256hasher.js');

const args = process.argv.slice(2);
if (args.length < 2) {
    console.error('Usage: get_request.js <endpoint_url> <request_id>');
    process.exit(1);
}

const [endpointUrl, requestId] = args;

const transport = new JSONRPCTransport(endpointUrl);
const provider = new UnicityProvider(transport);

(async () => {
    try {
	const { status, path } = await provider.extractSingleSpend(requestId);
	console.log(`STATUS: ${status}`);
	console.log(`PATH: ${JSON.stringify(path, null, 4)}`);
    } catch (err) {
        console.error('Error getting request:', err.message);
    }
})();
