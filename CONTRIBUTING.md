# Contributing

This repository holds the DMARCo inbound mail gateway: Postfix, the Node
processor, and the certificate automation. Pull requests for that code belong
here.

**Issues belong in [`dmarcoapp/dmarcoapp`](https://github.com/dmarcoapp/dmarcoapp/issues),**
together with every other DMARCo issue, so nobody has to guess which component
a problem comes from.

The full contribution guide lives in the main repository:
[`CONTRIBUTING.md`](https://github.com/dmarcoapp/dmarcoapp/blob/main/CONTRIBUTING.md).

Before you push, run what CI runs:

```bash
npm run lint
npm test
npm run coverage
```

Coding standards and deployment constraints for this repository are in
[`AGENTS.md`](AGENTS.md). Mail handling changes need a test that feeds a real
`.eml` fixture through the processor.
