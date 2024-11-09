const crypto = require('crypto');

class SHA256Hasher{
    async hash(hexMsg){
	const h = crypto.createHash('sha256');
	h.update(Buffer.from(hexMsg, 'hex'));
	return h.digest('hex');
    }

    static getAlg(){
	return 'sha256';
    }
}

module.exports = { SHA256Hasher }

