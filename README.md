# Commercial Lease CAM Reconciliation

Full React, Express, PostgreSQL, and OpenRouter recovery application with 20 lease-expense capabilities and at least 15 records per feature.

Run `./start.sh`; UI <http://127.0.0.1:4547>, API `5547`.

## CAM lease evidence

Apply `backend/migrations/*.sql` in filename order before using the CAM workflow. The PDF evidence path requires local Poppler `pdfinfo`, `pdftotext`, and `pdftoppm` commands plus Tesseract (or configure `CAM_PDFINFO_PATH`, `CAM_PDFTOTEXT_PATH`, `CAM_PDFTOPPM_PATH`, and `CAM_TESSERACT_PATH`). Uploads accept PDFs of at most 5 MiB and five pages. Pages without selectable text use bounded OCR; `CAM_OCR_LANGUAGE` defaults to `eng`. Blank PDFs with no usable text require manual review.

The Lease Rules screen stores the exact uploaded PDF bytes, its SHA-256, the derived text SHA-256, page offsets and each page's text-layer or OCR label. These source records cannot be updated or deleted. An exact quote in a rule must occur on its cited PDF page. A separate reviewer must download and inspect the original before approving a PDF-backed rule, especially when OCR recognized the page. Recognition can be wrong. The document's signature and authority, landlord statement, and any credit remain subject to external verification.

Run `npm test` in `backend`. The database integration tests also require `RECOVERY_INTEGRATION_DATABASE_URL` pointing to a disposable database with all migrations applied; run the CAM PDF and claim-flow integration files separately because each starts the shared test server. The CAM PDF integration fixture uses ImageMagick to create a scanned source; the production OCR path does not need ImageMagick.
