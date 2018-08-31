/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2018, Joyent, Inc.
 */

/*
 * CNAPI: workflow shared functions
 */

// These must match the names available in the workflow VM:
var async = require('async');
var restify = require('restify');
var sdcClients = require('sdc-clients');



// --- Globals



// Make jslint happy:
var cnapiUrl;



// --- Exports



/**
 * Get the server sysinfo objects for the given UUIDs
 *
 * Inputs:
 *
 * - job.params {Object} :
 *   - serverUUIDs {Array of UUIDs} : UUIDS of servers to get sysinfos for
 *
 * - job.servers {Array} : (optional) If present, as many sysinfo objects as
 *   possible will be pulled from here in an attempt to avoid calling out to
 *   CNAPI
 *
 * Outputs:
 *
 * Once function is complete, the following will be stored in job.params:
 * - cnapiSysinfos {Object} : CNAPI server objects containing a sysinfo
 *   subobject
 */
function sysinfoList(job, callback) {
        if (!job.params.serverUUIDs) {
            return callback(null, 'No server UUIDs to fetch');
        }

        var cnapi = new sdcClients.CNAPI({ url: cnapiUrl });
        var params = {
            extras: 'sysinfo',
            uuids: job.params.serverUUIDs.join(',')
        };
        job.params.cnapiSysinfos = [];

        // If we have job.servers from an earlier task, use as many of those
        // as we can to try and avoid hitting CNAPI again
        if (job.servers) {
            var uuids = {};
            job.params.serverUUIDs.forEach(function (uuid) {
                uuids[uuid] = 1;
            });

            job.servers.forEach(function (s) {
                if (uuids.hasOwnProperty(s.uuid)) {
                    delete uuids[s.uuid];
                    job.params.cnapiSysinfos.push(s);
                }
            });
            params.uuids = Object.keys(uuids);
        }

        if (params.uuids.length === 0) {
            return callback(null,
                'Server info cached from get_servers: not fetching');
        }

        return cnapi.listServers(params, function (err, servers) {
            if (err) {
                return callback(err);
            }

            if (!Array.isArray(servers) || servers.length === 0) {
                return callback(new Error('No servers found'));
            }

            job.params.cnapiSysinfos = job.params.cnapiSysinfos.concat(servers);
            job.log.debug(servers.map(function (s) { return s.UUID; }),
                'getServers: servers found');

            return callback(null, 'Got servers');
        });
}


/**
 * Start a provisioner task with CNAPI on a servers to update nics.
 *
 * Inputs:
 * - job.params.server_uuid {UUID} : server UUIDs to send update task to
 * - job.params.nics {Array}: nic objects to update
 *
 * Outputs:
 * - job.params.taskIDs {Array}: task objects to poll in a later task, where
 *   each task object looks like:
 *     { server_uuid: uuid, task_id: id }
 */
function nicUpdate(job, callback) {
        if (!job.params.nics || job.params.nics.length === 0) {
            return callback(null, 'No nics to update');
        }

        var cnapi = new sdcClients.CNAPI({ url: cnapiUrl });
        var endpoint = '/servers/' + job.params.server_uuid + '/nics/update';
        job.params.taskIDs = [];

        job.log.debug(job.params.nics, 'Updating rules on server "%s"',
            job.params.server_uuid);

        return cnapi.post(endpoint, { nics: job.params.nics },
            function (err, task) {
            if (err) {
                return callback(err);
            }

            job.log.debug(task, 'Server "%s": nic update task "%s"',
                job.params.server_uuid, task.id);
            job.params.taskIDs.push({ server_uuid: job.params.server_uuid,
                task_id: task.id});
            return callback(null, 'Started nic update task on server');
        });
}


/**
 * Poll CNAPI for each of the tasks started in a previous workflow task
 *
 * Inputs:
 * - job.params.taskIDs {Array}: task objects to poll, where each task object
 *   looks like:
 *     { server_uuid: uuid, task_id: id }
 *
 * Outputs:
 * - job.params.taskSuccesses {Array} : task ID objects of successes
 * - job.params.taskFailures {Array} : task ID objects of failures
 */
function pollTasks(job, callback) {
    if (!job.params.taskIDs || job.params.taskIDs.length === 0) {
        return callback(null, 'No tasks to poll');
    }

    var cnapi = new sdcClients.CNAPI({ url: cnapiUrl });

    job.params.taskSuccesses = [];
    job.params.taskFailures = [];

    return async.forEach(job.params.taskIDs, function (detail, cb) {
        var timeout = null;

        function pollOne() {
            cnapi.getTask(detail.task_id, function onCnapi(err, task) {
                if (timeout) {
                    clearTimeout(timeout);
                }

                if (err) {
                    return cb(err);
                }

                job.log.debug(task, 'retrieved task for server "%s"',
                    detail.server_uuid);
                if (task.status == 'failure') {
                    job.params.taskFailures.push(detail);
                    return cb(new Error('CNAPI task "' + detail.task_id
                        + '" failed for server "' + detail.server_uuid + '"'));
                }

                if (task.status == 'complete') {
                    if (task.history &&
                        task.history[0] &&
                        task.history[0].event) {

                        job.returned_sysinfo = task.history[0].event.sysinfo;
                    }

                    job.log.debug({
                        sysinfo: job.returned_sysinfo
                    }, 'task complete');

                    job.params.taskSuccesses.push(detail);
                    return cb(null);
                }

                timeout = setTimeout(pollOne, 1000);
            });
        }

        pollOne();
    }, function (err) {
        if (err) {
            return callback(err);
        }

        return callback(null, 'All server tasks returned successfully');
    });
}


/**
 * Trigger a sysinfo refresh in CNAPI
 *
 * Inputs:
 * - job.params.server_uuid {String}: UUID of the server whose sysinfo should be
 *   refreshed.
 *
 * Outputs:
 * - job.params.taskSuccesses {Array} : task ID objects of successes
 * - job.params.taskFailures {Array} : task ID objects of failures
 */
function refreshServerSysinfo(job, callback) {
    var body = {};
    var cnapi = restify.createJsonClient({ url: cnapiUrl});
    var serverUrl = '/servers/' + job.params.server_uuid + '/sysinfo-refresh';

    if (job.returned_sysinfo) {
        // If the job already got the updated sysinfo as a result of it being
        // returned by the task we just ran, use that so we don't bother with
        // another round of wf -> CNAPI -> Ur -> ur-agent -> sysinfo and back.

        serverUrl = '/servers/' + job.params.server_uuid + '/sysinfo';
        body = {sysinfo: job.returned_sysinfo};
        job.log.debug({sysinfo: job.returned_sysinfo},
            'POSTing sysinfo received from task');
    }

    cnapi.post(serverUrl, body, function _sysinfoPosted(error, req, res) {
        if (error) {
            job.log.info('Error refreshing server sysinfo');
            job.log.info(error.stack.toString());
            callback(error);
            return;
        }
        callback();
    });
}



module.exports = {
    sysinfoList: sysinfoList,
    nicUpdate: nicUpdate,
    pollTasks: pollTasks,
    refreshServerSysinfo: refreshServerSysinfo
};
