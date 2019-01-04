'use strict';

const test = require('ava');
const aws = require('@cumulus/common/aws');
const { randomString } = require('@cumulus/common/test-utils');
const models = require('../../../models');
const bootstrap = require('../../../lambdas/bootstrap');
const pdrEndpoint = require('../../../endpoints/pdrs');
const indexer = require('../../../es/indexer');
const {
  createFakeJwtAuthToken,
  fakeCollectionFactory,
  fakePdrFactoryV2,
  fakeProviderFactory,
  testEndpoint
} = require('../../../lib/testUtils');
const { Search } = require('../../../es/search');
const assertions = require('../../../lib/assertions');

const pdrS3Key = (stackName, bucket, pdrName) => `${process.env.stackName}/pdrs/${pdrName}`;

function uploadPdrToS3(stackName, bucket, pdrName, pdrBody) {
  const key = pdrS3Key(stackName, bucket, pdrName);

  return aws.s3().putObject({
    Bucket: bucket,
    Key: key,
    Body: pdrBody
  }).promise();
}

// create all the variables needed across this test
let esClient;
let fakePdrs;
const esIndex = randomString();
process.env.AccessTokensTable = randomString();
process.env.PdrsTable = randomString();
process.env.UsersTable = randomString();
process.env.stackName = randomString();
process.env.internal = randomString();
process.env.TOKEN_SECRET = randomString();

let accessTokenModel;
let authHeaders;
let collectionId;
let collectionModel;
let pdrModel;
let provider;
let providerModel;
let userModel;

test.before(async () => {
  // create esClient
  esClient = await Search.es('fakehost');

  // add fake elasticsearch index
  await bootstrap.bootstrapElasticSearch('fakehost', esIndex);

  // create a fake bucket
  await aws.s3().createBucket({ Bucket: process.env.internal }).promise();

  collectionModel = new models.Collection();
  providerModel = new models.Provider();

  pdrModel = new models.Pdr();

  userModel = new models.User();
  await userModel.createTable();

  accessTokenModel = new models.AccessToken();
  await accessTokenModel.createTable();

  const jwtAuthToken = await createFakeJwtAuthToken({ accessTokenModel, userModel });
  authHeaders = {
    Authorization: `Bearer ${jwtAuthToken}`
  };

  const collection = fakeCollectionFactory();
  await collectionModel.create(collection);

  provider = fakeProviderFactory();
  await providerModel.create(provider);

  // create fake granule records
  collectionId = `${collection.name}___${collection.version}`;
  fakePdrs = ['completed', 'failed'].map((status) =>
    fakePdrFactoryV2({
      collectionId,
      status,
      provider: provider.id
    }));

  await Promise.all(
    fakePdrs.map(
      (pdr) => pdrModel.create(pdr)
        .then((record) => indexer.indexPdr(esClient, record, esIndex))
    )
  );
});

test.after.always(async () => {
  await accessTokenModel.deleteTable();
  await pdrModel.deleteTable();
  await userModel.deleteTable();
  await esClient.indices.delete({ index: esIndex });
  await aws.recursivelyDeleteS3Bucket(process.env.internal);
});

test('CUMULUS-911 GET without pathParameters and without an Authorization header returns an Authorization Missing response', async (t) => {
  const request = {
    httpMethod: 'GET',
    headers: {}
  };

  return testEndpoint(pdrEndpoint, request, (response) => {
    assertions.isAuthorizationMissingResponse(t, response);
  });
});

test('CUMULUS-911 GET with pathParameters and without an Authorization header returns an Authorization Missing response', async (t) => {
  const request = {
    httpMethod: 'GET',
    pathParameters: {
      pdrName: 'asdf'
    },
    headers: {}
  };

  return testEndpoint(pdrEndpoint, request, (response) => {
    assertions.isAuthorizationMissingResponse(t, response);
  });
});

test('CUMULUS-911 DELETE with pathParameters and without an Authorization header returns an Authorization Missing response', async (t) => {
  const request = {
    httpMethod: 'DELETE',
    pathParameters: {
      pdrName: 'asdf'
    },
    headers: {}
  };

  return testEndpoint(pdrEndpoint, request, (response) => {
    assertions.isAuthorizationMissingResponse(t, response);
  });
});

test('CUMULUS-912 GET without pathParameters and with an invalid access token returns an unauthorized response', async (t) => {
  const request = {
    httpMethod: 'GET',
    headers: {
      Authorization: 'Bearer ThisIsAnInvalidAuthorizationToken'
    }
  };

  return testEndpoint(pdrEndpoint, request, (response) => {
    assertions.isInvalidAccessTokenResponse(t, response);
  });
});

