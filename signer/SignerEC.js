const crypto = require('crypto');
const secp256k1 = require('secp256k1');

class SignerEC extends Signer{
    constructor(privateKeyHex) {
        super(privateKeyHex);
        this.publicKey = secp256k1.publicKeyCreate(this.privateKey, false).toString('hex');
    }

    static generatePrivateKey() {
        let privateKey;
        do {
            privateKey = crypto.randomBytes(32);
        } while (!secp256k1.privateKeyVerify(privateKey));
        return privateKey.toString('hex');
    }

    static isValidPrivateKey(privateKeyHex) {
        try {
            const privateKey = Buffer.from(privateKeyHex, 'hex');
            return secp256k1.privateKeyVerify(privateKey);
        } catch {
            return false;
        }
    }

    sign(messageHex) {
        const messageBuffer = Buffer.from(messageHex, 'hex');
        if (messageBuffer.length !== 32) {
            throw new Error('Message must be 32 bytes in length');
        }
        const { signature } = secp256k1.ecdsaSign(messageBuffer, this.privateKey);
        return Buffer.from(signature).toString('hex');
    }

    static verify(pubKeyHex, messageHex, signatureHex) {
        const pubKey = Buffer.from(pubKeyHex, 'hex');
        const messageBuffer = Buffer.from(messageHex, 'hex');
        const signature = Buffer.from(signatureHex, 'hex');
        
        if (messageBuffer.length !== 32) {
            throw new Error('Message must be 32 bytes in length');
        }

        return secp256k1.ecdsaVerify(signature, messageBuffer, pubKey);
    }

    static getAlg() {
	return 'secp256k1';
    }
}
