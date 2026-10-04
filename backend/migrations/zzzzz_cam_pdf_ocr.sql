ALTER TABLE cam_source_originals DROP CONSTRAINT IF EXISTS cam_source_originals_extraction_method_check;
ALTER TABLE cam_source_originals ADD CONSTRAINT cam_source_originals_extraction_method_check
  CHECK (extraction_method IN ('pdftotext_utf8_v1', 'tesseract_pdf_pages_v1'));
