/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2014, Joyent, Inc.
 */

/*
 * NAPI: workflow shared functions
 */

// These must match the names available in the workflow VM:
var async = require('async');
var sdcClients = require('sdc-clients');



// --- Globals



// Make jslint happy:
var napiUrl;



// --- Exports



function validateNicParams(job, callback) {
    var filtered = [];

    if (!job.params.nics) {
        return callback(null, 'No nics specified');
    }

    if (!napiUrl) {
        callback(new Error('No napiUrl workflow parameter'));
        return;
    }

    if ((typeof (job.params.nics) !== 'object') ||
        !job.params.nics.hasOwnProperty('length')) {
        return callback(new Error('nics object must be an array'));
    }

    for (var n in job.params.nics) {
        var nicObj = job.params.nics[n];
        if (typeof (nicObj) !== 'object' ||
            nicObj.hasOwnProperty('length')) {
            return callback(
                new Error('nics object must be an array of objects'));
        }

        if (nicObj.hasOwnProperty('mac') &&
            nicObj.hasOwnProperty('nic_tags_provided')) {
            filtered.push({
                mac: nicObj.mac,
                nic_tags_provided: nicObj.nic_tags_provided
            });
        }
    }

    job.params.nics = filtered;

    callback(null, 'nic parameters OK!');
}


function getServerNics(job, callback) {
    // XXX: if something is set in job.params, return here
    if (!job.params.server_uuid) {
        return callback(new Error('No server_uuid specified'));
    }

    var napi = new sdcClients.NAPI({ url: napiUrl });
    napi.listNics({ belongs_to_uuid: job.params.server_uuid },
        function (err, res) {
        if (err) {
            job.log.error(err,
                'error listing server nics for server: '
                + job.params.server_uuid);
            return callback(err);
        }


        job.log.debug(res, 'successfully got nics for server: '
            + job.params.server_uuid);
        job.params.server_nics = res;

        return callback(null, res.length + ' nics retrieved from NAPI');
    });
}


function updateNics(job, callback) {
    if (!job.params.nics || job.params.nics.length === 0) {
        return callback(null, 'No nics to update');
    }

    var napi = new sdcClients.NAPI({ url: napiUrl });
    return async.forEach(job.params.nics, function (nic, cb) {
        var mac = nic.mac;
        napi.updateNic(mac, nic, function (err, res) {
            if (err) {
                job.log.error(err, 'error updating nic: ' + mac);
                return cb(err);
            }

            job.log.debug(res, 'successfully updated nic: ' + mac);
            return cb();
        });
    }, function (err) {
        if (err) {
            return callback(err);
        }

        return callback(null, 'nics updated in NAPI successfully');
    });
}


function deleteServerNics(job, callback) {
    if (!job.params.server_uuid || job.params.server_nics.length === 0) {
        return callback(null, 'No nics to update');
    }

    var napi = new sdcClients.NAPI({ url: napiUrl });
    return async.forEach(job.params.server_nics, function (nic, cb) {
        var mac = nic.mac;
        napi.deleteNic(mac, nic, function (err, res) {
            if (err) {
                job.log.error(err, 'error deleting nic: ' + mac);
                return cb(err);
            }
            job.log.debug(res, 'successfully deleting nic: ' + mac);
            return cb();
        });
    }, function (err) {
        if (err) {
            return callback(err);
        }
        return callback(null, 'nics deleted from NAPI successfully');
    });
}


function applyNicUpdates(job, callback) {
    if (!job.params.nics || job.params.nics.length === 0) {
        return callback(null, 'No nics to get changes for');
    }

    if (!job.params.nic_action) {
        return callback(new Error('No nic action specified'));
    }

    if (job.params.nic_action === 'replace') {
        return callback(null, 'replacing nic values');
    }

    if (!job.params.server_nics) {
        return callback(new Error('No server nics to update'));
    }

    var oldNics = {};
    job.params.server_nics.forEach(function (nic) {
        oldNics[nic.mac] = nic;
    });

    job.log.debug(oldNics, 'old nics');
    for (var n in job.params.nics) {
        var newNic = job.params.nics[n];
        if (!newNic.hasOwnProperty('mac') ||
            !oldNics.hasOwnProperty(newNic.mac)) {
            job.log.warn(newNic, 'missing mac or unknown nic');
            continue;
        }

        // Only allow updating nic_tags_provided for now
        if (!newNic.hasOwnProperty('nic_tags_provided')) {
            job.log.warn(newNic, 'missing nic_tags_provided');
            continue;
        }

        var oldNic = oldNics[newNic.mac];

        if (job.params.nic_action === 'delete') {
            var afterDeletes = [];

            // No nic tags to begin with, so there's nothing to delete
            if (!oldNic.nic_tags_provided) {
                continue;
            }

            oldNic.nic_tags_provided.forEach(function (tag) {
                if (newNic.nic_tags_provided.indexOf(tag) === -1) {
                    afterDeletes.push(tag);
                }
            });

            oldNic.nic_tags_provided = afterDeletes;
            continue;
        }

        if (job.params.nic_action === 'update') {
            newNic.nic_tags_provided.forEach(function (tag) {
                if (!oldNic.nic_tags_provided) {
                    oldNic.nic_tags_provided = [];
                }

                if (oldNic.nic_tags_provided.indexOf(tag) === -1) {
                    oldNic.nic_tags_provided.push(tag);
                }
            });
        }
    }

    var newNicParams = [];
    for (var o in oldNics) {
        newNicParams.push({
            mac: o,
            nic_tags_provided: oldNics[o].nic_tags_provided
        });
    }

    var msg = 'applied nic ' + job.params.nic_action + 's';
    job.log.info(newNicParams, msg);
    job.params.nics = newNicParams;
    return callback(null, msg);
}



module.exports = {
    applyNicUpdates: applyNicUpdates,
    getServerNics: getServerNics,
    updateNics: updateNics,
    deleteServerNics: deleteServerNics,
    validateNicParams: validateNicParams
};
