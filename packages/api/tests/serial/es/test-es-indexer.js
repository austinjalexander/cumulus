'use strict';

const cloneDeep = require('lodash.clonedeep');
const test = require('ava');
const sinon = require('sinon');
const fs = require('fs');
const clone = require('lodash.clonedeep');
const path = require('path');
const aws = require('@cumulus/common/aws');
const cmrjs = require('@cumulus/cmrjs');
const { randomString } = require('@cumulus/common/test-utils');
const {
  constructCollectionId,
  util: { noop }
} = require('@cumulus/common');

const indexer = require('../../../es/indexer');
const { Search } = require('../../../es/search');
const models = require('../../../models');
const {
  deleteAliases,
  fakeCollectionFactory,
  fakeGranuleFactory,
  fakeProviderFactory
} = require('../../../lib/testUtils');
const { bootstrapElasticSearch } = require('../../../lambdas/bootstrap');
const granuleSuccess = require('../../data/granule_success.json');
const granuleFailure = require('../../data/granule_failed.json');
const pdrFailure = require('../../data/pdr_failure.json');
const pdrSuccess = require('../../data/pdr_success.json');

const esIndex = randomString();
process.env.bucket = randomString();
process.env.internal = process.env.bucket;
process.env.stackName = randomString();
process.env.ES_INDEX = esIndex;
let esClient;

let collectionModel;
let providerModel;
test.before(async () => {
  await deleteAliases();

  collectionModel = new models.Collection();
  providerModel = new models.Provider();

  // create the elasticsearch index and add mapping
  await bootstrapElasticSearch('fakehost', esIndex);
  esClient = await Search.es();

  // create buckets
  await aws.s3().createBucket({ Bucket: process.env.bucket }).promise();

  const fakeMetadata = {
    time_start: '2017-10-24T00:00:00.000Z',
    time_end: '2018-10-24T00:00:00.000Z',
    updated: '2018-04-20T21:45:45.524Z',
    dataset_id: 'MODIS/Terra Surface Reflectance Daily L2G Global 250m SIN Grid V006',
    data_center: 'CUMULUS',
    title: 'MOD09GQ.A2016358.h13v04.006.2016360104606'
  };

  sinon.stub(cmrjs, 'getMetadata').callsFake(() => fakeMetadata);

  const fakeXmlMetadata = {
    GranuleUR: 'MOD09GQ.A2016358.h13v04.006.2016360104606',
    DataGranule: {
      ProductionDateTime: '2018-04-25T21:45:45.524Z'
    }
  };

  sinon.stub(cmrjs, 'getFullMetadata').callsFake(() => fakeXmlMetadata);
});

test.after.always(async () => {
  await esClient.indices.delete({ index: esIndex });
  await aws.recursivelyDeleteS3Bucket(process.env.bucket);

  cmrjs.getMetadata.restore();
  cmrjs.getFullMetadata.restore();
});

test.serial('creating a successful granule record', async (t) => {
  const payload = cloneDeep(granuleSuccess);

  payload.payload.granules[0].granuleId = randomString();

  // Stub out headobject S3 call used in api/models/granules.js,
  // so we don't have to create artifacts
  sinon.stub(aws, 'headObject').resolves({ ContentLength: 12345 });

  const granule = payload.payload.granules[0];

  payload.meta.collection = fakeCollectionFactory();
  await collectionModel.create(payload.meta.collection);

  const collectionId = constructCollectionId(
    payload.meta.collection.name,
    payload.meta.collection.version
  );

  payload.meta.provider = fakeProviderFactory();
  await providerModel.create(payload.meta.provider);

  const records = await indexer.granule(payload);

  // check the record exists
  const record = records[0];

  t.deepEqual(record.files, granule.files);
  t.is(record.status, 'completed');
  t.is(record.collectionId, collectionId);
  t.is(record.granuleId, granule.granuleId);
  t.is(record.cmrLink, granule.cmrLink);
  t.is(record.published, granule.published);
  t.is(record.productVolume, 17934423);
  t.is(record.beginningDateTime, '2017-10-24T00:00:00.000Z');
  t.is(record.endingDateTime, '2018-10-24T00:00:00.000Z');
  t.is(record.productionDateTime, '2018-04-25T21:45:45.524Z');
  t.is(record.lastUpdateDateTime, '2018-04-20T21:45:45.524Z');
  t.is(record.timeToArchive, 100 / 1000);
  t.is(record.timeToPreprocess, 120 / 1000);
  t.is(record.processingStartDateTime, '2018-05-03T14:23:12.010Z');
  t.is(record.processingEndDateTime, '2018-05-03T17:11:33.007Z');

  const { name: deconstructed } = indexer.deconstructCollectionId(record.collectionId);
  t.is(deconstructed, payload.meta.collection.name);
});

