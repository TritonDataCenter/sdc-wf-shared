/*
 * Copyright (c) 2013, Joyent, Inc. All rights reserved.
 *
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
 * Start a provisioner task with CNAPI on each of the servers to update
 * the firewall data.
 *
 * Inputs:
 * - job.params.fwapiServers {Array} : server UUIDs to send update tasks to
 *
 * Outputs:
 * - job.params.taskIDs {Array}: task objects to poll in a later task, where
 *   each task object looks like:
 *     { server_uuid: uuid, task_id: id }
 */
function fwUpdate(job, callback) {
  if (!job.params.fwapiServers || job.params.fwapiServers.length === 0) {
    return callback(null, 'No remote servers to update');
  }

  var cnapi = new sdcClients.CNAPI({ url: cnapiUrl });
  var matchingVMs = job.params.fwapiMatchingVMs || [];
  job.params.taskIDs = [];

  return async.forEach(job.params.fwapiServers, function (uuid, cb) {
    var endpoint = '/servers/' + uuid + '/fw/update';
    var firewall = {
      jobid: job.uuid
    };

    if (job.params.hasOwnProperty('rule')) {
      firewall.rules = [ job.params.rule ];
    }

    var remoteVMs = matchingVMs.filter(function (rvm) {
      return (rvm.server_uuid != uuid);
    });

    if (remoteVMs.length) {
      firewall.remoteVMs = remoteVMs;
    }

    job.log.debug(firewall, 'Updating rules on server "%s"', uuid);
    return cnapi.post(endpoint, firewall, function (err, task) {
      if (err) {
        return cb(err);
      }
      job.log.debug(task, 'Server "%s": task', uuid);

      job.params.taskIDs.push({ server_uuid: uuid, task_id: task.id});
      return cb(null);
    });

  }, function (err) {
    if (err) {
      return callback(err);
    }

    return callback(null, 'Started update on servers: '
      + job.params.fwapiServers.join(', '));
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
 * - job.params.taskIDs {Array} : task ID objects as per fwUpdate()
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
    var intervalID = setInterval(interval, 1000);

    function interval() {
      cnapi.getTask(detail.task_id, function onCnapi(err, task) {
        if (err) {
          clearInterval(intervalID);
          return cb(err);
        }

        job.log.debug(task, 'retrieved task for server "%s"',
          detail.server_uuid);
        if (task.status == 'failure') {
          clearInterval(intervalID);
          job.params.taskFailures.push(detail);
          return cb(new Error('Job "' + detail.task_id
            + '" failed for server "' + detail.server_uuid + '"'));
        }

        if (task.status == 'complete') {
          clearInterval(intervalID);
          job.params.taskSuccesses.push(detail);
          return cb(null);
        }
      });
    }
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
 * - job.params.taskIDs {Array} : task ID objects as per fwUpdate()
 *
 * Outputs:
 * - job.params.taskSuccesses {Array} : task ID objects of successes
 * - job.params.taskFailures {Array} : task ID objects of failures
 */
function refreshServerSysinfo(job, callback) {
    var cnapi = restify.createJsonClient({ url: cnapiUrl});
    var serverUrl = '/servers/' + job.params.server_uuid + '/sysinfo-refresh';

    cnapi.post(serverUrl, {}, function (error, req, res) {
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
  fwUpdate: fwUpdate,
  nicUpdate: nicUpdate,
  pollTasks: pollTasks,
  refreshServerSysinfo: refreshServerSysinfo
};