test('CUMULUS-912 GET with pathParameters and with an invalid access token returns an unauthorized response', async (t) => {
  const request = {
    httpMethod: 'GET',
    pathParameters: {
      pdrName: 'asdf'
    },
    headers: {
      Authorization: 'Bearer ThisIsAnInvalidAuthorizationToken'
    }
  };

  return testEndpoint(pdrEndpoint, request, (response) => {
    assertions.isInvalidAccessTokenResponse(t, response);
  });
});

test.todo('CUMULUS-912 GET with an unauthorized user returns an unauthorized response');

test('CUMULUS-912 DELETE with pathParameters and with an invalid access token returns an unauthorized response', async (t) => {
  const request = {
    httpMethod: 'DELETE',
    pathParameters: {
      pdrName: 'asdf'
    },
    headers: {
      Authorization: 'Bearer ThisIsAnInvalidAuthorizationToken'
    }
  };

  return testEndpoint(pdrEndpoint, request, (response) => {
    assertions.isInvalidAccessTokenResponse(t, response);
  });
});

test.todo('CUMULUS-912 DELETE with pathParameters and with an unauthorized user returns an unauthorized response');

test('default returns list of pdrs', (t) => {
  const listEvent = {
    httpMethod: 'list',
    headers: authHeaders
  };

  return testEndpoint(pdrEndpoint, listEvent, (response) => {
    const { meta, results } = JSON.parse(response.body);
    t.is(results.length, 2);
    t.is(meta.stack, process.env.stackName);
    t.is(meta.table, 'pdr');
    t.is(meta.count, 2);
    const pdrNames = fakePdrs.map((i) => i.pdrName);
    results.forEach((r) => {
      t.true(pdrNames.includes(r.pdrName));
    });
  });
});

test('GET returns an existing pdr', (t) => {
  const getEvent = {
    httpMethod: 'GET',
    pathParameters: {
      pdrName: fakePdrs[0].pdrName
    },
    headers: authHeaders
  };

  return testEndpoint(pdrEndpoint, getEvent, (response) => {
    const { pdrName } = JSON.parse(response.body);
    t.is(pdrName, fakePdrs[0].pdrName);
  });
});

test('GET fails if pdr is not found', async (t) => {
  const event = {
    httpMethod: 'GET',
    pathParameters: {
      pdrName: 'unknownPdr'
    },
    headers: authHeaders
  };

  const response = await testEndpoint(pdrEndpoint, event, (r) => r);
  t.is(response.statusCode, 400);
  const { message } = JSON.parse(response.body);
  t.true(message.includes('No record found'));
});

test('DELETE a pdr', async (t) => {
  const newPdr = fakePdrFactoryV2({
    collectionId,
    provider: provider.id,
    status: 'completed'
  });
  // create a new pdr
  await pdrModel.create(newPdr);

  const deleteEvent = {
    httpMethod: 'DELETE',
    pathParameters: {
      pdrName: newPdr.pdrName
    },
    headers: authHeaders
  };

  const key = `${process.env.stackName}/pdrs/${newPdr.pdrName}`;
  await aws.s3().putObject({ Bucket: process.env.internal, Key: key, Body: 'test data' }).promise();

  const response = await testEndpoint(pdrEndpoint, deleteEvent, (r) => r);
  t.is(response.statusCode, 200);
  const { detail } = JSON.parse(response.body);
  t.is(
    detail,
    'Record deleted'
  );
});

test('DELETE handles the case where the PDR exists in S3 but not in DynamoDb', async (t) => {
  const pdrName = `${randomString()}.PDR`;

  await uploadPdrToS3(
    process.env.stackName,
    process.env.internal,
    pdrName,
    'This is the PDR body'
  );

  const event = {
    httpMethod: 'DELETE',
    pathParameters: {
      pdrName
    },
    headers: authHeaders
  };

  const response = await testEndpoint(pdrEndpoint, event, (r) => r);

  t.is(response.statusCode, 200);

  const parsedBody = JSON.parse(response.body);
  t.is(parsedBody.detail, 'Record deleted');
});

test('DELETE handles the case where the PDR exists in DynamoDb but not in S3', async (t) => {
  const newPdr = fakePdrFactoryV2({
    collectionId,
    provider: provider.id,
    status: 'completed'
  });
  await pdrModel.create(newPdr);

  const event = {
    httpMethod: 'DELETE',
    pathParameters: {
      pdrName: newPdr.pdrName
    },
    headers: authHeaders
  };

  const response = await testEndpoint(pdrEndpoint, event, (r) => r);

  t.is(response.statusCode, 200);

  const parsedBody = JSON.parse(response.body);
  t.is(parsedBody.detail, 'Record deleted');
});
