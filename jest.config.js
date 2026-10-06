// force timezone to UTC to allow tests to work regardless of local timezone
// generally used by snapshots, but can affect specific tests
process.env.TZ = 'UTC';

const { grafanaESModules, nodeModulesToTransform } = require('./.config/jest/utils');

module.exports = {
  // Jest configuration provided by Grafana scaffolding
  ...require('./.config/jest.config'),
  // Grafana 12's UI dependencies are ESM-only; retain the scaffold defaults.
  transformIgnorePatterns: [
    nodeModulesToTransform([...grafanaESModules, 'marked', 'react-calendar', '@wojtekmaj', 'get-user-locale', 'memoize', 'mimic-function']),
  ],
};
