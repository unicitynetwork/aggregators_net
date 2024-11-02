const { throwAbstractInstantiate, throwAbstractMethod } = require("../helper.js");

class Storage{
    constructor(id){
	if(if new.target == Storage)
	    throwAbstractInstantiate();
	this.id = id;
    }

    async put(key, content){
	throwAbstractMethod();
    }

    async get(key){
	throwAbstractMethod();
    }
}