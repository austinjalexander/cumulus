'use strict';

const { randomString } = require('@cumulus/common/test-utils');
const { Search } = require('../es/search');
const { createJwtToken } = require('./token');

/**
 * mocks the context object of the lambda function with
 * succeed and fail functions to facilitate testing of
 * lambda functions used as backend in ApiGateway
 *
 * Intended for use with unit tests.  Will invoke the function locally.
 *
 * @param {Function} endpoint - the lambda function used as ApiGateway backend
 * @param {Object} event - aws lambda event object
 * @param {Function} testCallback - aws lambda callback function
 * @returns {Promise<Object>} the promise returned by the lambda function
 */
function testEndpoint(endpoint, event, testCallback) {
  return new Promise((resolve, reject) => {
    endpoint(event, {
      succeed: (response) => resolve(testCallback(response)),
      fail: (e) => reject(e)
    });
  });
}

/**
 * searches for all the existings aliases in ElasticSearch and delete
 * all of them
 *
 * @returns {Promise<Array>} a list of elasticsearch responses
 */
async function deleteAliases() {
  const client = await Search.es();
  const aliases = await client.cat.aliases({ format: 'json' });

  // delete all aliases
  return Promise.all(aliases.map((alias) => client.indices.deleteAlias({
    index: alias.index,
    name: '_all'
  })));
}

/**
 * Generates fake files for a granule
 *
 * @param {string} bucket - a bucket name
 * @returns {Object} a file record
 */
function fakeFilesFactory(bucket) {
  const key = randomString();
  const name = randomString();
  const filepath = `${key}/${name}`;
  const filename = `s3://${bucket}/${filepath}`;
  return {
    bucket,
    name,
    filepath,
    filename
  };
}

/**
 * Returns a fake Granule record
 *
 * @param {string} status - granule status (default to completed)
 * @returns {Object} fake granule object
 */
function fakeGranuleFactory(status = 'completed') {
  return {
    granuleId: randomString(),
    dataType: randomString(),
    version: randomString(),
    collectionId: 'fakeCollection___v1',
    status,
    execution: randomString(),
    createdAt: Date.now(),
    published: true,
    cmrLink: 'example.com',
    productVolume: 100
  };
}

/**
 * Returns a fake Granule record
 *
 * @param {Object} options - properties to set on the granule
 * @returns {Object} fake granule object
 */
function fakeGranuleFactoryV2(options = {}) {
  return Object.assign(
    fakeGranuleFactory(),
    options
  );
}

/**
 * Create a fake rule record
 *
 * @param {Object} params - overrides
 * @returns {Object} fake rule object
 */
function fakeRuleFactoryV2(params = {}) {
  const rule = {
    name: randomString(),
    workflow: randomString(),
    provider: randomString(),
    collection: {
      name: randomString(),
      version: '0.0.0'
    },
    rule: {
      type: 'onetime'
    },
    state: 'DISABLED'
  };

  return { ...rule, ...params };
}

/**
 * creates fake rule record
 *
 * @param {string} state - rule state (default to DISABLED)
 * @returns {Object} fake rule object
 */
function fakeRuleFactory(state = 'DISABLED') {
  return fakeRuleFactoryV2({ state });
}

function fakePdrFactoryV2(overrides = {}) {
  return {
    pdrName: randomString(),
    collectionId: 'fakeCollection___v1',
    provider: 'fakeProvider',
    status: 'completed',
    createdAt: Date.now(),
    ...overrides
  };
}

/**
 * creates fake pdr records
 *
 * @param {string} status - pdr status (default to completed)
 * @returns {Object} fake pdr object
 */
function fakePdrFactory(status = 'completed') {
  return fakePdrFactoryV2({ status });
}

/**
 * creates fake execution records
 *
 * @param {string} status - pdr status (default to completed)
 * @param {string} type - workflow type (default to fakeWorkflow)
 * @returns {Object} fake execution object
 */
function fakeExecutionFactory(status = 'completed', type = 'fakeWorkflow') {
  return {
    arn: randomString(),
    duration: 180.5,
    name: randomString(),
    status,
    createdAt: Date.now(),
    type
  };
}

/**
 * Build a user that can be authenticated against
 *
 * @param {Object} params - params
 * @param {string} params.userName - a username
 *   Defaults to a random string
 * @param {string} params.password - a password
 *   Defaults to a random string
 * @param {integer} params.expires - an expiration time for the token
 *   Defaults to one hour from now
 * @returns {Object} - a fake user
 */
function fakeUserFactory(params = {}) {
  const {
    userName = randomString(),
    password = randomString(),
    expires = Date.now() + (60 * 60 * 1000) // Default to 1 hour
  } = params;

  return {
    userName,
    password,
    expires
  };
}

/**
 * creates fake collection records
 *
 * @param {Object} options - properties to set on the collection
 * @returns {Object} fake collection object
 */
function fakeCollectionFactory(options = {}) {
  return {
    name: randomString(),
    dataType: randomString(),
    version: '0.0.0',
    provider_path: '/',
    duplicateHandling: 'replace',
    granuleId: '^MOD09GQ\\.A[\\d]{7}\\.[\\S]{6}\\.006\\.[\\d]{13}$',
    granuleIdExtraction: '(MOD09GQ\\.(.*))\\.hdf',
    sampleFileName: 'MOD09GQ.A2017025.h21v00.006.2017034065104.hdf',
    files: [],
    ...options
  };
}

/**
 * creates fake provider records
 *
 * @param {Object} options - properties to set on the provider
 * @returns {Object} fake provider object
 */
function fakeProviderFactory(options = {}) {
  return Object.assign(
    {
      id: randomString(),
      globalConnectionLimit: 1,
      protocol: 'http',
      host: randomString(),
      port: 80
    },
    options
  );
}

function fakeAccessTokenFactory(params = {}) {
  return {
    accessToken: randomString(),
    refreshToken: randomString(),
    username: randomString(),
    expirationTime: Date.now() + (60 * 60 * 1000),
    ...params
  };
}

async function createFakeJwtAuthToken({ accessTokenModel, userModel }) {
  const userRecord = fakeUserFactory();
  await userModel.create(userRecord);

  const {
    accessToken,
    refreshToken,
    expirationTime
  } = fakeAccessTokenFactory();
  await accessTokenModel.create({ accessToken, refreshToken });

  return createJwtToken({ accessToken, expirationTime, username: userRecord.userName });
}

module.exports = {
  createFakeJwtAuthToken,
  testEndpoint,
  fakeAccessTokenFactory,
  fakeGranuleFactory,
  fakeGranuleFactoryV2,
  fakePdrFactory,
  fakePdrFactoryV2,
  fakeCollectionFactory,
  fakeExecutionFactory,
  fakeRuleFactory,
  fakeRuleFactoryV2,
  fakeFilesFactory,
  fakeUserFactory,
  fakeProviderFactory,
  deleteAliases
};
