'use strict';

const cloneDeep = require('lodash.clonedeep');
const pickBy = require('lodash.pickby');
const { DefaultProvider: S3KeyPairProvider } = require('@cumulus/common/key-pair-provider');
const { isNotNull } = require('@cumulus/common/util');

const knex = require('../db/knex');
const Model = require('./Model');
const providersGateway = require('../db/providers-gateway');
const rulesGateway = require('../db/rules-gateway');

const { AssociatedRulesError } = require('../lib/errors');
const { RecordDoesNotExist } = require('../lib/errors');

function buildRecord(model) {
  const record = { ...model };

  if (model.record) {
    record.meta = JSON.stringify(model.record);
  }

  return record;
}

const privates = new WeakMap();

class Provider extends Model {
  constructor() {
    super();

    privates.set(this, { db: knex() });
  }

  /**
   * Returns row matching id
   *
   * @param {string} item Provider item
   * @returns {Object} provider object
   */
  async get({ id }) {
    const { db } = privates.get(this);

    const record = await providersGateway.findById(db, id);

    return pickBy(record, isNotNull);
  }

  /**
   * Check if a given provider exists
   *
   * @param {string} id - provider id
   * @returns {boolean}
   */
  async exists(id) {
    const { db } = privates.get(this);

    try {
      await providersGateway.findById(db, id);

      return true;
    }
    catch (err) {
      if (err instanceof RecordDoesNotExist) return false;

      throw err;
    }
  }

  /**
   * Insert new row into database.  Alias for 'insert' function.
   *
   * @param {Object} item provider 'object' representing a row to create
   * @returns {Object} the the full item added with modifications made by the model
   */
  async create(item) {
    const { db } = privates.get(this);

    const encryptedModel = await this.encryptItem(item);

    const providerRecord = buildRecord(encryptedModel);

    await providersGateway.insert(db, providerRecord);

    return this.get({ id: item.id });
  }

  /**
   * Updates a provider
   *
   * @param { Object } keyObject { id: key } object
   * @param { Object } item an object with key/value pairs to update
   * @param { Array<string> } [keysToDelete=[]] array of keys to set to null.
   * @returns { string } id updated Provider id
   **/
  async update(keyObject, item, keysToDelete = []) {
    const { db } = privates.get(this);

    const deletions = {};
    keysToDelete.forEach((f) => {
      deletions[f] = null;
    });

    const updatedModel = {
      ...item,
      ...deletions,
      id: undefined
    };

    const encryptedModel = await this.encryptItem(updatedModel);

    const updates = buildRecord(encryptedModel);

    await providersGateway.update(db, keyObject.id, updates);

    return this.get({ id: keyObject.id });
  }

  /**
   * Delete a provider
   *
   * @param { Object } item  Provider item to delete, uses ID field to identify row to remove.
   */
  async delete({ id }) {
    const { db } = privates.get(this);

    const rules = await rulesGateway.findByProviderId(db, id);

    if (rules.length > 0) {
      throw new AssociatedRulesError(
        'Cannot delete a provider that has associated rules',
        rules.map((r) => r.name)
      );
    }

    await providersGateway.delete(db, id);
  }

  encrypt(value) {
    return S3KeyPairProvider.encrypt(value);
  }

  decrypt(value) {
    return S3KeyPairProvider.decrypt(value);
  }

  async encryptItem(item) {
    const encryptedItem = cloneDeep(item);

    if (encryptedItem.password) {
      encryptedItem.password = await this.encrypt(encryptedItem.password);
      encryptedItem.encrypted = true;
    }

    if (encryptedItem.username) {
      encryptedItem.username = await this.encrypt(encryptedItem.username);
      encryptedItem.encrypted = true;
    }

    return encryptedItem;
  }
}
module.exports = Provider;
