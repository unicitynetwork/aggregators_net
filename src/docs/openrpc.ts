export const OPENRPC_DOCUMENT = {
  openrpc: "1.2.6",
  info: {
    title: "AggregatorGateway API",
    version: "1.0.0"
  },
  servers: [{ name: "RPC", url: "/" }],
  methods: [
    {
      name: "submit_commitment",
      summary: "Submit a state transition commitment to the aggregator.",
      params: [
        { name: "requestId", required: true, schema: { type: "string" } },
        { name: "transactionHash", required: true, schema: { type: "string" } },
        { name: "authenticator", required: true, schema: { type: "object" } }
      ],
      result: { name: "result", schema: { type: "object" } }
    },
    {
      name: "get_inclusion_proof",
      summary: "Retrieve the inclusion proof for a submitted commitment.",
      params: [
        { name: "requestId", required: true, schema: { type: "string" } }
      ],
      result: { name: "result", schema: { type: "object" } }
    },
    {
      name: "get_no_deletion_proof",
      summary: "Retrieve the global no-deletion proof.",
      params: [],
      result: { name: "result", schema: { type: "object" } }
    },
    {
      name: "get_block_height",
      summary: "Get the current block height.",
      params: [],
      result: { name: "result", schema: { type: "object" } }
    },
    {
      name: "get_block",
      summary: "Get information about a specific block.",
      params: [
        { name: "blockNumber", required: true, schema: { type: "string" } }
      ],
      result: { name: "result", schema: { type: "object" } }
    },
    {
      name: "get_block_commitments",
      summary: "Get all commitments included in a specific block.",
      params: [
        { name: "blockNumber", required: true, schema: { type: "string" } }
      ],
      result: { name: "result", schema: { type: "array", items: { type: "object" } } }
    }
  ]
};

// The React-based playground client consumes this document at /openrpc.json
