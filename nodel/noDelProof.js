class NoDelProof{
    constructor(storage, id, proof){
	this.id = id;
	this.proof = proof;
	if(!proof)
	    storage.save(id, proof);
	else
	    storage.load(id);
    }

    async get(){
	return {this.id, this.proof}
    }

    async verify(){
	return true;
    }
}