test.serial('creating multiple successful granule records', async (t) => {
  const newPayload = clone(granuleSuccess);
  const granule = newPayload.payload.granules[0];
  granule.granuleId = randomString();
  const granule2 = clone(granule);
  granule2.granuleId = randomString();
  newPayload.payload.granules.push(granule2);

  newPayload.meta.collection = fakeCollectionFactory();
  await collectionModel.create(newPayload.meta.collection);
  const collectionId = constructCollectionId(
    newPayload.meta.collection.name,
    newPayload.meta.collection.version
  );

  newPayload.meta.provider = fakeProviderFactory();
  await providerModel.create(newPayload.meta.provider);

  const records = await indexer.granule(newPayload);

  t.is(records.length, 2);

  records.forEach((record) => {
    t.is(record.status, 'completed');
    t.is(record.collectionId, collectionId);
    t.is(record.cmrLink, granule.cmrLink);
    t.is(record.published, granule.published);
  });
});

test.serial('creating a failed granule record', async (t) => {
  const payload = cloneDeep(granuleFailure);

  payload.meta.collection = fakeCollectionFactory();
  await collectionModel.create(payload.meta.collection);

  payload.meta.provider = fakeProviderFactory();
  await providerModel.create(payload.meta.provider);

  payload.payload.granules[0].granuleId = randomString();

  const granule = payload.payload.granules[0];

  const records = await indexer.granule(payload);

  const record = records[0];
  t.deepEqual(record.files, granule.files);
  t.is(record.status, 'failed');
  t.is(record.granuleId, granule.granuleId);
  t.is(record.published, false);
  t.is(record.error.Error, payload.exception.Error);
  t.is(record.error.Cause, payload.exception.Cause);
});

test.serial('creating a granule record without state_machine info', async (t) => {
  const newPayload = clone(granuleSuccess);
  delete newPayload.cumulus_meta.state_machine;

  const r = await indexer.granule(newPayload);
  t.is(r, undefined);
});

test.serial('creating a granule record without a granule', async (t) => {
  const newPayload = clone(granuleSuccess);
  delete newPayload.payload;
  delete newPayload.meta;

  const r = await indexer.granule(newPayload);
  t.is(r, undefined);
});

test.serial('creating a granule record in meta section', async (t) => {
  const newPayload = clone(granuleSuccess);
  delete newPayload.payload;
  newPayload.meta.status = 'running';

  newPayload.meta.collection = fakeCollectionFactory();
  await collectionModel.create(newPayload.meta.collection);
  const collectionId = constructCollectionId(
    newPayload.meta.collection.name,
    newPayload.meta.collection.version
  );

  newPayload.meta.provider = fakeProviderFactory();
  await providerModel.create(newPayload.meta.provider);

  const granule = newPayload.meta.input_granules[0];
  granule.granuleId = randomString();

  const records = await indexer.granule(newPayload);


  const record = records[0];
  t.deepEqual(record.files, granule.files);
  t.is(record.status, 'running');
  t.is(record.collectionId, collectionId);
  t.is(record.granuleId, granule.granuleId);
  t.is(record.published, false);
});

