'use strict';

const get = require('lodash.get');
const { invoke, Events } = require('@cumulus/ingest/aws');
const aws = require('@cumulus/common/aws');

const Model = require('./Model');
const knex = require('../db/knex');

const collectionsGateway = require('../db/collections-gateway');
const rulesGateway = require('../db/rules-gateway');
const tagsGateway = require('../db/tags-gateway');

const { RecordDoesNotExist } = require('../lib/errors');

function ruleModelToRecord(ruleModel, collectionId) {
  const ruleRecord = {
    name: ruleModel.name,
    state: ruleModel.state,
    workflow: ruleModel.workflow,
    created_at: ruleModel.createdAt,
    updated_at: ruleModel.updatedAt,
    collection_id: collectionId,
    provider_id: ruleModel.provider
  };

  if (ruleModel.rule) {
    ruleRecord.rule_arn = ruleModel.rule.arn;
    ruleRecord.rule_log_event_arn = ruleModel.rule.logEventArn;
    ruleRecord.rule_type = ruleModel.rule.type;
    ruleRecord.rule_value = ruleModel.rule.value;
  }

  if (ruleModel.meta) ruleRecord.meta = JSON.stringify(ruleModel.meta);

  return ruleRecord;
}

function buildRuleModel(ruleRecord, collectionRecord) {
  const ruleModel = {
    name: ruleRecord.name,
    rule: {
      type: ruleRecord.rule_type
    },
    state: ruleRecord.state,
    workflow: ruleRecord.workflow,
    createdAt: ruleRecord.created_at,
    updatedAt: ruleRecord.updated_at,
    collection: {
      name: collectionRecord.name,
      version: collectionRecord.version
    },
    provider: ruleRecord.provider_id
  };

  if (ruleRecord.rule_arn) {
    ruleModel.rule.arn = ruleRecord.rule_arn;
  }
  if (ruleRecord.rule_log_event_arn) {
    ruleModel.rule.logEventArn = ruleRecord.rule_log_event_arn;
  }
  if (ruleRecord.rule_value) {
    ruleModel.rule.value = ruleRecord.rule_value;
  }

  if (ruleRecord.meta) {
    ruleModel.meta = JSON.parse(ruleRecord.meta);
  }

  return ruleModel;
}

async function insertRuleModel(db, ruleModel) {
  const collectionRecord = await collectionsGateway.findByNameAndVersion(
    db,
    ruleModel.collection.name,
    ruleModel.collection.version
  );

  if (!collectionRecord) {
    throw new Error(`Unable to create rule, collection ${ruleModel.collection.name} ${ruleModel.collection.version} does not exist`);
  }

  return db.transaction(async (trx) => {
    const ruleRecord = ruleModelToRecord(ruleModel, collectionRecord.id);

    const ruleId = await rulesGateway.insert(trx, ruleRecord);

    await tagsGateway.setRuleTags(db, ruleId, ruleModel.tags);

    return ruleId;
  });
}

function updateRuleModel(db, ruleModel) {
  return db.transaction(async (trx) => {
    const { id: ruleId } = await rulesGateway.findByName(db, ruleModel.name);

    await tagsGateway.setRuleTags(trx, ruleId, ruleModel.tags);

    const updates = ruleModelToRecord(ruleModel);
    await rulesGateway.update(trx, ruleId, updates);
  });
}

const privates = new WeakMap();

class Rule extends Model {
  constructor() {
    super();

    privates.set(this, { db: knex() });

    this.eventMapping = { arn: 'arn', logEventArn: 'logEventArn' };
    this.kinesisSourceEvents = [{ name: process.env.messageConsumer, eventType: 'arn' },
      { name: process.env.KinesisInboundEventLogger, eventType: 'logEventArn' }];
    this.targetId = 'lambdaTarget';
  }

  async addRule(item, payload) {
    const name = `${process.env.stackName}-custom-${item.name}`;
    const r = await Events.putEvent(
      name,
      item.rule.value,
      item.state,
      'Rule created by cumulus-api'
    );

    await Events.putTarget(name, this.targetId, process.env.invokeArn, JSON.stringify(payload));
    return r.RuleArn;
  }

