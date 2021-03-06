# @cumulus/hello-world

[![Build Status](https://travis-ci.org/nasa/cumulus.svg?branch=master)](https://travis-ci.org/nasa/cumulus)

`@cumulus/hello-world` contains code for a lambda function returning javascript object:

```javascript
{ hello: "Hello World" }
```

Hello World can also be used to test failure and retry behavior. This task does not require any parameters but can take an optional `fail` flag, which when set to `true` can force the task to fail.

The `passOnRetry` parameter can be used to test your workflow retry configuration. If set to `true` with `fail` as `true`, when retried (according to the workflow configuration), the task will pass. `bucket` and `execution` parameters are required to write the state information to S3 to support this.

## What is Cumulus?

Cumulus is a cloud-based data ingest, archive, distribution and management prototype for NASA's future Earth science data streams.

[Cumulus Documentation](https://nasa.github.io/cumulus)

## Contributing

See [Cumulus README](https://github.com/nasa/cumulus/blob/master/README.md#installing-and-deploying)
