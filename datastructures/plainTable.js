class plainTable{
    constructor(params){
	this.storageName = params.unicityId+params.fragmentId;
	this.storagePath = "persistent_"+storageName+".dat";
	this.records = {};
	if (fs.existsSync(this.storagePath)) {
	    records = JSON.parse(fs.readFileSync(this.storagePath));
	}
    }

    async add(requestId, payload, authenticator){
	if (records[requestId]) {
	    if(records[requestId].payload != payload)
    		throw new Error('Request ID already exists');
	    return;
	}
	// Store record (append-only)
	records[requestId] = { payload, authenticator };

	// Persist records to file
	fs.writeFileSync(STORAGE_FILE, JSON.stringify(records));
    }

    async get(requestId){
	const proof = {};
	return {proof, content: records[requestId]};
    }
}