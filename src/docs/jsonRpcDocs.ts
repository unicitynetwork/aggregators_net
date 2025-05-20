export interface RpcParam {
  name: string;
  type: string;
  description: string;
  required: boolean;
}

export interface RpcMethodDoc {
  name: string;
  description: string;
  params: RpcParam[];
  example: Record<string, unknown>;
  result: string;
}

export const RPC_METHODS: RpcMethodDoc[] = [
  {
    name: 'submit_commitment',
    description: 'Submit a state transition commitment to the aggregator.',
    params: [
      {
        name: 'requestId',
        type: 'string',
        description: 'Unique identifier for the request.',
        required: true,
      },
      {
        name: 'transactionHash',
        type: 'string',
        description: 'Hash of the state transition.',
        required: true,
      },
      {
        name: 'authenticator',
        type: 'object',
        description: 'Authenticator structure with signature and public key.',
        required: true,
      },
    ],
    example: {
      requestId: '<request id>',
      transactionHash: '<transaction hash>',
      authenticator: {
        publicKey: '<hex>',
        stateHash: '<hex>',
        signature: '<hex>',
        signAlg: 'ed25519',
        hashAlg: 'SHA256',
      },
    },
    result: 'SubmitCommitmentResponse object',
  },
  {
    name: 'get_inclusion_proof',
    description: 'Retrieve the inclusion proof for a submitted commitment.',
    params: [
      {
        name: 'requestId',
        type: 'string',
        description: 'Unique identifier for the request.',
        required: true,
      },
    ],
    example: {
      requestId: '<request id>',
    },
    result: 'InclusionProof object',
  },
  {
    name: 'get_no_deletion_proof',
    description: 'Retrieve the global no-deletion proof.',
    params: [],
    example: {},
    result: 'NoDeletionProof object',
  },
  {
    name: 'get_block_height',
    description: 'Get the current block height.',
    params: [],
    example: {},
    result: '{ blockNumber: string }',
  },
  {
    name: 'get_block',
    description: 'Get information about a specific block.',
    params: [
      {
        name: 'blockNumber',
        type: 'string',
        description: 'Block number or "latest".',
        required: true,
      },
    ],
    example: {
      blockNumber: 'latest',
    },
    result: 'Block details object',
  },
  {
    name: 'get_block_commitments',
    description: 'Get all commitments included in a specific block.',
    params: [
      {
        name: 'blockNumber',
        type: 'string',
        description: 'Block number.',
        required: true,
      },
    ],
    example: {
      blockNumber: '1',
    },
    result: 'Array of commitment objects',
  },
];

export function generateDocsHtml(): string {
  const sections = RPC_METHODS.map((method) => {
    const rows = method.params
      .map(
        (p) =>
          `<tr><td>${p.name}</td><td>${p.type}</td><td>${p.required ? 'yes' : 'no'}</td><td>${p.description}</td></tr>`,
      )
      .join('');
    return `
    <section>
      <h2 id="${method.name}">${method.name}</h2>
      <p>${method.description}</p>
      <table>
        <thead><tr><th>Parameter</th><th>Type</th><th>Required</th><th>Description</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <p>Params example:</p>
      <textarea id="${method.name}-params" rows="6">${JSON.stringify(method.example, null, 2)}</textarea>
      <button onclick="sendRequest('${method.name}')">Send</button>
      <pre id="${method.name}-response"></pre>
    </section>`;
  });

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8" />
<title>AggregatorGateway JSON-RPC API</title>
<style>
  body { font-family: Arial, sans-serif; margin: 20px; }
  table { border-collapse: collapse; margin-bottom: 10px; }
  th, td { border: 1px solid #ddd; padding: 4px 8px; text-align: left; }
  textarea { width: 100%; }
  pre { background: #f4f4f4; padding: 10px; }
  section { margin-bottom: 40px; }
</style>
</head>
<body>
<h1>AggregatorGateway JSON-RPC API</h1>
<p>All methods are invoked via HTTP POST to <code>/</code> using JSON-RPC 2.0.</p>
${sections.join('\n')}
<script>
async function sendRequest(method) {
  const paramsField = document.getElementById(method + '-params');
  let params = {};
  try { params = JSON.parse(paramsField.value); } catch(e) {}
  const res = await fetch('../', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', method, params, id: Date.now() })
  });
  const text = await res.text();
  document.getElementById(method + '-response').textContent = text;
}
</script>
</body>
</html>`;
}
