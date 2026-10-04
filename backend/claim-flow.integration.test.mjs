import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import config from '../app.config.mjs';

test('customer scoped claim, correspondence, and later credit path', {
  skip: !process.env.RECOVERY_INTEGRATION_DATABASE_URL,
}, async () => {
  process.env.DATABASE_URL = process.env.RECOVERY_INTEGRATION_DATABASE_URL;
  process.env.APP_TEST_NO_LISTEN = 'true';
  const { app, pool } = await import('./server.mjs');
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = async (path, token, body, method = 'GET') => {
    const response = await fetch(base + path, {
      method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, data: await response.json() };
  };
  try {
    const feature = config.features.find(item => item.id === 'statement-ingestion');
    assert.ok(feature);
    const reference = `CASE-${randomUUID()}`;
    const actual = 12.8;
    const expected = 10;
    const customerA = randomUUID(), customerB = randomUUID();
    const password = `Test-${randomUUID()}`;
    const accounts = [
      { id: customerA, email: `a-${randomUUID()}@example.test` },
      { id: customerB, email: `b-${randomUUID()}@example.test` },
    ];
    for (const account of accounts) {
      await pool.query('INSERT INTO customer_accounts(id,name) VALUES($1,$2)', [account.id, account.email]);
      await pool.query("INSERT INTO app_users(account_id,email,password_hash,name,role) VALUES($1,$2,$3,$4,'admin')",
        [account.id, account.email, await bcrypt.hash(password, 4), account.email]);
      await pool.query(`INSERT INTO feature_records(account_id,feature_id,reference,title,status,owner,risk,due_date,amount,payload)
        VALUES($1,$2,$3,'Integration case','Open',$4,'Not assessed',current_date+30,$5,$6)`,
      [account.id, feature.id, reference, account.email, actual, { allowedAmount: expected }]);
      account.token = (await request('/api/auth/login', null, { email: account.email, password }, 'POST')).data.token;
      assert.ok(account.token);
    }
    const source = `reference,description,expense_category,property_amount,amount,date\n${reference},Property taxes,Property taxes,100.00,${actual},2026-07-18\n`;
    const path = `/api/features/${feature.id}/ingest`;
    const ingestedA = await request(path, accounts[0].token, { text: source, sourceFile: 'issuer.csv' }, 'POST');
    const ingestedB = await request(path, accounts[1].token, { text: source, sourceFile: 'issuer.csv' }, 'POST');
    assert.equal(ingestedA.status, 201);
    assert.equal(ingestedB.status, 201, 'same checksum must be allowed in another account');
    assert.equal(ingestedA.data.checksum, ingestedB.data.checksum);
    const bIngestFromA = await request(`/api/statement-ingests/${ingestedB.data.ingestId}`, accounts[0].token);
    assert.equal(bIngestFromA.status, 404);
    assert.equal((await request('/api/claims/candidates', accounts[0].token)).data.items.length, 0,
      'typed allowed amounts and imported lines cannot bypass approved CAM rules');
    for (const account of accounts) {
      const reviewerEmail = `reviewer-${randomUUID()}@example.test`;
      await pool.query("INSERT INTO app_users(account_id,email,password_hash,name,role) VALUES($1,$2,$3,'Reviewer','reviewer')",
        [account.id, reviewerEmail, await bcrypt.hash(password, 4)]);
      const reviewerToken = (await request('/api/auth/login', null, { email: reviewerEmail, password }, 'POST')).data.token;
      account.reviewerToken = reviewerToken;
      const clause = 'Section 8.4 states property taxes are allocated by 10 tenant square feet over 100 property square feet for 2026.';
      const savedSource = await request('/api/cam/sources', account.token,
        { sourceKind: 'LEASE', title: '2026 signed lease text', content: clause }, 'POST');
      assert.equal(savedSource.status, 201);
      account.sourceId = savedSource.data.source.id;
      assert.equal((await request('/api/cam/rules', account.token, {
        caseReference: reference, leaseReference: 'LEASE-2026', leaseYear: 2026, category: 'Property taxes',
        ruleType: 'PRO_RATA', tenantAreaSqFt: 10, propertyAreaSqFt: 100,
        sourceId: account.sourceId, sourceQuote: 'A fabricated clause that is not in the lease.', clauseLocator: '§8.4',
      }, 'POST')).status, 422);
      assert.equal((await request('/api/cam/rules', account.token, {
        caseReference: reference, leaseReference: 'LEASE-2026', leaseYear: 2026, category: 'Property taxes',
        ruleType: 'PRO_RATA', tenantAreaSqFt: 11, propertyAreaSqFt: 100,
        sourceId: account.sourceId, sourceQuote: clause, clauseLocator: '§8.4',
      }, 'POST')).status, 422);
      const draft = await request('/api/cam/rules', account.token, {
        caseReference: reference, leaseReference: 'LEASE-2026', leaseYear: 2026, category: 'Property taxes',
        ruleType: 'PRO_RATA', tenantAreaSqFt: 10, propertyAreaSqFt: 100,
        sourceId: account.sourceId, sourceQuote: clause, clauseLocator: '§8.4',
      }, 'POST');
      assert.equal(draft.status, 201, JSON.stringify(draft.data));
      assert.equal(draft.data.rule.status, 'DRAFT');
      account.ruleId = draft.data.rule.id;
      assert.equal((await request(`/api/cam/rules/${draft.data.rule.id}/approve`, account.token,
        { rationale: 'I checked the lease section and property allocation.' }, 'POST')).status, 403);
      assert.equal((await request(`/api/cam/rules/${draft.data.rule.id}/approve`, reviewerToken,
        { rationale: 'I checked the lease section and property allocation.' }, 'POST')).status, 200);
      const assessed = await request(`/api/cam/rules/${draft.data.rule.id}/assess`, account.token, {}, 'POST');
      assert.equal(assessed.status, 200, JSON.stringify(assessed.data));
      assert.equal(assessed.data.newAssessments, 1);
    }
    assert.equal((await request(`/api/cam/sources/${accounts[1].sourceId}`, accounts[0].token)).status, 404);
    const candidatesA = await request('/api/claims/candidates', accounts[0].token);
    const candidatesB = await request('/api/claims/candidates', accounts[1].token);
    assert.equal(candidatesA.data.items.length, 1);
    assert.equal(candidatesB.data.items.length, 1);
    const aLine = candidatesA.data.items[0], bLine = candidatesB.data.items[0];
    assert.notEqual(aLine.id, bLine.id);
    await assert.rejects(pool.query(`INSERT INTO recovery_claims(account_id,feature_id,record_reference,statement_line_id,requested_cents,created_by)
      VALUES($1,$2,$3,$4,280,'integration')`, [customerA, feature.id, reference, bLine.id]), { code: '23503' });
    assert.equal((await request('/api/claims', accounts[0].token, { statementLineId: bLine.id, camAssessmentId: bLine.cam_assessment_id }, 'POST')).status, 409);
    const claimA = await request('/api/claims', accounts[0].token, { statementLineId: aLine.id, camAssessmentId: aLine.cam_assessment_id }, 'POST');
    const claimB = await request('/api/claims', accounts[1].token, { statementLineId: bLine.id, camAssessmentId: bLine.cam_assessment_id }, 'POST');
    assert.equal(claimA.status, 201);
    assert.equal(claimB.status, 201);
    assert.equal((await request(`/api/claims/${claimB.data.claim.id}`, accounts[0].token)).status, 404);
    const eventPath = `/api/claims/${claimA.data.claim.id}/events`;
    assert.equal((await request(eventPath, accounts[0].token, { eventType: 'SUBMITTED', externalReference: 'PORTAL-12345', evidenceText: 'Claim entered into the issuer portal on the recorded date.' }, 'POST')).status, 200);
    assert.equal((await request(eventPath, accounts[0].token, { eventType: 'ACKNOWLEDGED', externalReference: 'ACK-12345', evidenceText: 'Issuer acknowledgement copied from portal message.' }, 'POST')).status, 200);
    const creditFile = `reference,description,amount,date\n${reference},First credit,-1.30,2026-07-25\n${reference},Second credit,-1.50,2026-07-25\n`;
    assert.equal((await request(path, accounts[0].token, { text: creditFile, sourceFile: 'issuer-credit.csv' }, 'POST')).status, 201);
    const creditCandidates = await request(`/api/claims/credit-lines?claimId=${claimA.data.claim.id}`, accounts[0].token);
    assert.equal(creditCandidates.data.items.length, 2);
    const first = await request(`/api/claims/${claimA.data.claim.id}/credits`, accounts[0].token,
      { creditLineId: creditCandidates.data.items[0].id, issuerReference: 'CREDIT-12345' }, 'POST');
    assert.equal(first.status, 200);
    assert.equal(first.data.claim.status, 'PARTIAL_CREDIT');
    const linked = await request(`/api/claims/${claimA.data.claim.id}/credits`, accounts[0].token,
      { creditLineId: creditCandidates.data.items[1].id, issuerReference: 'CREDIT-12346' }, 'POST');
    assert.equal(linked.status, 200);
    assert.equal(linked.data.claim.status, 'CREDIT_EVIDENCED');
    assert.equal(Number(linked.data.claim.credit_cents), 280);
    assert.equal((await request(`/api/claims/${claimB.data.claim.id}`, accounts[1].token)).data.claim.status, 'DRAFT');
    const account = accounts[0];
    const revised = await request('/api/cam/rules', account.token, {
      caseReference: reference, leaseReference: 'LEASE-2026', leaseYear: 2026, category: 'Property taxes',
      ruleType: 'PRO_RATA', tenantAreaSqFt: 10, propertyAreaSqFt: 100,
      sourceId: account.sourceId,
      sourceQuote: 'Section 8.4 states property taxes are allocated by 10 tenant square feet over 100 property square feet for 2026.',
      clauseLocator: '§8.4 revised review',
    }, 'POST');
    assert.equal(revised.status, 201);
    assert.equal(revised.data.rule.version, 2);
    assert.equal((await request(`/api/cam/rules/${revised.data.rule.id}/approve`, account.reviewerToken,
      { rationale: 'Second independent review confirms the cited allocation.' }, 'POST')).status, 200);
    assert.equal((await request(`/api/cam/rules/${revised.data.rule.id}/assess`, account.token, {}, 'POST')).data.newAssessments, 1);
    const versions = (await request('/api/cam/rules', account.token)).data.items;
    assert.equal(versions.find(item => item.id === account.ruleId).status, 'SUPERSEDED');
    assert.equal(versions.find(item => item.id === revised.data.rule.id).status, 'APPROVED');
    assert.equal((await request('/api/claims/candidates', account.token)).data.items.length, 0,
      'a historical claim cannot be duplicated after rule version approval');

    const extraLeaseText = 'Section 8.5 excludes Capital repairs from CAM for 2026. Section 8.6 caps Utilities at 5% over the prior year, allocated by 10 tenant square feet over 100 property square feet.';
    const extraLease = await request('/api/cam/sources', account.token,
      { sourceKind: 'AMENDMENT', title: 'CAM 2026 category amendment', content: extraLeaseText }, 'POST');
    const priorText = 'The 2025 Utilities allowed category amount was $9.00 for this lease.';
    const prior = await request('/api/cam/sources', account.token,
      { sourceKind: 'PRIOR_STATEMENT', title: 'CAM 2025 category statement', content: priorText }, 'POST');
    assert.equal(extraLease.status, 201); assert.equal(prior.status, 201);
    const extraFile = `reference,description,expense_category,property_amount,amount,date\n${reference},Capital repairs,Capital repairs,,4.00,2026-08-01\n${reference},Utilities,Utilities,100.00,12.00,2026-08-01\n`;
    assert.equal((await request(path, account.token, { text: extraFile, sourceFile: 'landlord-categories.csv' }, 'POST')).status, 201);
    const exclusion = await request('/api/cam/rules', account.token, {
      caseReference: reference, leaseReference: 'LEASE-2026', leaseYear: 2026, category: 'Capital repairs', ruleType: 'EXCLUSION',
      sourceId: extraLease.data.source.id, sourceQuote: 'Section 8.5 excludes Capital repairs from CAM for 2026.', clauseLocator: '§8.5',
    }, 'POST');
    const cap = await request('/api/cam/rules', account.token, {
      caseReference: reference, leaseReference: 'LEASE-2026', leaseYear: 2026, category: 'Utilities', ruleType: 'CATEGORY_CAP',
      tenantAreaSqFt: 10, propertyAreaSqFt: 100, capPercent: '5', priorYearAllowedAmount: '9.00',
      sourceId: extraLease.data.source.id,
      sourceQuote: 'Section 8.6 caps Utilities at 5% over the prior year, allocated by 10 tenant square feet over 100 property square feet.',
      clauseLocator: '§8.6', priorSourceId: prior.data.source.id, priorSourceQuote: priorText,
    }, 'POST');
    assert.equal(exclusion.status, 201, JSON.stringify(exclusion.data));
    assert.equal(cap.status, 201, JSON.stringify(cap.data));
    for (const ruleId of [exclusion.data.rule.id, cap.data.rule.id]) {
      assert.equal((await request(`/api/cam/rules/${ruleId}/approve`, account.reviewerToken,
        { rationale: 'I checked the exact category and arithmetic source text.' }, 'POST')).status, 200);
      assert.equal((await request(`/api/cam/rules/${ruleId}/assess`, account.token, {}, 'POST')).data.newAssessments, 1);
    }
    const extraCandidates = (await request('/api/claims/candidates', account.token)).data.items;
    assert.equal(extraCandidates.length, 2);
    assert.deepEqual(extraCandidates.map(item => Number(item.delta)).sort((a, b) => a - b), [2.55, 4]);
    const dashboard = await request('/api/dashboard', account.token);
    assert.equal(dashboard.status, 200);
    assert.equal(dashboard.data.totals.confirmed_recovery, 9.35);
    const secondAnnualCapLine = `reference,description,expense_category,property_amount,amount,date\n${reference},Utilities correction,Utilities,10.00,1.00,2026-09-01\n`;
    assert.equal((await request(path, account.token, { text: secondAnnualCapLine, sourceFile: 'landlord-utilities-correction.csv' }, 'POST')).status, 201);
    const safeCandidates = (await request('/api/claims/candidates', account.token)).data.items;
    assert.equal(safeCandidates.length, 1);
    assert.equal(safeCandidates[0].rule_type, 'EXCLUSION');
    assert.equal((await request('/api/dashboard', account.token)).data.totals.confirmed_recovery, 6.8);
    const capCandidate = extraCandidates.find(item => item.rule_type === 'CATEGORY_CAP');
    assert.equal((await request('/api/claims', account.token,
      { statementLineId: capCandidate.id, camAssessmentId: capCandidate.cam_assessment_id }, 'POST')).status, 409);
  } finally {
    await new Promise(resolve => server.close(resolve));
    await pool.end();
  }
});
