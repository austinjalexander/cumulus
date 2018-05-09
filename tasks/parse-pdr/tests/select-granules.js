'use strict';

const test = require('ava');
const parsePdr = require('@cumulus/ingest/parse-pdr');

test('parse MODAPS PDR', async (t) => {
  const pdrFilePath = './tests/fixtures/MODAPSops7.1234567.PDR'
  const pdrName = 'MODAPSops7.1234567.PDR';

  class CollectionConfigStore {
    async get() {
      return '*';
    }
  }
  const collectionConfigStore = new CollectionConfigStore()

  // Note: This PDR contains a different type of checksum
  const parsed = await parsePdr.parsePdr(pdrFilePath, collectionConfigStore, pdrName);
  t.is(parsed.filesCount, 30);
  t.is(parsed.granulesCount, 30);
  t.is(parsed.granules.length, 30);
});