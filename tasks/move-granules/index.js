'use strict';

const cumulusMessageAdapter = require('@cumulus/cumulus-message-adapter-js');
const { DuplicateFile, InvalidArgument } = require('@cumulus/common/errors');
const get = require('lodash.get');
const clonedeep = require('lodash.clonedeep');
const flatten = require('lodash.flatten');
const {
  getRenamedS3File, unversionFilename,
  moveGranuleFile, renameS3FileWithTimestamp
} = require('@cumulus/ingest/granule');
const {
  getCmrFiles, getGranuleId
} = require('@cumulus/cmrjs');
const urljoin = require('url-join');
const path = require('path');
const {
  aws: {
    buildS3Uri,
    checksumS3Objects,
    deleteS3Object,
    parseS3Uri,
    promiseS3Upload,
    s3ObjectExists,
    s3TagSetToQueryString
  }
} = require('@cumulus/common');
const { urlPathTemplate } = require('@cumulus/ingest/url-path-template');
const xml2js = require('xml2js');
const log = require('@cumulus/common/log');


/**
 * Helper to turn an s3URI into a fileobject
 * @param {string} s3URI s3://mybucket/myprefix/myobject.
 * @returns {Object} file object
 */
function fileObjectFromS3URI(s3URI) {
  const uriParsed = parseS3Uri(s3URI);
  return {
    name: path.basename(s3URI),
    bucket: uriParsed.Bucket,
    filename: s3URI
  };
}

/**
 * Creates an object with all granule files
 * from the input array and the input_granules config
 *
 * @param {Array} input - the task input array
 * @param {Array} granules - an array of the granules
 * @param {string} regex - regex needed to extract granuleId from filenames
 * @returns {Object} an object that contains all granules
 * with the granuleId as the key of each granule
 */
function addInputFilesToGranules(input, granules, regex) {
  const granulesHash = {};
  const filesHash = {};

  // create hash list of the granules
  // and a hash list of files
  granules.forEach((g) => {
    granulesHash[g.granuleId] = g;
    g.files.forEach((f) => {
      filesHash[f.filename] = g.granuleId;
    });
  });

  // add input files to corresponding granules
  // the process involve getting granuleId of each file
  // match it against the granuleObj and adding the new files to the
  // file list
  input.forEach((f) => {
    if (f && !filesHash[f]) {
      const granuleId = getGranuleId(f, regex);
      granulesHash[granuleId].files.push(fileObjectFromS3URI(f));
    }
  });

  return granulesHash;
}

/**
 * validates the file matched only one collection.file and has a valid bucket
 * config.
 * @param {Array<Object>} match - list of matched collection.file
 * @param {Object} buckets - the buckets involved with the files
 * @param {Object} file - the fileObject tested.
 * @throws {InvalidArgument} - If match is invalid, throws and error.
 */
function validateMatch(match, buckets, file) {
  if (match.length > 1) {
    throw new InvalidArgument(`File (${file}) matched more than one collection.regexp.`);
  }
  if (match.length === 0) {
    throw new InvalidArgument(`File (${file}) did not match any collection.regexp.`);
  }

  if (!buckets[match[0].bucket]) {
    throw new InvalidArgument(`Collection config specifies a bucket key of ${match[0].bucket}, `
                              + `but the configured bucket keys are: ${Object.keys(buckets).join(', ')}`);
  }
}

