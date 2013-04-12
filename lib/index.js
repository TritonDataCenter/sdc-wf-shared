// Copyright 2013 Joyent, Inc.  All rights reserved.

module.exports = {
    get cnapi() {
        return require('./cnapi');
    },
    get fwapi() {
        return require('./fwapi');
    },
    get napi() {
        return require('./napi');
    }
};
