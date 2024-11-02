class Aggregator {
    constructor(dataStructure, noDelProver){
	this.dataStructure = dataStructure;
	this.noDelProver = noDelProver;
    }

    async add(requestId, payload, authenticator){
	const delta = this.dataStructure.add(requestId, payload, authenticator);
	return {proof: noDelProver.prove(delta), delta, this.dataStructure}
    }

    async get(requestId){
	return this.dataStructure.get(requestId);
    }

    async hashRoot(){
	return this.dataStructure.hashRoot();
    }

}