/**
* Update the granule metadata where each granule has it's files replaced with
* file objects that contain the desired final locations based on the `collection.files.regexp`
*
* @param {Object} granulesObject - an object of granules where the key is the granuleId
* @param {Object} collection - configuration object defining a collection
*                              of granules and their files
* @param {string} cmrFiles - array of objects that include CMR xmls uris and granuleIds
* @param {Object} buckets - the buckets involved with the files
* @returns {Object} new granulesObject where each granules' files are updated with
*                   the correct target buckets/paths/and s3uri filenames.
**/
function updateGranuleMetadata(granulesObject, collection, cmrFiles, buckets) {
  const updatedGranules = {};
  const fileSpecs = collection.files;
  Object.keys(granulesObject).forEach((granuleId) => {
    const updatedFiles = [];
    updatedGranules[granuleId] = { ...granulesObject[granuleId] };

    granulesObject[granuleId].files.forEach((file) => {
      const match = fileSpecs.filter((cf) => unversionFilename(file.name).match(cf.regex));
      validateMatch(match, buckets, file);

      const URLPathTemplate = file.url_path || match[0].url_path || collection.url_path || '';
      const cmrFile = cmrFiles.find((f) => f.granuleId === granuleId);
      const urlPath = urlPathTemplate(URLPathTemplate, {
        file,
        granule: granulesObject[granuleId],
        cmrMetadata: cmrFile ? cmrFile.metadataObject : {}
      });
      const bucket = buckets[match[0].bucket];
      const filepath = path.join(urlPath, file.name);

      updatedFiles.push({
        ...file,
        ...{
          bucket,
          filepath,
          filename: `s3://${path.join(bucket.name, filepath)}`
        }
      });
    });

    updatedGranules[granuleId].files = [...updatedFiles];
  });

  return updatedGranules;
}

/**
 * move file from source bucket to target location, and return the file moved.
 * In case of 'version' duplicateHandling, also return the renamed files.
 *
 * @param {Object} file - granule file to be moved
 * @param {string} sourceBucket - source bucket location of files
 * @param {string} duplicateHandling - how to handle duplicate files
 * @returns {Array<Object>} returns the file moved and the renamed existing duplicates if any
 */
async function moveFileRequest(file, sourceBucket, duplicateHandling) {
  const fileStagingDir = file.fileStagingDir || 'file-staging';
  const source = {
    Bucket: sourceBucket,
    Key: `${fileStagingDir}/${file.name}`
  };

  const target = {
    Bucket: file.bucket.name,
    Key: file.filepath
  };

  // the file moved to destination
  const fileMoved = clonedeep(file);
  delete fileMoved.fileStagingDir;

  const s3ObjAlreadyExists = await s3ObjectExists(target);
  log.debug(`file ${target.Key} exists in ${target.Bucket}: ${s3ObjAlreadyExists}`);

  if (s3ObjAlreadyExists) fileMoved.duplicate_found = true;

  // Have to throw DuplicateFile and not WorkflowError, because the latter
  // is not treated as a failure by the message adapter.
  if (s3ObjAlreadyExists && duplicateHandling === 'error') {
    throw new DuplicateFile(`${target.Key} already exists in ${target.Bucket} bucket`);
  }

  if (s3ObjAlreadyExists && duplicateHandling === 'skip') return [fileMoved];

  const options = (file.bucket.type.match('public')) ? { ACL: 'public-read' } : null;

  // compare the checksum of the existing file and new file, and handle them accordingly
  if (s3ObjAlreadyExists && duplicateHandling === 'version') {
    const existingFileSum = await checksumS3Objects('CKSUM', target.Bucket, target.Key);
    const stagedFileSum = await checksumS3Objects('CKSUM', source.Bucket, source.Key);

    // if the checksum of the existing file is the same as the new one, keep the existing file,
    // else rename the existing file, and both files are part of the granule.
    if (existingFileSum === stagedFileSum) {
      await deleteS3Object(source.Bucket, source.Key);
    }
    else {
      await renameS3FileWithTimestamp(target.Bucket, target.Key);
      await moveGranuleFile(source, target, options);
    }
  }
  else {
    await moveGranuleFile(source, target, options);
  }

  const renamedFiles = (duplicateHandling === 'version')
    ? await getRenamedS3File(target.Bucket, target.Key) : [];

  // return both file moved and renamed files
  return [fileMoved]
    .concat(renamedFiles.map((f) => ({
      bucket: file.bucket,
      name: path.basename(f.Key),
      filename: buildS3Uri(f.Bucket, f.Key),
      filepath: f.Key,
      fileSize: f.fileSize,
      url_path: file.url_path
    })));
}

