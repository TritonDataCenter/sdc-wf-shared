/*
 * Copyright (c) 2013, Joyent, Inc. All rights reserved.
 *
 * FWAPI: workflow shared functions
 */

// These must match the names available in the workflow VM:
var async = require('async');
var restify = require('restify');
var sdcClients = require('sdc-clients');



// --- Globals



// Make jslint happy:
var cnapiUrl;
var fwapiUrl;
var vmapiUrl;



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
function cnapiFwUpdate(job, callback) {
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
 * Poll CNAPI for each of the tasks started in a previous workflow task
 *
 * Inputs:
 * - job.params.taskIDs {Array} : task ID objects as per cnapiFwUpdate()
 *
 * Outputs:
 * - job.params.taskSuccesses {Array} : task ID objects of successes
 * - job.params.taskFailures {Array} : task ID objects of failures
 */
function cnapiPollTasks(job, callback) {
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
          return cb(new Error('Job "' + detail.taskID
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
 * Filters the FWAPI server list
 */
function filterServers(job, cb) {
  if (!job.params.fwapiServers || job.params.fwapiServers.length !== 0) {
    return cb(null, 'No FWAPI servers: not filtering');
  }

  if (!job.params.server_uuid) {
    return cb(null, 'No server_uuid in params: not filtering');
  }

  job.params.fwapiServers = job.params.fwapiServers.filter(function (u) {
    return (u !== job.params.server_uuid);
  });

  return cb(null, 'Removed server_uuid ' + job.params.server_uuid
    + ' from FWAPI server list');
}


/**
 * Get VMs from VMAPI
 *
 * Inputs:
 *
 * - job.params {Object} : must specify at least one of tags, vms:
 *   - fwapiTags {Array} : tag names to search for
 *   - fwapiVMs {Array} : VM UUIDs to search for
 *
 * Outputs:
 *
 * Once function is complete, the following will be stored in job.params:
 * - fwapiMatchingVMs {Object} : mapping of machines to IP addresses
 * - fwapiServers {Object} : server UUIDs that contain the matching VMs
 */
function getVMs(job, callback) {
  if (!job.params.hasOwnProperty('fwapiTags') &&
    !job.params.hasOwnProperty('fwapiVMs')) {
    return callback(null, 'No tags or VMs to get');
  }

  var tags = job.params.fwapiTags || [];
  var vms = job.params.fwapiVMs || [];
  if (tags.length === 0 && vms.length === 0) {
    return callback(null, 'No tags or VMs to get');
  }

  var left = {
    tags: tags.reduce(function (acc, t) { acc[t] = 1; return acc; }, {}),
    vms:  vms.reduce(function (acc, vm) { acc[vm] = 1; return acc; }, {})
  };

  var filter = [];
  if (tags.length !== 0) {
    tags.forEach(function (t) {
      filter.push('(tags=*' + t + '=*)');
    });
  }

  if (vms.length !== 0) {
    vms.forEach(function (vm) {
      filter.push('(uuid=' + vm + ')');
    });
  }

  if (filter.length !== 1) {
    filter = ['(|'].concat(filter).concat(')');
  }

  // Filter by owner_uuid here?

  var filterTxt = filter.join('');
  job.log.debug('listing VMs: %s', filterTxt);

  var vmapi = new sdcClients.VMAPI({ url: vmapiUrl });
  return vmapi.listVms({ query: filterTxt }, function (err, vmList) {
    if (err) {
      return callback(err);
    }

    var remoteVMs = [];
    var servers = {};

    if (job.params.task && job.params.task === 'provision') {
      vmList.push({
        firewall_enabled: job.params.firewall_enabled,
        nics: job.params.nics,
        owner_uuid: job.params.owner_uuid,
        server_uuid: job.params.server_uuid,
        tags: job.params.tags || { },
        uuid: job.params.uuid
      });
    }

    vmList.forEach(function (vm) {
      var rvm = {
        enabled: vm.firewall_enabled ? true : false,
        ips: vm.nics.map(function (n) { return n.ip; }),
        owner_uuid: vm.owner_uuid,
        server_uuid: vm.server_uuid,
        tags: { },
        uuid: vm.uuid
      };

      for (var k in vm.tags) {
        rvm.tags[k] = vm.tags[k];
      }

      remoteVMs.push(rvm);
      servers[vm.server_uuid] = 1;

      for (var tag in vm.tags) {
        delete left.tags[tag];
      }

      delete left.vms[vm.uuid];
    });

    job.log.info({ vms: remoteVMs, filter: filterTxt },
      'Found %d remote VMs', remoteVMs.length);

    var s;
    var errs = [];
    var vmsLeft = Object.keys(left.vms);
    var tagsLeft = Object.keys(left.tags);

    // Allow unknown tags - the rules could have been created in advance
    // with the intention of adding VMs with those tags later
    if (tagsLeft.length !== 0) {
      s = tagsLeft.length === 0 ? '' : 's';
      job.log.info('No VMs with tag%s: %s', s, tagsLeft.join(', '));
    }

    if (vmsLeft.length !== 0) {
      s = vmsLeft.length === 0 ? '' : 's';
      errs.push(new Error('Unknown VM' + s + ': '
        + vmsLeft.join(', ')));
    }

    if (errs.length !== 0) {
      return callback(new Error(errs.map(function (e) {
        return e.message;
      }).join('\n')));
    }

    job.params.fwapiMatchingVMs = remoteVMs;
    job.params.fwapiServers = Object.keys(servers);

    job.log.info({ matchingVMs: remoteVMs, servers: job.params.fwapiServers },
      'firewall VM data retrieved');
    return callback(null, 'firewall VM data retrieved');
  });
}


/**
 * Populates firewall data for provisioning
 */
function populateFirewallData(job, cb) {
  if (!job.params.fwapiResolveData) {
    return cb(null, 'No firewall data to populate');
  }

  var resolved = job.params.fwapiResolveData;
  var firewall = {};
  var haveData = false;
  var matchingVMs = job.params.fwapiMatchingVMs || [];
  var msg;
  var server_uuid = job.params.server_uuid;

  if (resolved.rules && resolved.rules.length !== 0) {
    firewall.rules = resolved.rules;
    haveData = true;
  }

  if (matchingVMs.length !== 0) {
    var remoteVMs = matchingVMs.filter(function (rvm) {
      return (rvm.server_uuid != server_uuid);
    });

    if (remoteVMs.length !== 0) {
      firewall.remoteVMs = remoteVMs;
      haveData = true;
    }
  }

  // Don't bother sending a separate provisioner message for the server
  // the VM is going to be provisioned on: it will have this data already
  if (job.params.fwapiServers && job.params.fwapiServers.length !== 0) {
    job.params.fwapiServers = job.params.fwapiServers.filter(function (u) {
      return (u !== server_uuid);
    });
  }

  if (haveData) {
    job.params.firewall = firewall;
    msg = 'Added firewall data to payload';
  } else {
    msg = 'No firewall data added to payload';
  }

  job.log.debug(firewall, msg);
  return cb(null, msg);
}


/**
 * Gets firewall data from FWAPI
 */
function resolveFirewallData(job, cb) {
    var fwapi = restify.createJsonClient({ url: fwapiUrl });
    var ips = [];
    var tags = {};
    var t;

    if (job.params.hasOwnProperty('nics')) {
      ips = job.params.nics.map(function (n) { return n.ip; });
    }

    if (job.params.hasOwnProperty('tags')) {
      for (t in job.params.tags) {
        tags[t] = job.params.tags[t];
      }
    }

    if (job.params.hasOwnProperty('remove_tags')) {
      for (t in job.params.remove_tags) {
        tags[t] = job.params.remove_tags[t];
      }
    }

    if (job.params.hasOwnProperty('set_tags')) {
      for (t in job.params.set_tags) {
        tags[t] = job.params.set_tags[t];
      }
    }

    if (job.params.task == 'update' && ips.length === 0 &&
      Object.keys(tags).length === 0) {
      return cb(null, 'No tags or ips updated: not retrieving firewall data');
    }

    var params = {
        ips: ips,
        owner_uuid: job.params.owner_uuid,
        tags: tags,
        vms: [ job.params.uuid ]
    };

    job.log.debug({ query: params }, 'Resolving firewall data from FWAPI');
    return fwapi.post('/resolve', params, function (err, req, res, firewall) {
        if (err) {
            return cb(err);
        } else {
            job.params.fwapiResolveData = firewall;
            job.params.fwapiVMs = firewall.vms || [];
            job.params.fwapiTags = firewall.tags || [];
            return cb(null, 'Firewall data retrieved');
        }
    });
}



module.exports = {
  cnapiFwUpdate: cnapiFwUpdate,
  cnapiPollTasks: cnapiPollTasks,
  filterServers: filterServers,
  getVMs: getVMs,
  populateFirewallData: populateFirewallData,
  resolveFirewallData: resolveFirewallData
};
