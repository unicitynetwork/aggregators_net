const { NODEL_FAILED, NOT_INCLUDED, NOT_MATCHING, NOT_AUTHENTICATED, WRONG_AUTH_TYPE, OK } = require("../constants.js");
const { AggregatorAPI } = require('../api/api.js');
const { SignerEC } = require('../signer/SignerEC.js');
const { hash } = require('../hasher/sha256hasher.js').SHA256Hasher;
const { SHA256Hasher } = require('../hasher/sha256hasher.js');

class UnicityProvider{

    constructor(transport, signer){
	this.api = new AggregatorAPI(transport);
	this.signer = signer;
    }

    async submitStateTransition(sourceStateHash, transitionHash){
	return await this.api.submitStateTransition(await this.getRequestId(sourceStateHash), transitionHash, 
	    await this.getAuthenticator(sourceStateHash, transitionHash));
    }

    async extractProofs(requestId){
	const { path } = (await this.api.getInclusionProof(requestId)).result;
	return { status: UnicityProvider.verifyInclusionProofs(path), path };
    }

    async getRequestId(sourceStateHash){
	return UnicityProvider.calculateRequestId(await this.signer.getPubKey(), sourceStateHash, this.hasher);
    }

    static async calculateRequestId(pubKey, state, hasher){
	return await hash(pubKey+state);
    }

    async getAuthenticator(sourceStateHash, transitionHash){
	return {
	    state: sourceStateHash,
	    pubkey: await this.signer.getPubKey(), 
	    signature: await this.signer.sign(transitionHash), 
	    sign_alg: SignerEC.getAlg(), 
	    hash_alg: SHA256Hasher.getAlg()
	};
    }

    static verifyInclusionProofs(path){
	if(!path) throw new Error("Internal error: malformed unicity response. No path field");
	const leaf = path[path.length-1];
	if(!leaf)return NOT_INCLUDED;
	if(!leaf.leaf)return NOT_INCLUDED;
	if(!SignerEC.verify(leaf.authenticator.pubkey, leaf.payload, leaf.authenticator.signature))return NOT_AUTHENTICATED;
	return OK;
    }

}

module.exports = { UnicityProvider }