/**
* Move all files in a collection of granules from staging location fo final location,
* and update granule files to include renamed files if any.
*
* @param {Object} granulesObject - an object of the granules where the key is the granuleId
* @param {string} sourceBucket - source bucket location of files
* @param {string} duplicateHandling - how to handle duplicate files
* @returns {Object} the object with updated granules
**/
async function moveFilesForAllGranules(granulesObject, sourceBucket, duplicateHandling) {
  const moveFileRequests = Object.keys(granulesObject).map(async (granuleKey) => {
    const granule = granulesObject[granuleKey];
    const cmrFileFormat = /.*\.cmr\.xml$/;
    const filesToMove = granule.files.filter((file) => !file.name.match(cmrFileFormat));
    const cmrFile = granule.files.filter((file) => file.name.match(cmrFileFormat));

    const filesMoved = await Promise.all(filesToMove.map((file) =>
      moveFileRequest(file, sourceBucket, duplicateHandling)));
    granule.files = flatten(filesMoved).concat(cmrFile);
  });

  await Promise.all(moveFileRequests);
  return granulesObject;
}

/**
* Update the online access url fields in CMR xml files
*
* @param {string} cmrFiles - array of objects that include CMR xmls uris and granuleIds
* @param {Object} granulesObject - an object of the granules where the key is the granuleId
* @param {string} distEndpoint - the api distribution endpoint
* @returns {Promise} promise resolves when all files have been updated
**/
async function updateCmrFileAccessURLs(cmrFiles, granulesObject, distEndpoint) {
  await Promise.all(cmrFiles.map(async (cmrFile) => {
    const metadataGranule = get(cmrFile, 'metadataObject.Granule');
    const granule = granulesObject[cmrFile.granuleId];
    const urls = [];
    // Populates onlineAcessUrls with all public and protected files
    granule.files.forEach((file) => {
      const urlObj = {};
      if (file.bucket.type.match('protected')) {
        const extension = urljoin(file.bucket.name, file.filepath);
        urlObj.URL = urljoin(distEndpoint, extension);
        urlObj.URLDescription = 'File to download';
        urls.push(urlObj);
        log.info(`protected file: ${JSON.stringify(file)},\nurl: ${JSON.stringify(urlObj)}`);
      }
      else if (file.bucket.type.match('public')) {
        urlObj.URL = `https://${file.bucket.name}.s3.amazonaws.com/${file.filepath}`;
        urlObj.URLDescription = 'File to download';
        urls.push(urlObj);
      }
    });

    const updatedGranule = {};
    Object.keys(metadataGranule).forEach((key) => {
      if (key === 'OnlineResources' || key === 'Orderable') {
        updatedGranule.OnlineAccessURLs = {};
      }
      updatedGranule[key] = metadataGranule[key];
    });
    updatedGranule.OnlineAccessURLs.OnlineAccessURL = urls;
    /* eslint-disable no-param-reassign */
    cmrFile.metadataObject.Granule = updatedGranule;

    const builder = new xml2js.Builder();
    const xml = builder.buildObject(cmrFile.metadataObject);
    cmrFile.metadata = xml;
    /* eslint-enable no-param-reassign */
    const updatedCmrFile = granule.files.find((f) => f.filename.match(/.*\.cmr\.xml$/));
    // S3 upload only accepts tag query strings, so reduce tags to query string.
    const tagsQueryString = s3TagSetToQueryString(cmrFile.s3Tags);
    const params = {
      Bucket: updatedCmrFile.bucket.name,
      Key: updatedCmrFile.filepath,
      Body: xml,
      Tagging: tagsQueryString
    };
    if (updatedCmrFile.bucket.type.match('public')) {
      params.ACL = 'public-read';
      await promiseS3Upload(params);
    }
    else {
      await promiseS3Upload(params);
    }
    // clean up old CmrFile after uploading new one
    const { Bucket, Key } = parseS3Uri(cmrFile.filename);
    await deleteS3Object(Bucket, Key);
  }));
}

