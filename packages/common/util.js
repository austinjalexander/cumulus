'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const log = require('./log');

/**
 * Mark a piece of code as deprecated
 *
 * @param {string} name - the name of the function / method / class to deprecate
 * @param {string} version - the version after which the code will be marked
 *   as deprecated
 * @param {string} [alternative] - the function / method / class to use instead
 *   of this deprecated code
 */
exports.deprecate = (name, version, alternative) => {
  let message = `${name} is deprecated after version ${version} and will be removed in a future release.`;
  if (alternative) message += ` Use ${alternative} instead.`;

  log.warn(message);
};

/**
 * Wait for the defined number of milliseconds
 *
 * @param {number} waitPeriodMs - number of milliseconds to wait
 * @returns {Promise.<undefined>} - promise resolves after a given time period
 */
exports.sleep = (waitPeriodMs) =>
  (new Promise((resolve) =>
    setTimeout(resolve, waitPeriodMs)));

/**
 * Synchronously makes a temporary directory, smoothing over the differences between
 * mkdtempSync in node.js for various platforms and versions
 *
 * @param {string} name - A base name for the temp dir, to be uniquified for the final name
 * @returns {string} - The absolute path to the created dir
 */
exports.mkdtempSync = (name) => {
  const dirname = ['gitc', name, +new Date()].join('_');
  const abspath = path.join(os.tmpdir(), dirname);
  fs.mkdirSync(abspath, 0o700);
  return abspath;
};

/**
 * Generate and return an RFC4122 v4 UUID.
 * @return - An RFC44122 v4 UUID.
 */
exports.uuid = require('uuid/v4');

/**
 * Does nothing.  Used where a callback is required but not used.
 *
 * @returns {undefined} undefined
 */
exports.noop = () => {}; // eslint-disable-line lodash/prefer-noop

// eslint-disable-next-line lodash/prefer-is-nil
exports.isNil = (x) => (x === undefined) || (x === null);
exports.isNotNil = (x) => !exports.isNil(x);

exports.isNotNull = (x) => x !== null;
