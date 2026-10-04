import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import bcrypt from 'bcryptjs';

function pdfWithTwoPages(first, second) {
  const draw = text => `BT /F1 12 Tf 72 720 Td (${text.replaceAll('\\', '\\\\').replaceAll('(', '\\(').replaceAll(')', '\\)')}) Tj ET`;
  const firstDraw = draw(first), secondDraw = draw(second);
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 6 0 R >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 7 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(firstDraw)} >>\nstream\n${firstDraw}\nendstream`,
    `<< /Length ${Buffer.byteLength(secondDraw)} >>\nstream\n${secondDraw}\nendstream`,
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  for (let i = 0; i < objects.length; i += 1) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, 'ascii');
}

async function scannedPdf(text) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'cam-ocr-fixture-'));
  try {
    const source = path.join(directory, 'text.pdf');
    const image = path.join(directory, 'page.png');
    const result = path.join(directory, 'scan.pdf');
    await writeFile(source, pdfWithTwoPages(text, 'Second page only for source generation.'));
    await promisify(execFile)('pdftoppm', ['-f', '1', '-l', '1', '-singlefile', '-scale-to', '1800', '-png', source, path.join(directory, 'page')]);
    await promisify(execFile)('magick', [image, result]);
    return await readFile(result);
  } finally { await rm(directory, { recursive: true, force: true }); }
}

test('CAM PDF originals bind quoted rules to exact pages and stay account scoped', {
  skip: !process.env.RECOVERY_INTEGRATION_DATABASE_URL,
}, async () => {
  process.env.DATABASE_URL = process.env.RECOVERY_INTEGRATION_DATABASE_URL;
  process.env.APP_TEST_NO_LISTEN = 'true';
  const { app, pool } = await import('./server.mjs');
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = async (path, token, body, method = body === undefined ? 'GET' : 'POST') => {
    const response = await fetch(base + path, {
      method,
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, data: await response.json() };
  };
  try {
    const password = `Pdf-${randomUUID()}`;
    const customers = [];
    const caseReference = `CASE-${randomUUID()}`;
    for (let i = 0; i < 2; i += 1) {
      const id = randomUUID(), adminEmail = `pdf-admin-${randomUUID()}@example.test`;
      const reviewerEmail = `pdf-reviewer-${randomUUID()}@example.test`;
      await pool.query('INSERT INTO customer_accounts(id,name) VALUES($1,$2)', [id, `Customer ${i}`]);
      for (const [email, role] of [[adminEmail, 'admin'], [reviewerEmail, 'reviewer']]) {
        await pool.query('INSERT INTO app_users(account_id,email,password_hash,name,role) VALUES($1,$2,$3,$4,$5)',
          [id, email, await bcrypt.hash(password, 4), role, role]);
      }
      await pool.query(`INSERT INTO feature_records(account_id,feature_id,reference,title,status,owner,risk,due_date,amount,payload)
        VALUES($1,'statement-ingestion',$2,'PDF source case','Open',$3,'Not assessed',current_date+30,0,'{}'::jsonb)`,
      [id, caseReference, adminEmail]);
      const admin = (await request('/api/auth/login', null, { email: adminEmail, password })).data.token;
      const reviewer = (await request('/api/auth/login', null, { email: reviewerEmail, password })).data.token;
      customers.push({ id, admin, reviewer });
    }
    const clause = 'Clause 8.4: taxes use 10 tenant feet / 100 property feet.';
    const bytes = pdfWithTwoPages('Opening lease text for the property and the 2026 CAM period.', clause);
    const originalSha = createHash('sha256').update(bytes).digest('hex');
    const uploadPath = '/api/cam/sources/pdf?sourceKind=LEASE&title=CAM%202026%20lease';
    const upload = async token => {
      const response = await fetch(base + uploadPath, { method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/pdf', 'X-Source-Filename': 'signed-lease.pdf' }, body: bytes });
      return { status: response.status, data: await response.json() };
    };
    const first = await upload(customers[0].admin);
    const second = await upload(customers[1].admin);
    assert.equal(first.status, 201, JSON.stringify(first.data));
    assert.equal(second.status, 201, JSON.stringify(second.data));
    assert.equal(first.data.source.original_sha256, originalSha);
    assert.equal(first.data.source.page_spans.length, 2);
    const sourceId = first.data.source.id;
    const source = await request(`/api/cam/sources/${sourceId}`, customers[0].reviewer);
    assert.equal(source.status, 200);
    assert.equal(source.data.source.original.pages[1].page, 2);
    assert.equal(source.data.source.content.includes(clause), true);
    assert.equal((await request(`/api/cam/sources/${sourceId}`, customers[1].admin)).status, 404);
    const downloaded = await fetch(base + `/api/cam/sources/${sourceId}/original`,
      { headers: { Authorization: `Bearer ${customers[0].reviewer}` } });
    assert.equal(downloaded.status, 200);
    assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), bytes);
    assert.equal((await fetch(base + `/api/cam/sources/${sourceId}/original`,
      { headers: { Authorization: `Bearer ${customers[1].admin}` } })).status, 404);
    const ruleInput = { caseReference, leaseReference: 'LEASE-2026', leaseYear: 2026,
      category: 'Property taxes', ruleType: 'PRO_RATA', tenantAreaSqFt: 10,
      propertyAreaSqFt: 100, sourceId, sourceQuote: clause, clauseLocator: 'PDF page 2', sourcePage: 2 };
    assert.equal((await request('/api/cam/rules', customers[0].admin, { ...ruleInput, sourcePage: 1 })).status, 422);
    assert.equal((await request('/api/cam/rules', customers[0].admin, { ...ruleInput, sourcePage: '' })).status, 422);
    assert.equal((await request('/api/cam/rules', customers[1].admin, ruleInput)).status, 409);
    const draft = await request('/api/cam/rules', customers[0].admin, ruleInput);
    assert.equal(draft.status, 201, JSON.stringify(draft.data));
    assert.equal(draft.data.rule.source_page, 2);
    const approvePath = `/api/cam/rules/${draft.data.rule.id}/approve`;
    const rationale = 'I inspected page 2 in the uploaded original PDF and checked the quoted allocation.';
    assert.equal((await request(approvePath, customers[0].admin, { rationale, originalReviewed: true })).status, 403);
    assert.equal((await request(approvePath, customers[0].reviewer, { rationale })).status, 422);
    assert.equal((await request(approvePath, customers[0].reviewer, { rationale, originalReviewed: true })).status, 200);
    const scannedBytes = await scannedPdf('Scanned lease clause limits the 2026 common area expense.');
    const scannedUpload = await fetch(base + uploadPath, { method: 'POST',
      headers: { Authorization: `Bearer ${customers[0].admin}`, 'Content-Type': 'application/pdf',
        'X-Source-Filename': 'scanned-lease.pdf' }, body: scannedBytes });
    assert.equal(scannedUpload.status, 201, await scannedUpload.text());
    const scannedJson = await request('/api/cam/sources', customers[0].admin);
    const scannedSource = scannedJson.data.items.find(item => item.original_sha256 === createHash('sha256').update(scannedBytes).digest('hex'));
    assert.ok(scannedSource);
    const scannedDetail = await request(`/api/cam/sources/${scannedSource.id}`, customers[0].reviewer);
    assert.equal(scannedDetail.data.source.original.pages[0].recognition, 'ocr');
    assert.match(scannedDetail.data.source.content, /Scanned lease clause limits the 2026 common area expense/i);
    await assert.rejects(pool.query('UPDATE cam_sources SET content=$1 WHERE id=$2', ['fabricated', sourceId]), /immutable/);
    await assert.rejects(pool.query('DELETE FROM cam_source_originals WHERE source_id=$1', [sourceId]), /immutable/);
  } finally {
    await new Promise(resolve => server.close(resolve));
    await pool.end();
  }
});
