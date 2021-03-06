'use strict';

const router = require('express-promise-router')();
const models = require('../models');
const { RecordDoesNotExist } = require('../lib/errors');
const { Search } = require('../es/search');

/**
 * List all rules.
 *
 * @param {Object} req - express request object
 * @param {Object} res - express response object
 * @returns {Promise<Object>} the promise of express response object
 */
async function list(req, res) {
  const search = new Search({
    queryStringParameters: req.query
  }, 'rule');
  const response = await search.query();
  return res.send(response);
}

/**
 * Query a single rule.
 *
 * @param {Object} req - express request object
 * @param {Object} res - express response object
 * @returns {Promise<Object>} the promise of express response object
 */
async function get(req, res) {
  const name = req.params.name;

  const model = new models.Rule();
  try {
    const result = await model.get({ name });
    delete result.password;
    return res.send(result);
  }
  catch (e) {
    if (e instanceof RecordDoesNotExist) {
      return res.boom.notFound('No record found');
    }
    throw e;
  }
}

/**
 * Creates a new rule
 *
 * @param {Object} req - express request object
 * @param {Object} res - express response object
 * @returns {Promise<Object>} the promise of express response object
 */
async function post(req, res) {
  const data = req.body;
  const name = data.name;

  const model = new models.Rule();

  try {
    await model.get({ name });
    return res.boom.conflict(`A record already exists for ${name}`);
  }
  catch (e) {
    if (e instanceof RecordDoesNotExist) {
      const r = await model.create(data);
      return res.send({ message: 'Record saved', record: r });
    }
    throw e;
  }
}

/**
 * Updates an existing rule
 *
 * @param {Object} req - express request object
 * @param {Object} res - express response object
 * @returns {Promise<Object>} the promise of express response object
 */
async function put(req, res) {
  const name = req.params.name;

  const data = req.body;
  const action = data.action;

  const model = new models.Rule();

  // get the record first
  let originalData;
  try {
    originalData = await model.get({ name });
  }
  catch (e) {
    if (e instanceof RecordDoesNotExist) return res.boom.notFound('Record does not exist');
    throw e;
  }

  // if rule type is onetime no change is allowed unless it is a rerun
  if (action === 'rerun') {
    await models.Rule.invoke(originalData);
    return res.send(originalData);
  }

  const d = await model.update(originalData, data);
  return res.send(d);
}

/**
 * deletes a rule
 *
 * @param {Object} req - express request object
 * @param {Object} res - express response object
 * @returns {Promise<Object>} the promise of express response object
 */
async function del(req, res) {
  const name = (req.params.name || '').replace(/%20/g, ' ');
  const model = new models.Rule();

  let record;
  try {
    record = await model.get({ name });
  }
  catch (e) {
    if (e instanceof RecordDoesNotExist) {
      return res.boom.notFound('No record found');
    }
    throw e;
  }
  await model.delete(record);
  return res.send({ message: 'Record deleted' });
}

router.get('/:name', get);
router.get('/', list);
router.put('/:name', put);
router.post('/', post);
router.delete('/:name', del);

module.exports = router;