test.serial('indexing a deletedgranule record', async (t) => {
  const granuletype = 'granule';
  const granule = fakeGranuleFactory();
  const collection = fakeCollectionFactory();
  const collectionId = constructCollectionId(collection.name, collection.version);
  granule.collectionId = collectionId;

  // create granule record
  let r = await indexer.indexGranule(esClient, granule, esIndex, granuletype);
  t.is(r.result, 'created');

  r = await indexer.deleteRecord(esClient, granule.granuleId, granuletype, collectionId, esIndex);
  t.is(r.result, 'deleted');

  // the deletedgranule record is added
  const deletedGranParams = {
    index: esIndex,
    type: 'deletedgranule',
    id: granule.granuleId,
    parent: collectionId
  };

  let record = await esClient.get(deletedGranParams);
  t.true(record.found);
  t.deepEqual(record._source.files, granule.files);
  t.is(record._parent, collectionId);
  t.is(record._id, granule.granuleId);
  t.truthy(record._source.deletedAt);

  // the deletedgranule record is removed if the granule is ingested again
  r = await indexer.indexGranule(esClient, granule, esIndex, granuletype);
  t.is(r.result, 'created');
  record = await esClient.get(Object.assign(deletedGranParams, { ignore: [404] }));
  t.false(record.found);
});

test.serial('creating multiple deletedgranule records and retrieving them', async (t) => {
  const granuleIds = [];
  const granules = [];

  for (let i = 0; i < 11; i += 1) {
    const newgran = fakeGranuleFactory();
    granules.push(newgran);
    granuleIds.push(newgran.granuleId);
  }

  const collectionId = granules[0].collectionId;

  // add the records
  let response = await Promise.all(granules.map((g) => indexer.indexGranule(esClient, g, esIndex)));
  t.is(response.length, 11);
  await esClient.indices.refresh();

  // now delete the records
  response = await Promise.all(granules
    .map((g) => indexer
      .deleteRecord(esClient, g.granuleId, 'granule', g.collectionId, esIndex)));

  t.is(response.length, 11);
  response.forEach((r) => t.is(r.result, 'deleted'));

  await esClient.indices.refresh();

  // retrieve deletedgranule records which are deleted within certain range
  // and are from a given collection
  const deletedGranParams = {
    index: esIndex,
    type: 'deletedgranule',
    body: {
      query: {
        bool: {
          must: [
            {
              range: {
                deletedAt: {
                  gte: 'now-1d',
                  lte: 'now+1s'
                }
              }
            },
            {
              parent_id: {
                type: 'deletedgranule',
                id: collectionId
              }
            }]
        }
      }
    }
  };

  response = await esClient.search(deletedGranParams);
  t.is(response.hits.total, 11);
  response.hits.hits.forEach((r) => {
    t.is(r._parent, collectionId);
    t.true(granuleIds.includes(r._source.granuleId));
  });
});

test.serial('indexing a rule record', async (t) => {
  const testRecord = {
    name: randomString()
  };

  const r = await indexer.indexRule(esClient, testRecord, esIndex);

  // make sure record is created
  t.is(r.result, 'created');

  // check the record exists
  const record = await esClient.get({
    index: esIndex,
    type: 'rule',
    id: testRecord.name
  });

  t.is(record._id, testRecord.name);
  t.is(typeof record._source.timestamp, 'number');
});

test.serial('indexing a provider record', async (t) => {
  const testRecord = {
    id: randomString()
  };

  const r = await indexer.indexProvider(esClient, testRecord, esIndex);

  // make sure record is created
  t.is(r.result, 'created');

  // check the record exists
  const record = await esClient.get({
    index: esIndex,
    type: 'provider',
    id: testRecord.id
  });

  t.is(record._id, testRecord.id);
  t.is(typeof record._source.timestamp, 'number');
});

test.serial('indexing a collection record', async (t) => {
  const collection = {
    name: randomString(),
    version: '001'
  };

  const collectionId = constructCollectionId(collection.name, collection.version);
  const r = await indexer.indexCollection(esClient, collection, esIndex);

  // make sure record is created
  t.is(r.result, 'created');

  // check the record exists
  const record = await esClient.get({
    index: esIndex,
    type: 'collection',
    id: collectionId
  });

  t.is(record._id, collectionId);
  t.is(record._source.name, collection.name);
  t.is(record._source.version, collection.version);
  t.is(typeof record._source.timestamp, 'number');
});

