const axios = require("axios");

class JSONRPCTransport {
  constructor(endpoint) {
    this.endpoint = endpoint;
  }

  generateRequestId(requestId, method) {
    const timestamp = Math.floor(Date.now() / 1000); // POSIX timestamp in seconds
    const data = `${requestId}-${method}-${timestamp}`;
    return crypto.createHash("sha256").update(data).digest("hex");
  }

  async send(method, params) {
    const payload = {
      jsonrpc: "2.0",
      method,
      params,
      id: this.generateRequestId(params.requestId, method),
    };

    try {
      const response = await axios.post(this.endpoint, payload);
      if (response.data.error) {
        throw new Error(response.data.error.message);
      }
      return response.data.result;
    } catch (error) {
      console.error("JSON-RPC Request Error:", error);
      throw error;
    }
  }
}
