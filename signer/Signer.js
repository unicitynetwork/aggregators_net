const { throwAbstractInstantiate, throwAbstractMethod } = require("../helper.js");

class Signer {
    constructor(privateKeyHex) {
	if (new.target == Signer)
    	    throwAbstractInstantiate();
        if (!Signer.isValidPrivateKey(privateKeyHex)) {
            throw new Error('Invalid private key');
        }
        this.privateKey = Buffer.from(privateKeyHex, 'hex');
    }

    static generatePrivateKey() {
	throwAbstractMethod();
    }

    static isValidPrivateKey(privateKeyHex) {
	throwAbstractMethod();
    }

    sign(messageHex) {
	throwAbstractMethod();
    }

    static verify(pubKeyHex, messageHex, signatureHex) {
	throwAbstractMethod();
    }

    static getAlg() {
	throwAbstractMethod();
    }
}

module.exports = { Signer }