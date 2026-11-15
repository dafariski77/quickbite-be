/* eslint-disable */
const { readFileSync } = require('fs');

// Reading the SWC compilation config for the spec files
const swcJestConfig = JSON.parse(
  readFileSync(`${__dirname}/.spec.swcrc`, 'utf-8'),
);

// Disable .swcrc look-up by SWC core because we're passing in swcJestConfig ourselves
swcJestConfig.swcrc = false;

module.exports = {
  displayName: '@micro/core-app',
  preset: '../../jest.preset.js',
  testEnvironment: 'node',
  transform: {
    '^.+\\.[tj]s$': ['@swc/jest', swcJestConfig],
  },
  // Allow SWC to transform ESM-only packages from node_modules
  transformIgnorePatterns: [
    'node_modules/(?!(@nestjs/bullmq|bullmq|@nestjs/bull-shared|@bull-board|@nestjs/event-emitter)/)',
  ],
  moduleFileExtensions: ['ts', 'js', 'html'],
  coverageDirectory: 'test-output/jest/coverage',
};