  async get({ name }) {
    const { db } = privates.get(this);

    const ruleRecord = await rulesGateway.findByName(db, name);

    const collectionRecord = await collectionsGateway.findById(db, ruleRecord.collection_id);

    return buildRuleModel(ruleRecord, collectionRecord);
  }

  async getAll() {
    // TODO This is poorly written and should be refactored

    const { db } = privates.get(this);

    const ruleRecords = await rulesGateway.find(db);

    const results = [];

    for (let ctr = 0; ctr < ruleRecords.length; ctr += 1) {
      const ruleRecord = ruleRecords[ctr];

      // eslint-disable-next-line no-await-in-loop
      const collectionRecord = await collectionsGateway.findById(
        db,
        ruleRecord.collection_id
      );
      results.push(buildRuleModel(ruleRecord, collectionRecord));
    }

    return results;
  }

  async exists({ name }) {
    const { db } = privates.get(this);

    const ruleRecord = await rulesGateway.findByName(db, name);

    return ruleRecord !== undefined;
  }

  async create(item) {
    const { db } = privates.get(this);

    // make sure the name only has word characters
    const re = /[^\w]/;
    if (re.test(item.name)) {
      throw new Error('Names may only contain letters, numbers, and underscores.');
    }

    // the default state is 'ENABLED'
    if (!item.state) item.state = 'ENABLED'; // eslint-disable-line no-param-reassign

    const payload = await Rule.buildPayload(item);
    switch (item.rule.type) {
    case 'onetime': {
      await invoke(process.env.invoke, payload);
      break;
    }
    case 'scheduled': {
      await this.addRule(item, payload);
      break;
    }
    case 'kinesis': {
      await this.addKinesisEventSources(item);
      break;
    }
    case 'sns': {
      if (item.state === 'ENABLED') {
        await this.addSnsTrigger(item);
      }
      break;
    }
    default:
      throw new Error('Type not supported');
    }

    await insertRuleModel(db, item);

    return this.get({ name: item.name });
  }

  /**
   * update a rule item
   *
   * @param {*} original - the original rule
   * @param {*} updated - key/value fields for update, may not be a complete rule item
   * @returns {Promise} the response from database updates
   */
  async update(original, updated) {
    const { db } = privates.get(this);

    let stateChanged = false;
    if (updated.state && updated.state !== original.state) {
      original.state = updated.state; // eslint-disable-line no-param-reassign
      stateChanged = true;
    }

    let valueUpdated = false;
    if (updated.rule && updated.rule.value) {
      original.rule.value = updated.rule.value; // eslint-disable-line no-param-reassign
      if (updated.rule.type === undefined) updated.rule.type = original.rule.type; // eslint-disable-line no-param-reassign, max-len
      valueUpdated = true;
    }

    switch (original.rule.type) {
    case 'scheduled': {
      const payload = await Rule.buildPayload(original);
      await this.addRule(original, payload);
      break;
    }
    case 'kinesis':
      if (valueUpdated) {
        await this.deleteKinesisEventSources(original);
        await this.addKinesisEventSources(original);
        updated.rule.arn = original.rule.arn; // eslint-disable-line no-param-reassign
      }
      else {
        await this.updateKinesisEventSources(original);
      }
      break;
    case 'sns': {
      if (valueUpdated || stateChanged) {
        if (original.rule.arn) {
          await this.deleteSnsTrigger(original);
          if (!updated.rule) updated.rule = original.rule; // eslint-disable-line no-param-reassign
          delete updated.rule.arn; // eslint-disable-line no-param-reassign
        }
        if (original.state === 'ENABLED') {
          await this.addSnsTrigger(original);
          if (!updated.rule) updated.rule = original.rule; // eslint-disable-line no-param-reassign
          else updated.rule.arn = original.rule.arn; // eslint-disable-line no-param-reassign
        }
      }
      break;
    }
    default:
      break;
    }

    const updatedModel = {
      ...updated,
      name: original.name
    };

    await updateRuleModel(db, updatedModel);

    return this.get({ name: original.name });
  }

