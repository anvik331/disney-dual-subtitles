# Contributing

Thank you for contributing to Disney+ Dual Subtitles.

## Development setup

The extension has no production dependencies and no build step. Node.js 18 or
newer is required to run validation and tests.

```sh
npm run check
npm test
```

## Pull requests

1. Keep the extension's purpose limited to synchronized subtitle presentation.
2. Request only the minimum browser and host permissions needed by the feature.
3. Do not add analytics, advertising, remote code, DRM circumvention, or subtitle
   uploads without prior discussion and clear user consent.
4. Add or update tests when changing manifest parsing, cue timing, caching,
   seeking, or cross-context messaging.
5. Update the README and privacy statement when behavior or data handling changes.

Do not include Disney account data, signed playback URLs, copyrighted video,
private subtitle captures, `.pem` signing keys, or browser-profile files in a
commit, issue, or pull request.

