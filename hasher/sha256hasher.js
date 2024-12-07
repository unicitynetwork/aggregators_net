const CryptoJS = require('crypto-js');

class SHA256Hasher{
    static hash(hexMsg){
	return CryptoJS.SHA256(CryptoJS.enc.Hex.parse(hexMsg)).toString();
    }

    static getAlg(){
	return 'sha256';
    }
}

module.exports = { SHA256Hasher }

