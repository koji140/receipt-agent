const fs = require('fs');
const path = require('path');

describe('Receipt Agent Test Cases', () => {
  const sampleData = JSON.parse(
    fs.readFileSync(path.join(__dirname, 'sample.json'), 'utf8')
  );

  test('should have valid test cases structure', () => {
    expect(sampleData).toHaveProperty('cases');
    expect(Array.isArray(sampleData.cases)).toBe(true);
    expect(sampleData.cases.length).toBeGreaterThan(0);
  });

  test('TC-001 should have correct structure', () => {
    const tc001 = sampleData.cases.find(c => c.id === 'TC-001');
    expect(tc001).toBeDefined();
    expect(tc001.input).toHaveProperty('mode', 'finalize');
    expect(tc001.expected).toHaveProperty('debit_account', '通信費');
    expect(tc001.expected).toHaveProperty('original_amount', 4180);
  });

  test('TC-002 should have correct structure', () => {
    const tc002 = sampleData.cases.find(c => c.id === 'TC-002');
    expect(tc002).toBeDefined();
    expect(tc002.expected).toHaveProperty('debit_account', '水道光熱費');
    expect(tc002.expected).toHaveProperty('original_amount', 10289);
  });

  // Add more test cases as needed
});