/**
 * Returns a directive on how to act when duplicate files are encountered.
 *
 * @param {Object} event - lambda function event.
 * @param {Object} event.config - the config object
 * @param {Object} event.config.collection - collection object.

 * @returns {string} - duplicate handling directive.
 */
function duplicateHandlingType(event) {
  const config = get(event, 'config');
  const collection = get(event, 'collection');

  let duplicateHandling = get(config, 'duplicateHandling', get(collection, 'duplicateHandling', 'error'));

  const forceDuplicateOverwrite = get(event, 'cumulus_config.cumulus_context.forceDuplicateOverwrite', false);

  log.debug(`Configured duplicateHandling value: ${duplicateHandling}, forceDuplicateOverwrite ${forceDuplicateOverwrite}`);

  if (forceDuplicateOverwrite === true) duplicateHandling = 'replace';

  return duplicateHandling;
}

/**
 * Move Granule files to final Location
 * See the schemas directory for detailed input and output schemas
 *
 * @param {Object} event -Lambda function payload
 * @param {Object} event.config - the config object
 * @param {string} event.config.bucket - the bucket name where public/private keys
 *                                       are stored
 * @param {string} event.config.granuleIdExtraction - regex needed to extract granuleId
 *                                                    from filenames
 * @param {Array} event.config.input_granules - an array of granules
 * @param {string} event.config.distribution_endpoint - distribution enpoint for the api
 * @param {Object} event.config.collection - configuration object defining a collection
 * of granules and their files
 * @param {boolean} [event.config.moveStagedFiles=true] - set to false to skip moving files
 * from staging to final bucket. Mostly useful for testing.
 * @param {Array} event.input - an array of s3 uris
 * @returns {Promise} returns the promise of an updated event object
 */
async function moveGranules(event) {
  // we have to post the meta-xml file of all output granules
  // first we check if there is an output file
  const config = get(event, 'config');
  const bucket = get(config, 'bucket'); // the name of the bucket with private/public keys
  const buckets = get(config, 'buckets');
  const regex = get(config, 'granuleIdExtraction', '(.*)');
  const inputGranules = get(config, 'input_granules', {});
  const distEndpoint = get(config, 'distribution_endpoint');
  const moveStagedFiles = get(config, 'moveStagedFiles', true);
  const collection = config.collection;

  const duplicateHandling = duplicateHandlingType(event);

  const input = get(event, 'input', []);

  // Get list of cmr file objects from the input Array of S3 filenames (in
  // staging location after processing)
  const cmrFiles = await getCmrFiles(input, regex);

  // create granules object for cumulus indexer
  const allGranules = addInputFilesToGranules(input, inputGranules, regex);

  const targetedGranules = updateGranuleMetadata(allGranules, collection, cmrFiles, buckets);

  // allows us to disable moving the files
  let movedGranules;
  if (moveStagedFiles) {
    // move files from staging location to final location
    movedGranules = await moveFilesForAllGranules(targetedGranules, bucket, duplicateHandling);
    // update cmr.xml files with correct online access urls
    await updateCmrFileAccessURLs(cmrFiles, movedGranules, distEndpoint);
  }

  return {
    granules: Object.keys(movedGranules).map((k) => {
      const granule = movedGranules[k];

      // Just return the bucket name with the granules
      granule.files.map((f) => {
        f.bucket = f.bucket.name; /* eslint-disable-line no-param-reassign */
        return f;
      });

      return granule;
    })
  };
}

exports.moveGranules = moveGranules;

/**
 * Lambda handler
 *
 * @param {Object} event - a Cumulus Message
 * @param {Object} context - an AWS Lambda context
 * @param {Function} callback - an AWS Lambda handler
 * @returns {undefined} - does not return a value
 */
function handler(event, context, callback) {
  cumulusMessageAdapter.runCumulusTask(moveGranules, event, context, callback);
}

exports.handler = handler;
