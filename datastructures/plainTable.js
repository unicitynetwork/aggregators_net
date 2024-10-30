class plainTable{
    constructor(params){
	this.storageName = params.unicityId+params.fragmentId;
	this.storagePath = "persistent_"+storageName+".dat";
	this.records = {};
	if (fs.existsSync(this.storagePath)) {
	    records = JSON.parse(fs.readFileSync(this.storagePath));
	}
    }

    add(requestId, payload, authenticator){
	if (records[request_id]) {
	    if(records[request_id].payload != payload)
    		throw new Error('Request ID already exists');
	    return;
	}
	// Store record (append-only)
	records[request_id] = { payload, authenticator };

	// Persist records to file
	fs.writeFileSync(STORAGE_FILE, JSON.stringify(records));
    }

    
}