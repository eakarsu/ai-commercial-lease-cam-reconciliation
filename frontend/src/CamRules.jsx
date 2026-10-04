import React, { useEffect, useState } from 'react';

const money = cents => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(Number(cents || 0) / 100);
const input = 'secondary';
export default function CamRules({ request, notify, user, onSaved }) {
  const [cases, setCases] = useState([]);
  const [sources, setSources] = useState([]);
  const [rules, setRules] = useState([]);
  const [selectedSource, setSelectedSource] = useState(null);
  const [selectedRule, setSelectedRule] = useState(null);
  const [assessments, setAssessments] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [sourceForm, setSourceForm] = useState({ sourceKind: 'LEASE', title: '', content: '' });
  const [pdfForm, setPdfForm] = useState({ sourceKind: 'LEASE', title: '' });
  const [pdfFile, setPdfFile] = useState(null);
  const [originalReviewed, setOriginalReviewed] = useState(false);
  const [ruleForm, setRuleForm] = useState({ caseReference: '', leaseReference: '', leaseYear: '2026', category: '', ruleType: 'EXCLUSION',
    sourceId: '', sourceQuote: '', sourcePage: '', clauseLocator: '', tenantAreaSqFt: '', propertyAreaSqFt: '', capPercent: '', priorYearAllowedAmount: '', priorSourceId: '', priorSourceQuote: '', priorSourcePage: '' });
  const [rationale, setRationale] = useState('');
  async function load() {
    const [caseData, sourceData, ruleData] = await Promise.all([
      request('/api/cam/cases'), request('/api/cam/sources'), request('/api/cam/rules'),
    ]);
    setCases(caseData.items || []); setSources(sourceData.items || []); setRules(ruleData.items || []);
  }
  useEffect(() => { load().catch(err => setError(err.message)); }, []);
  async function act(work) {
    setBusy(true); setError('');
    try { await work(); await load(); await onSaved(); }
    catch (err) { setError(err.message); }
    finally { setBusy(false); }
  }
  async function viewSource(id) {
    setBusy(true); setError('');
    try { setSelectedSource((await request(`/api/cam/sources/${id}`)).source); }
    catch (err) { setError(err.message); }
    finally { setBusy(false); }
  }
  async function viewRule(rule) {
    setSelectedRule(rule); setOriginalReviewed(false); setError('');
    try { setAssessments((await request(`/api/cam/rules/${rule.id}/assessments`)).items || []); }
    catch (err) { setError(err.message); }
  }
  async function downloadOriginal(source) {
    setError('');
    try {
      const response = await fetch(`/api/cam/sources/${source.id}/original`, {
        headers: { Authorization: `Bearer ${localStorage.getItem('domain_recovery_token') || ''}` },
      });
      if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || 'PDF original unavailable');
      const url = URL.createObjectURL(await response.blob());
      const anchor = document.createElement('a');
      anchor.href = url; anchor.download = `${source.title.replace(/[^A-Za-z0-9._-]/g, '_')}.pdf`; anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (err) { setError(err.message); }
  }
  const canDraft = ['admin', 'operator'].includes(user.role);
  const canReview = ['admin', 'reviewer'].includes(user.role);
  const leaseSources = sources.filter(source => ['LEASE', 'AMENDMENT'].includes(source.source_kind));
  const priorSources = sources.filter(source => source.source_kind === 'PRIOR_STATEMENT');
  return <>
    <header className="pageTitle"><div><span className="eyebrow">Lease year and source evidence</span><h2>CAM lease rules</h2><p>Save extracted source text, draft an exact category rule for one case and lease year, obtain a different reviewer’s approval, then assess imported landlord statement lines. Calculations are candidate variances; no landlord credit is verified.</p></div></header>
    {error && <p className="error" role="alert">{error}</p>}
    <section className="panel"><h3>1. Save source evidence</h3><p>Upload a PDF original, or paste text from a lease, amendment, or prior-year landlord statement. Both paths keep an immutable text hash. A PDF path also keeps the exact file bytes, file hash, and page offsets. Scanned pages use OCR; verify every OCR quote against the original. Confirm the document is the governing signed source before approving a rule.</p>
      <form onSubmit={event => { event.preventDefault(); act(async () => {
        if (!pdfFile) throw new Error('Choose a PDF original.');
        const query = new URLSearchParams({ sourceKind: pdfForm.sourceKind, title: pdfForm.title });
        const saved = await request(`/api/cam/sources/pdf?${query}`, { method: 'POST',
          headers: { 'Content-Type': 'application/pdf', 'X-Source-Filename': pdfFile.name.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120) || 'source.pdf' }, body: pdfFile });
        setPdfForm({ sourceKind: 'LEASE', title: '' }); setPdfFile(null);
        notify(`PDF original saved with file and text hashes across ${saved.source.page_count} page(s).`);
      }); }}>
        <div className="formGrid"><label>PDF source type<select value={pdfForm.sourceKind} onChange={event => setPdfForm({ ...pdfForm, sourceKind: event.target.value })}><option>LEASE</option><option>AMENDMENT</option><option>PRIOR_STATEMENT</option></select></label><label>PDF document title<input required minLength={3} maxLength={200} value={pdfForm.title} onChange={event => setPdfForm({ ...pdfForm, title: event.target.value })}/></label></div>
        <label>PDF original, up to five pages and 5 MiB<input type="file" required accept=".pdf,application/pdf" onChange={event => setPdfFile(event.target.files?.[0] || null)}/></label>
        <button className="primary" disabled={busy || !canDraft || !pdfFile}>Upload PDF original</button>
      </form>
      <h4>Or paste extracted text</h4>
      <form onSubmit={event => { event.preventDefault(); act(async () => { await request('/api/cam/sources', { method: 'POST', body: JSON.stringify(sourceForm) }); setSourceForm({ sourceKind: 'LEASE', title: '', content: '' }); notify('Source text saved with its checksum.'); }); }}>
        <div className="formGrid"><label>Source type<select value={sourceForm.sourceKind} onChange={event => setSourceForm({ ...sourceForm, sourceKind: event.target.value })}><option>LEASE</option><option>AMENDMENT</option><option>PRIOR_STATEMENT</option></select></label><label>Document title<input required minLength={3} maxLength={200} value={sourceForm.title} onChange={event => setSourceForm({ ...sourceForm, title: event.target.value })}/></label></div>
        <label>Extracted source text<textarea required minLength={30} maxLength={500000} rows={7} value={sourceForm.content} onChange={event => setSourceForm({ ...sourceForm, content: event.target.value })}/></label>
        <button className="primary" disabled={busy || !canDraft}>Save source</button>
      </form>
      {sources.length > 0 && <div className="tableWrap"><table><thead><tr><th>Source</th><th>Type</th><th>Checksum</th><th>Original</th></tr></thead><tbody>{sources.map(source => <tr key={source.id}><td><button className={input} onClick={() => viewSource(source.id)}>{source.title}</button></td><td>{source.source_kind}</td><td><code>{source.content_hash.slice(0, 20)}…</code></td><td>{source.original_sha256 ? <button className={input} onClick={() => downloadOriginal(source)}>Download PDF</button> : 'Pasted text'}</td></tr>)}</tbody></table></div>}
      {selectedSource && <details open><summary>{selectedSource.title} · saved text</summary>{selectedSource.original && <p>Original PDF SHA-256: <code>{selectedSource.original.originalSha256}</code> · text SHA-256: <code>{selectedSource.original.textSha256}</code> · pages: {selectedSource.original.pages.map(page => `${page.page} (${page.recognition || 'text layer'}) [${page.start}–${page.end}]`).join(', ')} <button className={input} onClick={() => downloadOriginal(selectedSource)}>Download exact original</button></p>}<pre style={{ whiteSpace: 'pre-wrap' }}>{selectedSource.content}</pre></details>}
    </section>
    <section className="panel"><h3>2. Draft a lease-year rule</h3><p>Use an exact expense category from the imported statement. Exclusion permits $0; pro-rata uses property expense × tenant area ÷ property area; a category cap limits that share to the cited prior-year tenant allowed category amount plus the lease cap percentage. For a cap, import one annual category total line for that case and year.</p>
      {cases.length === 0 && <p>Create a real case under <strong>Landlord Statement Ingestion</strong> before drafting a rule. Example cases cannot support claims.</p>}
      <form onSubmit={event => { event.preventDefault(); act(async () => { const data = await request('/api/cam/rules', { method: 'POST', body: JSON.stringify(ruleForm) }); notify(`Rule version ${data.rule.version} drafted for independent review.`); }); }}>
        <div className="formGrid">
          <label>Statement case<select required value={ruleForm.caseReference} onChange={event => setRuleForm({ ...ruleForm, caseReference: event.target.value })}><option value="">Select a real case</option>{cases.map(item => <option key={item.id} value={item.reference}>{item.reference} · {item.title}</option>)}</select></label>
          <label>Lease reference<input required minLength={3} maxLength={200} value={ruleForm.leaseReference} onChange={event => setRuleForm({ ...ruleForm, leaseReference: event.target.value })}/></label>
          <label>Lease year<input type="number" min={2000} max={2100} required value={ruleForm.leaseYear} onChange={event => setRuleForm({ ...ruleForm, leaseYear: event.target.value })}/></label>
          <label>Exact expense category<input required minLength={2} maxLength={200} value={ruleForm.category} onChange={event => setRuleForm({ ...ruleForm, category: event.target.value })}/></label>
          <label>Rule type<select value={ruleForm.ruleType} onChange={event => setRuleForm({ ...ruleForm, ruleType: event.target.value })}><option value="EXCLUSION">Lease exclusion</option><option value="PRO_RATA">Pro-rata share</option><option value="CATEGORY_CAP">Category cap and pro-rata</option></select></label>
          <label>Lease or amendment source<select required value={ruleForm.sourceId} onChange={event => setRuleForm({ ...ruleForm, sourceId: event.target.value, sourcePage: '' })}><option value="">Choose source</option>{leaseSources.map(source => <option key={source.id} value={source.id}>{source.title}{source.original_sha256 ? ' · PDF original' : ' · pasted text'}</option>)}</select></label>
          <label>Clause page or section<input required minLength={2} maxLength={200} value={ruleForm.clauseLocator} onChange={event => setRuleForm({ ...ruleForm, clauseLocator: event.target.value })}/></label>
          {sources.find(source => String(source.id) === String(ruleForm.sourceId))?.original_sha256 && <label>Exact PDF clause page<input required type="number" min={1} max={5} step={1} value={ruleForm.sourcePage} onChange={event => setRuleForm({ ...ruleForm, sourcePage: event.target.value })}/></label>}
        </div>
        <label>Exact lease clause quote<textarea required minLength={12} maxLength={5000} rows={3} value={ruleForm.sourceQuote} onChange={event => setRuleForm({ ...ruleForm, sourceQuote: event.target.value })}/></label>
        {ruleForm.ruleType !== 'EXCLUSION' && <div className="formGrid"><label>Tenant premises square feet<input required type="number" min={1} step={1} value={ruleForm.tenantAreaSqFt} onChange={event => setRuleForm({ ...ruleForm, tenantAreaSqFt: event.target.value })}/></label><label>Property allocation square feet<input required type="number" min={1} step={1} value={ruleForm.propertyAreaSqFt} onChange={event => setRuleForm({ ...ruleForm, propertyAreaSqFt: event.target.value })}/></label></div>}
        {ruleForm.ruleType === 'CATEGORY_CAP' && <><div className="formGrid"><label>Annual category cap percentage<input required type="number" min={0} max={100} step="0.0001" value={ruleForm.capPercent} onChange={event => setRuleForm({ ...ruleForm, capPercent: event.target.value })}/></label><label>Prior-year tenant allowed category amount<input required type="number" min={0} step="0.01" value={ruleForm.priorYearAllowedAmount} onChange={event => setRuleForm({ ...ruleForm, priorYearAllowedAmount: event.target.value })}/></label><label>Prior-year statement source<select required value={ruleForm.priorSourceId} onChange={event => setRuleForm({ ...ruleForm, priorSourceId: event.target.value, priorSourcePage: '' })}><option value="">Choose source</option>{priorSources.map(source => <option key={source.id} value={source.id}>{source.title}{source.original_sha256 ? ' · PDF original' : ' · pasted text'}</option>)}</select></label>{sources.find(source => String(source.id) === String(ruleForm.priorSourceId))?.original_sha256 && <label>Prior statement PDF page<input required type="number" min={1} max={5} step={1} value={ruleForm.priorSourcePage} onChange={event => setRuleForm({ ...ruleForm, priorSourcePage: event.target.value })}/></label>}</div><label>Exact prior-year statement quote<textarea required minLength={12} maxLength={5000} rows={3} value={ruleForm.priorSourceQuote} onChange={event => setRuleForm({ ...ruleForm, priorSourceQuote: event.target.value })}/></label></>}
        <button className="primary" disabled={busy || !canDraft || !cases.length}>Save draft version</button>
      </form>
    </section>
    <section className="panel"><h3>3. Review and assess imported lines</h3><p>A different administrator or reviewer approves the quoted rule. Assessments retain rule version, source hashes, line checksum and exact arithmetic. Superseded versions remain visible.</p>
      {rules.length ? <div className="tableWrap"><table><thead><tr><th>Case/year/category</th><th>Type</th><th>Version</th><th>Status</th><th>Source</th><th></th></tr></thead><tbody>{rules.map(rule => <tr key={rule.id}><td>{rule.case_reference} · {rule.lease_year} · {rule.category_label}</td><td>{rule.rule_type}</td><td>{rule.version}</td><td>{rule.status}</td><td>{rule.source_title} §{rule.clause_locator}</td><td><button className={input} disabled={busy} onClick={() => viewRule(rule)}>Inspect</button></td></tr>)}</tbody></table></div> : <p>No lease rules drafted.</p>}
      {selectedRule && <article className="panel"><h4>Rule {selectedRule.id} · version {selectedRule.version}</h4><p><strong>{selectedRule.status}</strong> · {selectedRule.lease_reference} · {selectedRule.category_label}</p><p>Lease source SHA-256: <code>{selectedRule.source_hash}</code>{selectedRule.source_original_sha256 && <> · original PDF SHA-256 <code>{selectedRule.source_original_sha256}</code> · PDF page {selectedRule.source_page} <button className={input} onClick={() => downloadOriginal({ id: selectedRule.source_id, title: selectedRule.source_title })}>Download original</button></>}</p><blockquote>{selectedRule.source_quote}</blockquote>{selectedRule.prior_source_hash && <><p>Prior-year source SHA-256: <code>{selectedRule.prior_source_hash}</code>{selectedRule.prior_original_sha256 && <> · original PDF SHA-256 <code>{selectedRule.prior_original_sha256}</code> · PDF page {selectedRule.prior_source_page} <button className={input} onClick={() => downloadOriginal({ id: selectedRule.prior_source_id, title: selectedRule.prior_source_title })}>Download original</button></>}</p><blockquote>{selectedRule.prior_source_quote}</blockquote></>}
        {selectedRule.status === 'DRAFT' && <div>{(selectedRule.source_original_sha256 || selectedRule.prior_original_sha256) && <label><input type="checkbox" checked={originalReviewed} onChange={event => setOriginalReviewed(event.target.checked)}/> I inspected the stored PDF original and confirmed the cited page and clause</label>}<label>Independent review rationale<textarea minLength={20} maxLength={2000} rows={3} value={rationale} onChange={event => setRationale(event.target.value)}/></label><button className="primary" disabled={busy || !canReview || String(selectedRule.created_by_id) === String(user.id) || rationale.trim().length < 20 || ((selectedRule.source_original_sha256 || selectedRule.prior_original_sha256) && !originalReviewed)} onClick={() => act(async () => { await request(`/api/cam/rules/${selectedRule.id}/approve`, { method: 'POST', body: JSON.stringify({ rationale, originalReviewed }) }); notify('Rule approved by an independent reviewer.'); setRationale(''); setSelectedRule(null); })}>Approve rule version</button></div>}
        {selectedRule.status === 'APPROVED' && <button className="primary" disabled={busy} onClick={() => act(async () => { const result = await request(`/api/cam/rules/${selectedRule.id}/assess`, { method: 'POST', body: '{}' }); notify(`${result.newAssessments} new statement line assessments saved.${result.hasMore ? ' Run this step again for the remaining lines.' : ''}`); await viewRule(selectedRule); })}>Assess imported lines for this year/category</button>}
        {assessments.length > 0 && <div><h4>Latest 500 assessments</h4><div className="tableWrap"><table><thead><tr><th>Statement line</th><th>Charge</th><th>Rule amount</th><th>Signed variance</th><th>Status</th></tr></thead><tbody>{assessments.map(item => <tr key={item.id}><td>{item.source_file} #{item.line_number} · {item.description}</td><td>{money(item.observed_cents)}</td><td>{item.expected_cents == null ? 'Missing property amount' : money(item.expected_cents)}</td><td>{item.variance_cents == null ? '—' : money(item.variance_cents)}</td><td>{item.status}</td></tr>)}</tbody></table></div></div>}
      </article>}
    </section>
  </>;
}
