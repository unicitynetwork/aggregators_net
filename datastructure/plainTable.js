onst fs = require('fs'); // Ensure fs is imported

class plainTable {
    constructor(params, STORAGE_FILE) { // Added STORAGE_FILE parameter
        this.storageName = params.unicityId + params.fragmentId;
        this.storagePath = "persistent_" + this.storageName + ".dat"; // Corrected this.storageName usage
        this.records = {};
        this.STORAGE_FILE = STORAGE_FILE; // Assign the STORAGE_FILE parameter
        if (fs.existsSync(this.storagePath)) {
            this.records = JSON.parse(fs.readFileSync(this.storagePath)); // Corrected this.records usage
        }
    }

    add(requestId, payload, authenticator) {
        if (this.records[requestId]) { // Corrected this.records usage
            if (this.records[requestId].payload !== payload) { // Corrected this.records usage
                throw new Error('Request ID already exists with different payload');
            }
            return;
        }
        // Store record (append-only)
        this.records[requestId] = { payload, authenticator };

        // Persist records to file
        fs.writeFileSync(this.STORAGE_FILE, JSON.stringify(this.records)); // Corrected this.STORAGE_FILE usage
    }

    get(requestId) {
        const proof = {};
        return { proof, content: this.records[requestId] }; // Corrected this.records usage
    }
}

module.exports = plainTable; // Added module.exports