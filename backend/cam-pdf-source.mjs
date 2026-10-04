import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify, TextDecoder } from 'node:util';
import { invalid } from './recovery-domain.mjs';

const execute = promisify(execFile);
const MAX_PAGES = 5;
const METHOD = 'pdftotext_utf8_v1';
const OCR_METHOD = 'tesseract_pdf_pages_v1';
export const sha256 = value => createHash('sha256').update(value).digest('hex');

async function run(program, args, timeout) {
  try {
    return (await execute(program, args, { encoding: 'buffer', timeout, maxBuffer: 2 * 1024 * 1024 })).stdout;
  } catch (error) {
    if (error.code === 'ENOENT') throw invalid('Local PDF text or OCR tools are unavailable', 503);
    if (error.killed || error.code === 'ETIMEDOUT') throw invalid('PDF text extraction timed out', 503);
    throw invalid('The uploaded PDF could not be read');
  }
}

export async function extractCamPdf(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 5 || bytes.length > 5 * 1024 * 1024 || bytes.subarray(0, 5).toString('ascii') !== '%PDF-')
    throw invalid('Upload a PDF original of at most 5 MiB');
  const directory = await mkdtemp(path.join(os.tmpdir(), 'cam-pdf-original-'));
  try {
    const sourcePath = path.join(directory, 'original.pdf');
    await writeFile(sourcePath, bytes, { mode: 0o600 });
    const info = (await run(process.env.CAM_PDFINFO_PATH || 'pdfinfo', [sourcePath], 10000)).toString('utf8');
    const pageCount = Number(/^Pages:\s*(\d+)\s*$/m.exec(info)?.[1]);
    if (!Number.isInteger(pageCount) || pageCount < 1 || pageCount > MAX_PAGES)
      throw invalid('PDF evidence supports 1 to 5 pages');
    const parts = [], pages = [];
    let usedOcr = false;
    let offset = 0;
    for (let page = 1; page <= pageCount; page += 1) {
      const output = await run(process.env.CAM_PDFTOTEXT_PATH || 'pdftotext',
        ['-f', String(page), '-l', String(page), '-layout', '-enc', 'UTF-8', sourcePath, '-'], 10000);
      let text;
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(output); }
      catch (_) { throw invalid('PDF text layer is not valid UTF-8'); }
      text = text.replace(/\r\n?/g, '\n').replace(/\f+$/g, '').trim();
      let recognition = 'text_layer';
      if (!text) {
        const imageStem = path.join(directory, `page-${page}`);
        await run(process.env.CAM_PDFTOPPM_PATH || 'pdftoppm',
          ['-f', String(page), '-l', String(page), '-singlefile', '-scale-to', '1800', '-png', sourcePath, imageStem], 30000);
        const language = process.env.CAM_OCR_LANGUAGE || 'eng';
        if (!/^[A-Za-z0-9_+]{1,64}$/.test(language)) throw invalid('CAM OCR language setting is invalid', 503);
        const recognized = await run(process.env.CAM_TESSERACT_PATH || 'tesseract',
          [`${imageStem}.png`, 'stdout', '-l', language], 30000);
        try { text = new TextDecoder('utf-8', { fatal: true }).decode(recognized); }
        catch (_) { throw invalid('CAM PDF OCR text is not valid UTF-8'); }
        text = text.replace(/\r\n?/g, '\n').replace(/\f+$/g, '').trim();
        recognition = 'ocr'; usedOcr = true;
      }
      if (/[\x00-\x08\x0B\x0E-\x1F]/.test(text)) throw invalid('PDF text layer contains unsupported controls');
      if (page > 1) offset += 2;
      pages.push({ page, start: offset, end: offset + text.length, recognition });
      parts.push(text); offset += text.length;
      if (offset > 500000) throw invalid('Extracted PDF text exceeds 500,000 characters');
    }
    const content = parts.join('\n\n');
    if (content.trim().length < 30) throw invalid('PDF needs at least 30 selectable or OCR text characters; review blank files manually');
    return { content, pageCount, pages, textSha256: sha256(content), originalSha256: sha256(bytes),
      method: usedOcr ? OCR_METHOD : METHOD };
  } finally { await rm(directory, { recursive: true, force: true }); }
}

export function verifiedCamOriginal(source, original) {
  if (!original) return null;
  const pages = original.page_spans;
  const count = Number(original.page_count);
  if (source.account_id !== original.account_id || Number(source.id) !== Number(original.source_id) ||
      original.media_type !== 'application/pdf' || ![METHOD, OCR_METHOD].includes(original.extraction_method) ||
      String(original.original_sha256).trim() !== sha256(original.original_bytes) ||
      String(original.text_sha256).trim() !== sha256(source.content) ||
      String(source.content_hash).trim() !== String(original.text_sha256).trim() ||
      !Number.isInteger(count) || count < 1 || count > MAX_PAGES || !Array.isArray(pages) || pages.length !== count)
    throw invalid('Saved CAM original and text evidence do not match', 409);
  let nextStart = 0;
  for (let index = 0; index < pages.length; index += 1) {
    const page = pages[index];
    if (page.page !== index + 1 || page.start !== nextStart || !Number.isInteger(page.end) ||
        (page.recognition !== undefined && !['ocr', 'text_layer'].includes(page.recognition)) ||
        page.end < page.start || page.end > source.content.length)
      throw invalid('Saved CAM PDF page offsets are invalid', 409);
    nextStart = page.end + (index < pages.length - 1 ? 2 : 0);
    if (index < pages.length - 1 && source.content.slice(page.end, nextStart) !== '\n\n')
      throw invalid('Saved CAM PDF page separator is invalid', 409);
  }
  if (nextStart !== source.content.length) throw invalid('Saved CAM PDF text length is invalid', 409);
  if (original.extraction_method === OCR_METHOD && !pages.some(page => page.recognition === 'ocr'))
    throw invalid('Saved CAM PDF OCR method does not match page evidence', 409);
  if (original.extraction_method === METHOD && pages.some(page => page.recognition === 'ocr'))
    throw invalid('Saved CAM PDF text-layer method does not match page evidence', 409);
  return { originalSha256: String(original.original_sha256).trim(), textSha256: String(original.text_sha256).trim(), pages };
}

export function citedPdfPage(source, verified, quote, pageValue, label) {
  if (!verified) {
    if (pageValue !== undefined && pageValue !== null && pageValue !== '')
      throw invalid(`${label} page is available only for a stored PDF original`);
    return null;
  }
  const page = Number(pageValue);
  if (!Number.isSafeInteger(page) || page < 1 || page > verified.pages.length)
    throw invalid(`${label} requires an exact PDF page`);
  const span = verified.pages[page - 1];
  if (!source.content.slice(span.start, span.end).includes(quote))
    throw invalid(`${label} must match text on the cited PDF page`);
  return page;
}
