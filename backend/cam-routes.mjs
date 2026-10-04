import { createHash } from 'node:crypto';
import express from 'express';
import { amount, invalid } from './recovery-domain.mjs';
import { area, assessCamLine, categoryKey, percentUnits } from './cam-rule-engine.mjs';
import { citedPdfPage, extractCamPdf, sha256, verifiedCamOriginal } from './cam-pdf-source.mjs';

const integerId = value => {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) throw invalid('Invalid CAM source or rule id', 400);
  return number;
};
const valueText = (value, label, min, max) => {
  if (typeof value !== 'string' || value.trim().length < min || value.length > max)
    throw invalid(`${label} must contain ${min}–${max} characters`);
  return value.trim();
};
const role = (user, allowed) => { if (!allowed.includes(user.role)) throw invalid('This role cannot change CAM rules', 403); };
async function audit(client, user, action, id, detail) {
  await client.query('INSERT INTO audit_events(account_id,actor,action,object_type,object_reference,detail) VALUES($1,$2,$3,$4,$5,$6)',
    [user.account_id, user.email, action, 'cam_rule', String(id), JSON.stringify(detail)]);
}
function citedQuote(source, quote, label) {
  const exact = valueText(quote, label, 12, 5000);
  if (!source.content.includes(exact)) throw invalid(`${label} must be an exact excerpt of the saved source text`);
  return exact;
}
function citedNumber(quote, value, label) {
  const numbers = quote.match(/\d+(?:,\d{3})*(?:\.\d+)?/g) || [];
  if (!numbers.some(token => Math.abs(Number(token.replaceAll(',', '')) - Number(value)) < 0.000001))
    throw invalid(`${label} must appear numerically in the exact cited quote`);
}
async function sourceEvidence(queryable, source) {
  if (sha256(source.content) !== String(source.content_hash).trim())
    throw invalid('Saved CAM source text checksum mismatch', 409);
  const original = (await queryable.query(
    'SELECT * FROM cam_source_originals WHERE account_id=$1 AND source_id=$2', [source.account_id, source.id]
  )).rows[0];
  return { original, verified: verifiedCamOriginal(source, original) };
}