test.serial('indexing collection records with different versions', async (t) => {
  const name = randomString();
  /* eslint-disable no-await-in-loop */
  for (let i = 1; i < 11; i += 1) {
    const version = `00${i}`;
    const key = `key${i}`;
    const value = `value${i}`;
    const collection = {
      name: name,
      version: version,
      [`${key}`]: value
    };

    const r = await indexer.indexCollection(esClient, collection, esIndex);
    // make sure record is created
    t.is(r.result, 'created');
  }
  /* eslint-enable no-await-in-loop */

  await esClient.indices.refresh();
  // check each record exists and is not affected by other collections
  for (let i = 1; i < 11; i += 1) {
    const version = `00${i}`;
    const key = `key${i}`;
    const value = `value${i}`;
    const collectionId = indexer.constructCollectionId(name, version);
    const record = await esClient.get({ // eslint-disable-line no-await-in-loop
      index: esIndex,
      type: 'collection',
      id: collectionId
    });

    t.is(record._id, collectionId);
    t.is(record._source.name, name);
    t.is(record._source.version, version);
    t.is(record._source[key], value);
    t.is(typeof record._source.timestamp, 'number');
  }
});

test.serial('updating a collection record', async (t) => {
  const collection = {
    name: randomString(),
    version: '001',
    anyObject: {
      key: 'value',
      key1: 'value1',
      key2: 'value2'
    },
    anyKey: 'anyValue'
  };

  // updatedCollection has some parameters removed
  const updatedCollection = {
    name: collection.name,
    version: '001',
    anyparams: {
      key1: 'value1'
    }
  };

  const collectionId = indexer.constructCollectionId(collection.name, collection.version);
  let r = await indexer.indexCollection(esClient, collection, esIndex);

  // make sure record is created
  t.is(r.result, 'created');

  // update the collection record
  r = await indexer.indexCollection(esClient, updatedCollection, esIndex);
  t.is(r.result, 'updated');

  // check the record exists
  const record = await esClient.get({
    index: esIndex,
    type: 'collection',
    id: collectionId
  });

  t.is(record._id, collectionId);
  t.is(record._source.name, updatedCollection.name);
  t.is(record._source.version, updatedCollection.version);
  t.deepEqual(record._source.anyparams, updatedCollection.anyparams);
  t.is(record._source.anyKey, undefined);
  t.is(typeof record._source.timestamp, 'number');
});

test.serial('creating a failed pdr record', async (t) => {
  const payload = pdrFailure.payload;
  payload.pdr.name = randomString();

  pdrFailure.meta.collection = fakeCollectionFactory();
  await collectionModel.create(pdrFailure.meta.collection);
  const collectionId = constructCollectionId(
    pdrFailure.meta.collection.name,
    pdrFailure.meta.collection.version
  );

  pdrFailure.meta.provider = fakeProviderFactory();
  await providerModel.create(pdrFailure.meta.provider);

  const record = await indexer.pdr(pdrFailure);

  t.is(record.status, 'failed');
  t.is(record.collectionId, collectionId);
  t.is(record.pdrName, payload.pdr.name);

  // check stats
  const stats = record.stats;
  t.is(stats.total, 1);
  t.is(stats.failed, 1);
  t.is(stats.processing, 0);
  t.is(stats.completed, 0);
  t.is(record.progress, 100);
});

test.serial('creating a successful pdr record', async (t) => {
  pdrSuccess.meta.pdr.name = randomString();
  const pdr = pdrSuccess.meta.pdr;

  pdrSuccess.meta.collection = fakeCollectionFactory();
  await collectionModel.create(pdrSuccess.meta.collection);
  const collectionId = constructCollectionId(
    pdrSuccess.meta.collection.name,
    pdrSuccess.meta.collection.version
  );

  pdrSuccess.meta.provider = fakeProviderFactory();
  await providerModel.create(pdrSuccess.meta.provider);

  const record = await indexer.pdr(pdrSuccess);

  t.is(record.status, 'completed');
  t.is(record.collectionId, collectionId);
  t.is(record.pdrName, pdr.name);

  // check stats
  const stats = record.stats;
  t.is(stats.total, 3);
  t.is(stats.failed, 1);
  t.is(stats.processing, 0);
  t.is(stats.completed, 2);
  t.is(record.progress, 100);
});

