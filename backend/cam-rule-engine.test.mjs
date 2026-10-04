import test from 'node:test';
import assert from 'node:assert/strict';
import { assessCamLine, percentUnits } from './cam-rule-engine.mjs';

const line = { amount: '12.80', currency: 'USD', statement_date: '2026-07-18', checksum: 'abc', line_number: 2,
  description: 'Property taxes', provenance: { expenseCategory: 'Property taxes', propertyAmount: '100.00' } };
const base = { id: 1, version: 1, category_key: 'property taxes', lease_year: 2026, tenant_area_sq_ft: 10,
  property_area_sq_ft: 100, cap_percent_units: null, prior_year_allowed_cents: null };

test('an exact-category lease exclusion permits zero, but does not establish a landlord credit', () => {
  const result = assessCamLine({ ...base, rule_type: 'EXCLUSION' }, line);
  assert.equal(result.expectedCents, 0);
  assert.equal(result.varianceCents, 1280);
  assert.equal(result.status, 'CANDIDATE');
  assert.match(result.calculation.scope, /no landlord credit verified/);
  assert.throws(() => assessCamLine({ ...base, rule_type: 'EXCLUSION' }, { ...line, description: 'Insurance', provenance: {} }), /category/);
});

test('pro-rata and category cap use exact cents, integer areas, and one lease year', () => {
  const share = assessCamLine({ ...base, rule_type: 'PRO_RATA' }, line);
  assert.equal(share.expectedCents, 1000);
  assert.equal(share.varianceCents, 280);
  const capped = assessCamLine({ ...base, rule_type: 'CATEGORY_CAP', cap_percent_units: percentUnits('5'), prior_year_allowed_cents: 900 }, line);
  assert.equal(capped.calculation.shareCents, 1000);
  assert.equal(capped.calculation.capCents, 945);
  assert.equal(capped.expectedCents, 945);
  assert.equal(capped.varianceCents, 335);
  const missing = assessCamLine({ ...base, rule_type: 'PRO_RATA' }, { ...line, provenance: { expenseCategory: 'Property taxes' } });
  assert.equal(missing.status, 'INSUFFICIENT');
  assert.equal(missing.varianceCents, null);
  assert.throws(() => assessCamLine({ ...base, rule_type: 'PRO_RATA' }, { ...line, statement_date: '2025-07-18' }), /lease year/);
});

test('cap rates reject excess precision and amounts cannot silently round sub-cent evidence', () => {
  assert.equal(percentUnits('2.1250'), 21250);
  assert.throws(() => percentUnits('2.12501'), /four decimal/);
  assert.throws(() => assessCamLine({ ...base, rule_type: 'PRO_RATA' },
    { ...line, provenance: { expenseCategory: 'Property taxes', propertyAmount: '100.001' } }), /at most two decimal/);
});