export function mountCamRoutes(app, { pool, auth }) {
  app.get('/api/cam/cases', auth, async (req, res, next) => {
    try {
      const items = (await pool.query(`SELECT id,reference,title,payload->>'statementReference' AS statement_reference
        FROM feature_records WHERE account_id=$1 AND feature_id='statement-ingestion' AND coalesce(payload->>'__example','false')<>'true'
        ORDER BY updated_at DESC,id DESC LIMIT 200`, [req.user.account_id])).rows;
      res.json({ items });
    } catch (error) { next(error); }
  });

  app.get('/api/cam/sources', auth, async (req, res, next) => {
    try {
      const items = (await pool.query(`SELECT source.id,source.source_kind,source.title,source.content_hash,
        source.created_by_id,source.created_at,original.original_sha256,original.page_count
        FROM cam_sources source LEFT JOIN cam_source_originals original
          ON original.source_id=source.id AND original.account_id=source.account_id
        WHERE source.account_id=$1 ORDER BY source.id DESC LIMIT 200`, [req.user.account_id])).rows;
      res.json({ items });
    } catch (error) { next(error); }
  });
  app.get('/api/cam/sources/:id', auth, async (req, res, next) => {
    try {
      const source = (await pool.query('SELECT * FROM cam_sources WHERE account_id=$1 AND id=$2', [req.user.account_id, integerId(req.params.id)])).rows[0];
      if (!source) throw invalid('CAM source not found', 404);
      const evidence = await sourceEvidence(pool, source);
      res.json({ source: { ...source, original: evidence.verified } });
    } catch (error) { next(error); }
  });
  app.get('/api/cam/sources/:id/original', auth, async (req, res, next) => {
    try {
      const source = (await pool.query('SELECT * FROM cam_sources WHERE account_id=$1 AND id=$2',
        [req.user.account_id, integerId(req.params.id)])).rows[0];
      if (!source) throw invalid('CAM source not found', 404);
      const evidence = await sourceEvidence(pool, source);
      if (!evidence.original) throw invalid('No PDF original was stored for this source', 404);
      res.set({ 'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="${evidence.original.filename}"`,
        'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' })
        .send(evidence.original.original_bytes);
    } catch (error) { next(error); }
  });
  app.post('/api/cam/sources/pdf', auth, express.raw({ type: 'application/pdf', limit: '5mb', inflate: false }), async (req, res, next) => {
    let client;
    try {
      role(req.user, ['admin', 'operator']);
      const sourceKind = String(req.query.sourceKind || '').toUpperCase();
      if (!['LEASE', 'AMENDMENT', 'PRIOR_STATEMENT'].includes(sourceKind)) throw invalid('Choose a lease, amendment, or prior statement source');
      const title = valueText(req.query.title, 'Source title', 3, 200);
      const filename = String(req.headers['x-source-filename'] || 'source.pdf').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120) || 'source.pdf';
      const extracted = await extractCamPdf(req.body);
      client = await pool.connect(); await client.query('BEGIN');
      const source = (await client.query(`INSERT INTO cam_sources(account_id,source_kind,title,content,content_hash,created_by_id)
        VALUES($1,$2,$3,$4,$5,$6) RETURNING *`,
      [req.user.account_id, sourceKind, title, extracted.content, extracted.textSha256, req.user.id])).rows[0];
      await client.query(`INSERT INTO cam_source_originals
        (source_id,account_id,filename,media_type,original_bytes,original_sha256,text_sha256,page_count,page_spans,extraction_method,created_by_id)
        VALUES($1,$2,$3,'application/pdf',$4,$5,$6,$7,$8::jsonb,$9,$10)`,
      [source.id, req.user.account_id, filename, req.body, extracted.originalSha256, extracted.textSha256,
        extracted.pageCount, JSON.stringify(extracted.pages), extracted.method, req.user.id]);
      await audit(client, req.user, 'cam_pdf_source_saved', source.id,
        { title, sourceKind, originalSha256: extracted.originalSha256, textSha256: extracted.textSha256,
          pageCount: extracted.pageCount, scope: 'Uploaded PDF bytes and derived text; signature and governing authority unverified' });
      await client.query('COMMIT');
      res.status(201).json({ source: { id: source.id, source_kind: source.source_kind, title: source.title,
        content_hash: source.content_hash, original_sha256: extracted.originalSha256,
        page_count: extracted.pageCount, page_spans: extracted.pages } });
    } catch (error) { if (client) await client.query('ROLLBACK'); next(error); }
    finally { client?.release(); }
  });
  app.post('/api/cam/sources', auth, async (req, res, next) => {
    let client;
    try {
      role(req.user, ['admin', 'operator']);
      const sourceKind = String(req.body?.sourceKind || '').toUpperCase();
      if (!['LEASE', 'AMENDMENT', 'PRIOR_STATEMENT'].includes(sourceKind)) throw invalid('Choose a lease, amendment, or prior statement source');
      const title = valueText(req.body?.title, 'Source title', 3, 200);
      const content = valueText(req.body?.content, 'Extracted source text', 30, 500000);
      const hash = createHash('sha256').update(content).digest('hex');
      client = await pool.connect(); await client.query('BEGIN');
      const source = (await client.query(`INSERT INTO cam_sources(account_id,source_kind,title,content,content_hash,created_by_id)
        VALUES($1,$2,$3,$4,$5,$6) RETURNING id,source_kind,title,content_hash,created_by_id,created_at`,
      [req.user.account_id, sourceKind, title, content, hash, req.user.id])).rows[0];
      await audit(client, req.user, 'cam_source_saved', source.id, { title, sourceKind, hash, scope: 'Operator-supplied extracted text; original document authenticity not verified' });
      await client.query('COMMIT'); res.status(201).json({ source });
    } catch (error) { if (client) await client.query('ROLLBACK'); next(error); }
    finally { client?.release(); }
  });

  app.get('/api/cam/rules', auth, async (req, res, next) => {
    try {
      const items = (await pool.query(`SELECT rule.*,source.title AS source_title,source.content_hash AS source_hash,
        source_original.original_sha256 AS source_original_sha256,
        prior.title AS prior_source_title,prior.content_hash AS prior_source_hash,
        prior_original.original_sha256 AS prior_original_sha256
        FROM cam_rules rule JOIN cam_sources source ON source.id=rule.source_id AND source.account_id=rule.account_id
        LEFT JOIN cam_sources prior ON prior.id=rule.prior_source_id AND prior.account_id=rule.account_id
        LEFT JOIN cam_source_originals source_original ON source_original.source_id=source.id AND source_original.account_id=source.account_id
        LEFT JOIN cam_source_originals prior_original ON prior_original.source_id=prior.id AND prior_original.account_id=prior.account_id
        WHERE rule.account_id=$1 ORDER BY rule.created_at DESC,rule.id DESC LIMIT 200`, [req.user.account_id])).rows;
      res.json({ items });
    } catch (error) { next(error); }
  });
  app.post('/api/cam/rules', auth, async (req, res, next) => {
    let client;
    try {
      role(req.user, ['admin', 'operator']);
      const body = req.body || {};
      const caseReference = valueText(body.caseReference, 'CAM case reference', 5, 200);
      const leaseReference = valueText(body.leaseReference, 'Lease reference', 3, 200);
      const leaseYear = Number(body.leaseYear);
      if (!Number.isSafeInteger(leaseYear) || leaseYear < 2000 || leaseYear > 2100) throw invalid('Choose one lease year from 2000–2100');
      const categoryLabel = valueText(body.category, 'Exact statement expense category', 2, 200);
      const category = categoryKey(categoryLabel);
      const ruleType = String(body.ruleType || '').toUpperCase();
      if (!['EXCLUSION', 'PRO_RATA', 'CATEGORY_CAP'].includes(ruleType)) throw invalid('Unsupported CAM rule type');
      const clauseLocator = valueText(body.clauseLocator, 'Lease section or page', 2, 200);
      const sourceId = integerId(body.sourceId);
      const priorSourceId = ruleType === 'CATEGORY_CAP' ? integerId(body.priorSourceId) : null;
      let tenantArea = null, propertyArea = null, capUnits = null, priorCents = null;
      if (ruleType !== 'EXCLUSION') {
        tenantArea = area(body.tenantAreaSqFt, 'Tenant premises area');
        propertyArea = area(body.propertyAreaSqFt, 'Property allocation area');
        if (tenantArea > propertyArea) throw invalid('Tenant area cannot exceed property allocation area');
      }
      if (ruleType === 'CATEGORY_CAP') {
        capUnits = percentUnits(body.capPercent);
        priorCents = amount(body.priorYearAllowedAmount, 'Prior-year allowed category amount');
      }
      client = await pool.connect(); await client.query('BEGIN');
      const caseRow = (await client.query(`SELECT id FROM feature_records WHERE account_id=$1 AND feature_id='statement-ingestion'
        AND reference=$2 AND coalesce(payload->>'__example','false')<>'true'`, [req.user.account_id, caseReference])).rows[0];
      if (!caseRow) throw invalid('Create a real landlord statement case in this customer account first', 409);
      const source = (await client.query('SELECT * FROM cam_sources WHERE account_id=$1 AND id=$2', [req.user.account_id, sourceId])).rows[0];
      if (!source || !['LEASE', 'AMENDMENT'].includes(source.source_kind)) throw invalid('Select a saved lease or amendment source in this customer account', 409);
      const sourceEvidenceResult = await sourceEvidence(client, source);
      const sourceQuote = citedQuote(source, body.sourceQuote, 'Lease clause quote');
      const sourcePage = citedPdfPage(source, sourceEvidenceResult.verified, sourceQuote, body.sourcePage, 'Lease clause quote');
      if (ruleType !== 'EXCLUSION') {
        citedNumber(sourceQuote, tenantArea, 'Tenant area');
        citedNumber(sourceQuote, propertyArea, 'Property area');
      }
      if (ruleType === 'CATEGORY_CAP') citedNumber(sourceQuote, capUnits / 10000, 'Annual category cap percentage');
      let priorSource = null, priorQuote = null, priorPage = null, priorEvidenceResult = null;
      if (priorSourceId) {
        priorSource = (await client.query('SELECT * FROM cam_sources WHERE account_id=$1 AND id=$2', [req.user.account_id, priorSourceId])).rows[0];
        if (!priorSource || priorSource.source_kind !== 'PRIOR_STATEMENT') throw invalid('Category caps require a saved prior-year statement source', 409);
        priorEvidenceResult = await sourceEvidence(client, priorSource);
        priorQuote = citedQuote(priorSource, body.priorSourceQuote, 'Prior-year statement quote');
        priorPage = citedPdfPage(priorSource, priorEvidenceResult.verified, priorQuote, body.priorSourcePage, 'Prior-year statement quote');
        citedNumber(priorQuote, priorCents / 100, 'Prior-year allowed category amount');
      }
      const version = Number((await client.query(`SELECT coalesce(max(version),0)+1 AS version FROM cam_rules
        WHERE account_id=$1 AND case_reference=$2 AND lease_year=$3 AND category_key=$4`,
      [req.user.account_id, caseReference, leaseYear, category])).rows[0].version);
      const rule = (await client.query(`INSERT INTO cam_rules(account_id,case_reference,lease_reference,lease_year,category_key,category_label,
        rule_type,tenant_area_sq_ft,property_area_sq_ft,cap_percent_units,prior_year_allowed_cents,
        source_id,source_quote,clause_locator,prior_source_id,prior_source_quote,version,created_by_id,source_page,prior_source_page)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20) RETURNING *`,
      [req.user.account_id, caseReference, leaseReference, leaseYear, category, categoryLabel, ruleType,
        tenantArea, propertyArea, capUnits, priorCents, sourceId, sourceQuote, clauseLocator, priorSourceId, priorQuote,
        version, req.user.id, sourcePage, priorPage])).rows[0];
      await audit(client, req.user, 'cam_rule_drafted', rule.id, { version, caseReference, leaseYear, category, ruleType,
        sourceHash: source.content_hash, sourceOriginalSha256: sourceEvidenceResult.verified?.originalSha256 ?? null, sourcePage,
        priorSourceHash: priorSource?.content_hash ?? null,
        priorOriginalSha256: priorEvidenceResult?.verified?.originalSha256 ?? null, priorPage });
      await client.query('COMMIT'); res.status(201).json({ rule });
    } catch (error) { if (client) await client.query('ROLLBACK'); next(error.code === '23505' ? invalid('This rule version was created concurrently; reload and retry', 409) : error); }
    finally { client?.release(); }
  });

  app.post('/api/cam/rules/:id/approve', auth, async (req, res, next) => {
    let client;
    try {
      role(req.user, ['admin', 'reviewer']);
      const id = integerId(req.params.id);
      const rationale = valueText(req.body?.rationale, 'Independent review rationale', 20, 2000);
      client = await pool.connect(); await client.query('BEGIN');
      const rule = (await client.query('SELECT * FROM cam_rules WHERE account_id=$1 AND id=$2 FOR UPDATE', [req.user.account_id, id])).rows[0];
      if (!rule) throw invalid('CAM rule not found', 404);
      if (rule.status !== 'DRAFT') throw invalid('Only a draft rule can be approved', 409);
      if (String(rule.created_by_id) === String(req.user.id)) throw invalid('The rule creator cannot approve their own rule', 403);
      const source = (await client.query('SELECT * FROM cam_sources WHERE account_id=$1 AND id=$2',
        [req.user.account_id, rule.source_id])).rows[0];
      if (!source) throw invalid('Lease source missing', 409);
      const sourceEvidenceResult = await sourceEvidence(client, source);
      citedQuote(source, rule.source_quote, 'Lease clause quote');
      citedPdfPage(source, sourceEvidenceResult.verified, rule.source_quote, rule.source_page, 'Lease clause quote');
      let priorEvidenceResult = null;
      if (rule.prior_source_id) {
        const priorSource = (await client.query('SELECT * FROM cam_sources WHERE account_id=$1 AND id=$2',
          [req.user.account_id, rule.prior_source_id])).rows[0];
        if (!priorSource) throw invalid('Prior-year statement source missing', 409);
        priorEvidenceResult = await sourceEvidence(client, priorSource);
        citedQuote(priorSource, rule.prior_source_quote, 'Prior-year statement quote');
        citedPdfPage(priorSource, priorEvidenceResult.verified, rule.prior_source_quote, rule.prior_source_page, 'Prior-year statement quote');
      }
      if ((sourceEvidenceResult.verified || priorEvidenceResult?.verified) && req.body?.originalReviewed !== true)
        throw invalid('Reviewer must confirm inspection of the stored PDF original', 422);
      await client.query(`UPDATE cam_rules SET status='SUPERSEDED' WHERE account_id=$1 AND case_reference=$2 AND lease_year=$3
        AND category_key=$4 AND status='APPROVED'`, [req.user.account_id, rule.case_reference, rule.lease_year, rule.category_key]);
      const approved = (await client.query(`UPDATE cam_rules SET status='APPROVED',approved_by_id=$1,approved_at=now()
        WHERE id=$2 AND account_id=$3 RETURNING *`, [req.user.id, id, req.user.account_id])).rows[0];
      await audit(client, req.user, 'cam_rule_approved', id, { version: rule.version, rationale,
        originalReviewed: Boolean(sourceEvidenceResult.verified || priorEvidenceResult?.verified),
        sourceOriginalSha256: sourceEvidenceResult.verified?.originalSha256 ?? null,
        priorOriginalSha256: priorEvidenceResult?.verified?.originalSha256 ?? null,
        scope: 'Independent approval of uploaded or operator-supplied source and calculation terms; landlord acceptance not verified' });
      await client.query('COMMIT'); res.json({ rule: approved });
    } catch (error) { if (client) await client.query('ROLLBACK'); next(error.code === '23505' ? invalid('Another rule version was approved concurrently; reload', 409) : error); }
    finally { client?.release(); }
  });

  app.get('/api/cam/rules/:id/assessments', auth, async (req, res, next) => {
    try {
      const ruleId = integerId(req.params.id);
      const rule = (await pool.query('SELECT id FROM cam_rules WHERE account_id=$1 AND id=$2', [req.user.account_id, ruleId])).rows[0];
      if (!rule) throw invalid('CAM rule not found', 404);
      const items = (await pool.query(`SELECT assessment.*,line.source_file,line.line_number,line.checksum,line.description,line.amount,
        line.statement_date,line.currency FROM cam_assessments assessment
        JOIN statement_lines line ON line.id=assessment.statement_line_id AND line.account_id=assessment.account_id
        WHERE assessment.account_id=$1 AND assessment.rule_id=$2 ORDER BY assessment.id DESC LIMIT 500`,
      [req.user.account_id, ruleId])).rows;
      res.json({ items });
    } catch (error) { next(error); }
  });
  app.post('/api/cam/rules/:id/assess', auth, async (req, res, next) => {
    let client;
    try {
      role(req.user, ['admin', 'operator', 'reviewer']);
      const id = integerId(req.params.id);
      client = await pool.connect(); await client.query('BEGIN');
      const rule = (await client.query(`SELECT rule.*,source.content_hash AS source_hash,prior.content_hash AS prior_source_hash
        FROM cam_rules rule JOIN cam_sources source ON source.id=rule.source_id AND source.account_id=rule.account_id
        LEFT JOIN cam_sources prior ON prior.id=rule.prior_source_id AND prior.account_id=rule.account_id
        WHERE rule.account_id=$1 AND rule.id=$2 FOR UPDATE OF rule`, [req.user.account_id, id])).rows[0];
      if (!rule) throw invalid('CAM rule not found', 404);
      if (rule.status !== 'APPROVED') throw invalid('Only an approved rule can assess imported lines', 409);
      if (rule.rule_type === 'CATEGORY_CAP') {
        const count = (await client.query(`SELECT count(*)::int AS total FROM statement_lines line
          WHERE line.account_id=$1 AND line.feature_id='statement-ingestion' AND line.record_reference=$2
          AND line.statement_date BETWEEN $3 AND $4 AND line.reconciliation_status NOT IN ('rejected','credit_line')
          AND lower(trim(regexp_replace(coalesce(nullif(line.provenance->>'expenseCategory',''),line.description),'[[:space:]]+',' ','g')))=$5`,
        [req.user.account_id, rule.case_reference, `${rule.lease_year}-01-01`, `${rule.lease_year}-12-31`, rule.category_key])).rows[0].total;
        if (count > 1) throw invalid('A category cap requires one imported annual total line for this case, year, and expense category', 409);
      }
      const lines = (await client.query(`SELECT line.* FROM statement_lines line
        LEFT JOIN cam_assessments prior ON prior.statement_line_id=line.id AND prior.rule_id=$6 AND prior.account_id=line.account_id
        WHERE line.account_id=$1 AND line.feature_id='statement-ingestion' AND line.record_reference=$2
        AND line.statement_date BETWEEN $3 AND $4 AND line.reconciliation_status NOT IN ('rejected','credit_line')
        AND lower(trim(regexp_replace(coalesce(nullif(line.provenance->>'expenseCategory',''),line.description),'[[:space:]]+',' ','g')))=$5
        AND prior.id IS NULL ORDER BY line.id LIMIT 1001`,
      [req.user.account_id, rule.case_reference, `${rule.lease_year}-01-01`, `${rule.lease_year}-12-31`, rule.category_key, rule.id])).rows;
      const hasMore = lines.length > 1000;
      let assessed = 0;
      for (const line of lines.slice(0, 1000)) {
        const result = assessCamLine(rule, line);
        const saved = await client.query(`INSERT INTO cam_assessments(account_id,rule_id,statement_line_id,observed_cents,expected_cents,variance_cents,status,calculation)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(rule_id,statement_line_id) DO NOTHING RETURNING id`,
        [req.user.account_id, rule.id, line.id, result.observedCents, result.expectedCents, result.varianceCents,
          result.status, { ...result.calculation, leaseSourceId: rule.source_id, leaseSourceHash: rule.source_hash,
            priorSourceId: rule.prior_source_id, priorSourceHash: rule.prior_source_hash, clauseLocator: rule.clause_locator }]);
        if (saved.rowCount) assessed++;
      }
      if (assessed) await audit(client, req.user, 'cam_lines_assessed', id, { version: rule.version, assessed, scope: 'Immutable candidate calculations from imported lines; no landlord credit verified' });
      await client.query('COMMIT'); res.json({ ruleId: id, newAssessments: assessed, reviewedLines: Math.min(lines.length, 1000), hasMore });
    } catch (error) { if (client) await client.query('ROLLBACK'); next(error); }
    finally { client?.release(); }
  });
}