test.serial('creating a running pdr record', async (t) => {
  const newPayload = clone(pdrSuccess);
  newPayload.meta.pdr.name = randomString();
  newPayload.meta.status = 'running';
  newPayload.payload.running.push('arn');

  newPayload.meta.collection = fakeCollectionFactory();
  await collectionModel.create(newPayload.meta.collection);

  newPayload.meta.provider = fakeProviderFactory();
  await providerModel.create(newPayload.meta.provider);

  const record = await indexer.pdr(newPayload);

  t.is(record.status, 'running');

  // check stats
  const stats = record.stats;
  t.is(stats.total, 4);
  t.is(stats.failed, 1);
  t.is(stats.processing, 1);
  t.is(stats.completed, 2);
  t.is(record.progress, 75);
});

test.serial('indexing a running pdr when pdr is missing', async (t) => {
  delete pdrSuccess.meta.pdr;
  const r = await indexer.pdr(pdrSuccess);

  // make sure record is created
  t.is(r, undefined);
});

test.serial('creating a step function with missing arn', async (t) => {
  const newPayload = clone(granuleSuccess);
  delete newPayload.cumulus_meta.state_machine;

  const e = new models.Execution();
  const promise = e.createExecutionFromSns(newPayload);
  const error = await t.throws(promise);
  t.is(error.message, 'State Machine Arn is missing. Must be included in the cumulus_meta');
});

test.serial('creating a successful step function', async (t) => {
  const newPayload = clone(pdrSuccess);
  newPayload.cumulus_meta.execution_name = randomString();

  const e = new models.Execution();
  const record = await e.createExecutionFromSns(newPayload);

  t.is(record.status, 'completed');
  t.is(record.type, newPayload.meta.workflow_name);
  t.is(record.createdAt, newPayload.cumulus_meta.workflow_start_time);
});

test.serial('creaging a failed step function', async (t) => {
  const newPayload = clone(pdrFailure);
  newPayload.cumulus_meta.execution_name = randomString();

  const e = new models.Execution();
  const record = await e.createExecutionFromSns(newPayload);

  t.is(record.status, 'failed');
  t.is(record.type, newPayload.meta.workflow_name);
  t.is(typeof record.error, 'object');
  t.is(record.createdAt, newPayload.cumulus_meta.workflow_start_time);
});

test.serial('partially updating a provider record', async (t) => {
  const testRecord = {
    id: randomString()
  };
  const type = 'provider';

  let r = await indexer.indexProvider(esClient, testRecord, esIndex, type);

  // make sure record is created
  t.is(r.result, 'created');
  t.is(r._id, testRecord.id);

  // now partially update it
  const updatedRecord = {
    host: 'example.com'
  };
  r = await indexer.partialRecordUpdate(
    esClient,
    testRecord.id,
    type,
    updatedRecord,
    undefined,
    esIndex
  );

  t.is(r.result, 'updated');
  // check the record exists
  const record = await esClient.get({
    index: esIndex,
    type,
    id: testRecord.id
  });

  t.is(record._id, testRecord.id);
  t.is(record._source.host, updatedRecord.host);
});

test.serial('delete a provider record', async (t) => {
  const testRecord = {
    id: randomString()
  };
  const type = 'provider';

  let r = await indexer.indexProvider(esClient, testRecord, esIndex, type);

  // make sure record is created
  t.is(r.result, 'created');
  t.is(r._id, testRecord.id);

  r = await indexer.deleteRecord(
    esClient,
    testRecord.id,
    type,
    undefined,
    esIndex
  );

  t.is(r.result, 'deleted');

  // check the record exists
  const promise = esClient.get({
    index: esIndex,
    type,
    id: testRecord.id
  });
  const error = await t.throws(promise);
  t.is(error.message, 'Not Found');
});

