import { amount, invalid } from './recovery-domain.mjs';

export const categoryKey = value => String(value ?? '').trim().replace(/\s+/g, ' ').toLowerCase();

export function percentUnits(value) {
  const text = String(value ?? '').trim();
  if (!/^\d+(?:\.\d{1,4})?$/.test(text) || Number(text) > 100)
    throw invalid('Annual category cap percentage must be 0–100 with at most four decimal places');
  const [whole, fraction = ''] = text.split('.');
  return Number(BigInt(whole) * 10000n + BigInt(fraction.padEnd(4, '0')));
}

export function area(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1 || number > 1000000000)
    throw invalid(`${label} must be a positive whole square-foot figure`);
  return number;
}

function roundedRatio(numerator, denominator) {
  return (numerator + denominator / 2n) / denominator;
}

export function assessCamLine(rule, line) {
  const category = categoryKey(line.provenance?.expenseCategory || line.description);
  if (category !== rule.category_key) throw invalid('Statement category does not match the approved rule', 409);
  const date = String(line.statement_date ?? '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number(date.slice(0, 4)) !== Number(rule.lease_year))
    throw invalid('Statement line is outside the approved lease year', 409);
  if (line.currency !== 'USD') throw invalid('The CAM rule currently supports USD statement lines only', 409);
  if (Number(line.amount) < 0) throw invalid('A credit line is not a CAM charge candidate', 409);
  const observed = amount(line.amount, 'Statement billed amount');
  let expected;
  let propertyCents = null;
  let shareCents = null;
  let capCents = null;
  if (rule.rule_type === 'EXCLUSION') {
    expected = 0;
  } else {
    const rawProperty = line.provenance?.propertyAmount;
    if (rawProperty === undefined || rawProperty === null || String(rawProperty).trim() === '')
      return { observedCents: observed, expectedCents: null, varianceCents: null, status: 'INSUFFICIENT',
        calculation: { reason: 'Property-wide expense amount missing from the imported statement line', ruleId: rule.id, ruleVersion: rule.version, category, date } };
    propertyCents = amount(rawProperty, 'Property-wide expense amount');
    shareCents = Number(roundedRatio(BigInt(propertyCents) * BigInt(rule.tenant_area_sq_ft), BigInt(rule.property_area_sq_ft)));
    if (!Number.isSafeInteger(shareCents)) throw invalid('Calculated CAM share exceeds supported precision');
    expected = shareCents;
    if (rule.rule_type === 'CATEGORY_CAP') {
      capCents = Number(roundedRatio(
        BigInt(rule.prior_year_allowed_cents) * (1000000n + BigInt(rule.cap_percent_units)), 1000000n,
      ));
      if (!Number.isSafeInteger(capCents)) throw invalid('Calculated CAM cap exceeds supported precision');
      expected = Math.min(shareCents, capCents);
    }
  }
  const signed = observed - expected;
  return {
    observedCents: observed, expectedCents: expected, varianceCents: signed,
    status: signed > 0 ? 'CANDIDATE' : 'NO_VARIANCE',
    calculation: {
      method: rule.rule_type === 'EXCLUSION' ? 'lease-category-exclusion-v1' : rule.rule_type === 'PRO_RATA' ? 'property-expense-times-premises-share-v1' : 'category-share-limited-by-prior-year-cap-v1',
      ruleId: rule.id, ruleVersion: rule.version, category, leaseYear: rule.lease_year, date,
      statementChecksum: line.checksum, statementLine: line.line_number,
      propertyCents, tenantAreaSqFt: rule.tenant_area_sq_ft, propertyAreaSqFt: rule.property_area_sq_ft,
      shareCents, capPercentUnits: rule.cap_percent_units, priorYearAllowedCents: rule.prior_year_allowed_cents,
      capCents, observedCents: observed, expectedCents: expected, signedVarianceCents: signed,
      scope: 'Candidate variance from an imported statement and human-approved, operator-supplied lease rule; no landlord credit verified',
    },
  };
}
