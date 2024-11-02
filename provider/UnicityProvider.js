const { NODEL_FAILED, NOT_INCLUDED, NOT_MATCHING, NOT_AUTHENTICATED, WRONG_AUTH_TYPE, OK } = require("../constants.js");


class UnicityProvider{

    constructor(transport, signer){
	this.api = new AggregatorAPI(transport);
	this.signer = signer;
    }

    async function submitSingleSpend(sourceStateHash, transitionHash){
	await this.api.submitStateTransition(await getRequestId(sourceStateHash), transitionHash, await getAuthenticator(transitionHash));
    }

    async function verifySingleSpend(sourceStateHash, transitionHash){
	const noDelProof = new NoDelProof(await getNodelProof());
	if(!(await noDelProof.verify()))return NODEL_FAILED;
	const requestId = await getRequestId(sourceStateHash);
	const path = await this.api.getInclusionProof(requestId);
	if(!path) throw new Error("Internal error: malformed unicity response. No path field");
	const leaf = path[path.length-1];
	if(!leaf.leaf)return NOT_INCLUDED;
	if(leaf.payload !== transitionHash)return NOT_MATCHING;
	if(leaf.authenticator.alg !== signer.getAlg())return WRONG_AUTH_TYPE;
	if(!signer.verify(extractPubKey(requestId), transitionHash, leaf.authenticator.signature))return NOT_AUTHENTICATED;
	return OK;
    }

    async function getRequestId(sourceStateHash){
	return (await this.signer.getPubKey)+sourceStateHash;
    }

    function extractPubKey(requestId){
	return requestId.substring(0,this.signer.pubKeyLength*2);
    }

    async function getAuthenticator(transitionHash){
	return {signature: await this.signer.sign(transitionHash), alg: this.signer.getAlg()};
    }

}