// This needs to be serial because it is stubbing aws.sfn's responses
test.serial('reingest a granule', async (t) => {
  const input = JSON.stringify(granuleSuccess);

  const payload = JSON.parse(input);
  const key = `${process.env.stackName}/workflows/${payload.meta.workflow_name}.json`;
  await aws.s3().putObject({ Bucket: process.env.bucket, Key: key, Body: 'test data' }).promise();

  payload.payload.granules[0].granuleId = randomString();

  payload.meta.collection = fakeCollectionFactory();
  await collectionModel.create(payload.meta.collection);

  payload.meta.provider = fakeProviderFactory();
  await providerModel.create(payload.meta.provider);

  const records = await indexer.granule(payload);
  const record = records[0];

  t.is(record.status, 'completed');

  const sfn = aws.sfn();

  try {
    sfn.describeExecution = () => ({
      promise: () => Promise.resolve({ input })
    });

    await indexer.reingest(record);
  }
  finally {
    delete sfn.describeExecution;
  }

  const g = new models.Granule();
  const newRecord = await g.get({ granuleId: record.granuleId });

  t.is(newRecord.status, 'running');
});

test.serial('pass a sns message to main handler', async (t) => {
  let txt = fs.readFileSync(path.join(
    __dirname,
    '../../data/sns_message_granule.txt'
  ), 'utf8');
  txt = txt.replace('{{random_string}}', randomString());

  const event = JSON.parse(JSON.parse(txt.toString()));

  const message = JSON.parse(event.Records[0].Sns.Message);

  message.payload.granules[0].granuleId = randomString();

  message.meta.collection = fakeCollectionFactory();
  await collectionModel.create(message.meta.collection);

  message.meta.provider = fakeProviderFactory();
  await providerModel.create(message.meta.provider);

  event.Records[0].Sns.Message = JSON.stringify(message);

  const resp = await indexer.handler(event, {}, noop);

  t.is(resp.length, 1);
  t.truthy(resp[0].sf);
  t.truthy(resp[0].granule);
  t.falsy(resp[0].pdr);

  // fake granule index to elasticsearch (this is done in a lambda function)

  await indexer.indexGranule(esClient, resp[0].granule[0]);

  const msg = JSON.parse(event.Records[0].Sns.Message);
  const granule = msg.payload.granules[0];
  const collection = msg.meta.collection;
  const collectionId = constructCollectionId(collection.name, collection.version);
  // test granule record is added
  const record = await esClient.get({
    index: esIndex,
    type: 'granule',
    id: granule.granuleId,
    parent: collectionId
  });
  t.is(record._id, granule.granuleId);
});

test.serial('pass a sns message to main handler with parse info', async (t) => {
  let txt = fs.readFileSync(path.join(
    __dirname,
    '../../data/sns_message_parse_pdr.txt'
  ), 'utf8');

  txt = txt.replace('{{random_string}}', randomString());

  const event = JSON.parse(JSON.parse(txt.toString()));

  const message = JSON.parse(event.Records[0].Sns.Message);

  message.meta.collection = fakeCollectionFactory();
  await collectionModel.create(message.meta.collection);

  message.meta.provider = fakeProviderFactory();
  await providerModel.create(message.meta.provider);

  event.Records[0].Sns.Message = JSON.stringify(message);

  const resp = await indexer.handler(event, {}, noop);

  t.is(resp.length, 1);
  t.truthy(resp[0].sf);
  t.falsy(resp[0].granule);
  t.truthy(resp[0].pdr);

  // fake pdr index to elasticsearch (this is done in a lambda function)
  await indexer.indexPdr(esClient, resp[0].pdr);

  const msg = JSON.parse(event.Records[0].Sns.Message);
  const pdr = msg.payload.pdr;
  // test granule record is added
  const record = await esClient.get({
    index: esIndex,
    type: 'pdr',
    id: pdr.name
  });
  t.is(record._id, pdr.name);
  t.falsy(record._source.error);
});

test.serial('pass a sns message to main handler with discoverpdr info', async (t) => {
  let txt = fs.readFileSync(path.join(
    __dirname, '../../data/sns_message_discover_pdr.txt'
  ), 'utf8');

  txt = txt.replace('{{random_string}}', randomString());

  const event = JSON.parse(JSON.parse(txt.toString()));
  const resp = await indexer.handler(event, {}, noop);

  t.is(resp.length, 1);
  t.truthy(resp[0].sf);
  t.falsy(resp[0].granule);
  t.falsy(resp[0].pdr);
});
