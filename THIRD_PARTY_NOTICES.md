# Third party notices

The source in this repository is MIT licensed. These production dependencies keep their own licenses, and the desktop bundle ships each one's license file with it:

| Dependency | License |
|---|---|
| [@thenavidm/slipway](https://github.com/thenavidm/slipway) | Apache-2.0 |
| [@modelcontextprotocol/server](https://github.com/modelcontextprotocol/typescript-sdk) and its `core` package | Apache-2.0 |
| [zod](https://github.com/colinhacks/zod) | MIT |

The facet detection regexes in `src/content/facets.ts` are taken from [`@atproto/api`](https://github.com/bluesky-social/atproto) (MIT) so that link, tag and mention segmentation matches the official client. The package itself is not a dependency.
