
function throwAbstractInstantiate(){
    throw new TypeError("Cannot instantiate abstract class");
}

function throwAbstractMethod(){
    throw new Error("Cannot call method from abstract class");
}

module.exports = {
    throwAbstractInstantiate,
    throwAbstractMethod
}
