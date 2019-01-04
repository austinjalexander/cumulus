'use strict';

const test = require('ava');
const { randomString } = require('@cumulus/common/test-utils');
const {
  fakeAccessTokenFactory,
  fakeUserFactory
} = require('../../lib/testUtils');
const { RecordDoesNotExist } = require('../../lib/errors');
const { AccessToken } = require('../../models');

let accessTokenModel;
test.before(async () => {
  process.env.AccessTokensTable = randomString();

  accessTokenModel = new AccessToken();

  await accessTokenModel.createTable();
});

test.after.always(async () => {
  await accessTokenModel.deleteTable();
});

test('create() creates a valid access token record', async (t) => {
  const userRecord = fakeUserFactory();
  const accessTokenData = fakeAccessTokenFactory({ username: userRecord.userName });
  const accessTokenRecord = await accessTokenModel.create(accessTokenData);

  t.is(accessTokenRecord.accessToken, accessTokenData.accessToken);
  t.is(accessTokenRecord.refreshToken, accessTokenData.refreshToken);
  t.is(accessTokenRecord.username, userRecord.userName);
  t.truthy(accessTokenRecord.expirationTime);
});

test('create() creates a valid access token record without username or expiration', async (t) => {
  const { accessToken, refreshToken } = fakeAccessTokenFactory();
  const accessTokenRecord = await accessTokenModel.create({ accessToken, refreshToken });

  t.is(accessTokenRecord.accessToken, accessToken);
  t.is(accessTokenRecord.refreshToken, refreshToken);
  t.is(accessTokenRecord.username, undefined);
  t.is(accessTokenRecord.expirationTime, undefined);
});

test('get() throws error for missing record', async (t) => {
  try {
    await accessTokenModel.get({ accessToken: randomString() });
    t.fail('expected code to throw error');
  }
  catch (err) {
    t.true(err instanceof RecordDoesNotExist);
  }
});