  async delete(item) {
    const { db } = privates.get(this);

    switch (item.rule.type) {
    case 'scheduled': {
      const name = `${process.env.stackName}-custom-${item.name}`;
      await Events.deleteTarget(this.targetId, name);
      await Events.deleteEvent(name);
      break;
    }
    case 'kinesis': {
      await this.deleteKinesisEventSources(item);
      break;
    }
    case 'sns': {
      if (item.state === 'ENABLED') {
        await this.deleteSnsTrigger(item);
      }
      break;
    }
    default:
      break;
    }

    const ruleRecord = await rulesGateway.findByName(db, item.name);
    await rulesGateway.delete(db, ruleRecord.id);
  }

  static async buildPayload(item) {
    // makes sure the workflow exists
    const bucket = process.env.bucket;
    const key = `${process.env.stackName}/workflows/${item.workflow}.json`;
    const exists = await aws.fileExists(bucket, key);

    if (!exists) throw new Error(`Workflow doesn\'t exist: s3://${bucket}/${key} for ${item.name}`);

    const template = `s3://${bucket}/${key}`;
    return {
      template,
      provider: item.provider,
      collection: item.collection,
      meta: get(item, 'meta', {}),
      cumulus_meta: get(item, 'cumulus_meta', {}),
      payload: get(item, 'payload', {})
    };
  }

  static async invoke(item) {
    const payload = await Rule.buildPayload(item);
    await invoke(process.env.invoke, payload);
  }

  /**
   * Add  event sources for all mappings in the kinesisSourceEvents
   * @param {Object} item - the rule item
   * @returns {Object} return updated rule item containing new arn/logEventArn
   */
  async addKinesisEventSources(item) {
    const sourceEventPromises = this.kinesisSourceEvents.map(
      (lambda) => this.addKinesisEventSource(item, lambda)
    );
    const eventAdd = await Promise.all(sourceEventPromises);
    item.rule.arn = eventAdd[0].UUID; // eslint-disable-line no-param-reassign
    item.rule.logEventArn = eventAdd[1].UUID; // eslint-disable-line no-param-reassign
    return item;
  }

  /**
   * add an event source to a target lambda function
   *
   * @param {Object} item - the rule item
   * @param {string} lambda - the name of the target lambda
   * @returns {Promise} a promise
   * @returns {Promise} updated rule item
   */
  async addKinesisEventSource(item, lambda) {
    // use the existing event source mapping if it already exists and is enabled
    const listParams = { FunctionName: lambda.name };
    const listData = await aws.lambda(listParams).listEventSourceMappings().promise();
    if (listData.EventSourceMappings && listData.EventSourceMappings.length > 0) {
      const mappingExists = listData.EventSourceMappings
        .find((mapping) => { // eslint-disable-line arrow-body-style
          return (mapping.EventSourceArn === item.rule.value
                  && mapping.FunctionArn.includes(lambda.name));
        });
      if (mappingExists) {
        if (mappingExists.State === 'Enabled') {
          return mappingExists;
        }
        await this.deleteKinesisEventSource({
          name: item.name,
          rule: {
            arn: mappingExists.UUID,
            type: item.rule.type
          }
        }, lambda.type);
      }
    }

    // create event source mapping
    const params = {
      EventSourceArn: item.rule.value,
      FunctionName: lambda.name,
      StartingPosition: 'TRIM_HORIZON',
      Enabled: item.state === 'ENABLED'
    };

    return aws.lambda().createEventSourceMapping(params).promise();
  }

  /**
   * Update event sources for all mappings in the kinesisSourceEvents
   * @param {*} item - the rule item
   * @returns {Promise<Array>} array of responses from the event source update
   */
  async updateKinesisEventSources(item) {
    const updateEvent = this.kinesisSourceEvents.map(
      (lambda) => this.updateKinesisEventSource(item, lambda.eventType)
    );
    return Promise.all(updateEvent);
  }

  /**
   * update an event source, only the state can be updated
   *
   * @param {Object} item - the rule item
   * @param {string} eventType - kinesisSourceEvent Type
   * @returns {Promise} the response from event source update
   */
  updateKinesisEventSource(item, eventType) {
    const params = {
      UUID: item.rule[this.eventMapping[eventType]],
      Enabled: item.state === 'ENABLED'
    };
    return aws.lambda().updateEventSourceMapping(params).promise();
  }

