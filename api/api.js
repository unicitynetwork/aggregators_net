class AggregatorAPI {
  constructor(transport) {
    this.transport = transport;
  }

  async submitStateTransition(requestId, payload, authenticator) {
    const data = {
      requestId,
      payload,
      authenticator,
    };
    return await this.transport.send("aggregator_submit", data);
  }

  async getInclusionProof(requestId, blockNum) {
    const data = { requestId, blockNum };
    return await this.transport.send("aggregator_get_path", data);
  }

  async getNodelProof(blockNum) {
    const data = { requestId };
    return await this.transport.send("aggregator_get_nodel", data);
  }

}

module.exports = { AggregatorAPI }