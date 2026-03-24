module.exports = {
  testEnvironment: 'node',
  testMatch: ['**/test/**/*.test.js'],
  collectCoverageFrom: [
    'scripts/**/*.js',
    'workers/**/*.js',
    '!**/node_modules/**'
  ],
  coverageDirectory: 'test/coverage'
};