  /**
   * Delete event source mappings for all mappings in the kinesisSourceEvents
   * @param {Object} item - the rule item
   * @returns {Promise<Array>} array of responses from the event source deletion
   */
  async deleteKinesisEventSources(item) {
    const deleteEventPromises = this.kinesisSourceEvents.map(
      (lambda) => this.deleteKinesisEventSource(item, lambda.eventType)
    );
    const eventDelete = await Promise.all(deleteEventPromises);
    item.rule.arn = eventDelete[0]; // eslint-disable-line no-param-reassign
    item.rule.logEventArn = eventDelete[1]; // eslint-disable-line no-param-reassign
    return item;
  }

  /**
   * deletes an event source from an event lambda function
   *
   * @param {Object} item - the rule item
   * @param {string} eventType - kinesisSourceEvent Type
   * @returns {Promise} the response from event source delete
   */
  async deleteKinesisEventSource(item, eventType) {
    if (await this.isEventSourceMappingShared(item, eventType)) {
      return undefined;
    }
    const params = {
      UUID: item.rule[this.eventMapping[eventType]]
    };

    return aws.lambda().deleteEventSourceMapping(params).promise();
  }

  /**
   * check if a rule's event source mapping is shared with other rules
   *
   * @param {Object} item - the rule item
   * @param {string} eventType - kinesisSourceEvent Type
   * @returns {boolean} return true if no other rules share the same event source mapping
   */
  async isEventSourceMappingShared(item, eventType) {
    const { db } = privates.get(this);

    const eventFieldMapping = {
      arn: 'rule_arn',
      logEventArn: 'rule_log_event_arn'
    };

    const kinesisRules = await rulesGateway.find(
      db,
      {
        where: {
          [eventFieldMapping[eventType]]: item.rule[eventType],
          rule_type: item.rule.type
        },
        whereNot: {
          name: item.name
        }
      }
    );

    return kinesisRules.length > 0;
  }

  async addSnsTrigger(item) {
    // check for existing subscription
    let token;
    let subExists = false;
    let subscriptionArn;
    /* eslint-disable no-await-in-loop */
    do {
      const subsResponse = await aws.sns().listSubscriptionsByTopic({
        TopicArn: item.rule.value,
        NextToken: token
      }).promise();
      token = subsResponse.NextToken;
      if (subsResponse.Subscriptions) {
        /* eslint-disable no-loop-func */
        subsResponse.Subscriptions.forEach((sub) => {
          if (sub.Endpoint === process.env.messageConsumer) {
            subExists = true;
            subscriptionArn = sub.SubscriptionArn;
          }
        });
      }
      /* eslint-enable no-loop-func */
      if (subExists) break;
    }
    while (token);
    /* eslint-enable no-await-in-loop */
    if (!subExists) {
      // create sns subscription
      const subscriptionParams = {
        TopicArn: item.rule.value,
        Protocol: 'lambda',
        Endpoint: process.env.messageConsumer,
        ReturnSubscriptionArn: true
      };
      const r = await aws.sns().subscribe(subscriptionParams).promise();
      subscriptionArn = r.SubscriptionArn;
    }
    // create permission to invoke lambda
    const permissionParams = {
      Action: 'lambda:InvokeFunction',
      FunctionName: process.env.messageConsumer,
      Principal: 'sns.amazonaws.com',
      SourceArn: item.rule.value,
      StatementId: `${item.name}Permission`
    };
    await aws.lambda().addPermission(permissionParams).promise();

    item.rule.arn = subscriptionArn; // eslint-disable-line no-param-reassign
    return item;
  }

  async deleteSnsTrigger(item) {
    // delete permission statement
    const permissionParams = {
      FunctionName: process.env.messageConsumer,
      StatementId: `${item.name}Permission`
    };
    await aws.lambda().removePermission(permissionParams).promise();
    // delete sns subscription
    const subscriptionParams = {
      SubscriptionArn: item.rule.arn
    };
    await aws.sns().unsubscribe(subscriptionParams).promise();

    return item;
  }
}
module.exports = Rule;
