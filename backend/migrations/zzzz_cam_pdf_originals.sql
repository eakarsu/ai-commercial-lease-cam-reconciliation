-- Keep an exact PDF original and derived page text beside each operator source.
CREATE TABLE IF NOT EXISTS cam_source_originals (
  source_id BIGINT PRIMARY KEY,
  account_id TEXT NOT NULL,
  filename TEXT NOT NULL,
  media_type TEXT NOT NULL CHECK (media_type='application/pdf'),
  original_bytes BYTEA NOT NULL CHECK (octet_length(original_bytes) BETWEEN 1 AND 5242880),
  original_sha256 CHAR(64) NOT NULL,
  text_sha256 CHAR(64) NOT NULL,
  page_count INTEGER NOT NULL CHECK (page_count BETWEEN 1 AND 5),
  page_spans JSONB NOT NULL,
  extraction_method TEXT NOT NULL CHECK (extraction_method='pdftotext_utf8_v1'),
  created_by_id BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (source_id,account_id) REFERENCES cam_sources(id,account_id),
  FOREIGN KEY (created_by_id,account_id) REFERENCES app_users(id,account_id)
);
CREATE INDEX IF NOT EXISTS cam_source_originals_account_idx ON cam_source_originals(account_id,source_id);

CREATE OR REPLACE FUNCTION cam_reject_source_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'CAM source evidence is immutable';
END;
$$;
DROP TRIGGER IF EXISTS cam_sources_immutable ON cam_sources;
CREATE TRIGGER cam_sources_immutable BEFORE UPDATE OR DELETE ON cam_sources
  FOR EACH ROW EXECUTE FUNCTION cam_reject_source_mutation();
DROP TRIGGER IF EXISTS cam_source_originals_immutable ON cam_source_originals;
CREATE TRIGGER cam_source_originals_immutable BEFORE UPDATE OR DELETE ON cam_source_originals
  FOR EACH ROW EXECUTE FUNCTION cam_reject_source_mutation();

ALTER TABLE cam_rules ADD COLUMN IF NOT EXISTS source_page INTEGER CHECK (source_page > 0 AND source_page <= 5);
ALTER TABLE cam_rules ADD COLUMN IF NOT EXISTS prior_source_page INTEGER CHECK (prior_source_page > 0 AND prior_source_page <= 5);
