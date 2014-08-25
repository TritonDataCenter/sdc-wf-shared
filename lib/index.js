/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2014, Joyent, Inc.
 */

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
