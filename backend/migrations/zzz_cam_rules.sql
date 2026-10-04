-- Lease evidence and human-reviewed, immutable rule versions for one case/year/category.
CREATE UNIQUE INDEX IF NOT EXISTS app_users_id_account_idx ON app_users(id,account_id);
CREATE TABLE IF NOT EXISTS cam_sources (
  id BIGSERIAL PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES customer_accounts(id),
  source_kind TEXT NOT NULL CHECK (source_kind IN ('LEASE','AMENDMENT','PRIOR_STATEMENT')),
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  created_by_id BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (created_by_id,account_id) REFERENCES app_users(id,account_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS cam_sources_id_account_idx ON cam_sources(id,account_id);
CREATE INDEX IF NOT EXISTS cam_sources_account_idx ON cam_sources(account_id,created_at DESC);

CREATE TABLE IF NOT EXISTS cam_rules (
  id BIGSERIAL PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES customer_accounts(id),
  case_reference TEXT NOT NULL,
  lease_reference TEXT NOT NULL,
  lease_year INTEGER NOT NULL CHECK (lease_year BETWEEN 2000 AND 2100),
  category_key TEXT NOT NULL,
  category_label TEXT NOT NULL,
  rule_type TEXT NOT NULL CHECK (rule_type IN ('EXCLUSION','PRO_RATA','CATEGORY_CAP')),
  tenant_area_sq_ft BIGINT,
  property_area_sq_ft BIGINT,
  cap_percent_units BIGINT,
  prior_year_allowed_cents BIGINT,
  source_id BIGINT NOT NULL,
  source_quote TEXT NOT NULL,
  clause_locator TEXT NOT NULL,
  prior_source_id BIGINT,
  prior_source_quote TEXT,
  version INTEGER NOT NULL CHECK (version > 0),
  status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','APPROVED','SUPERSEDED')),
  created_by_id BIGINT NOT NULL,
  approved_by_id BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  approved_at TIMESTAMPTZ,
  UNIQUE(account_id,case_reference,lease_year,category_key,version),
  FOREIGN KEY (account_id,case_reference) REFERENCES feature_records(account_id,reference),
  FOREIGN KEY (created_by_id,account_id) REFERENCES app_users(id,account_id),
  FOREIGN KEY (approved_by_id,account_id) REFERENCES app_users(id,account_id),
  FOREIGN KEY (source_id,account_id) REFERENCES cam_sources(id,account_id),
  FOREIGN KEY (prior_source_id,account_id) REFERENCES cam_sources(id,account_id),
  CHECK (
    (rule_type='EXCLUSION' AND tenant_area_sq_ft IS NULL AND property_area_sq_ft IS NULL AND cap_percent_units IS NULL AND prior_year_allowed_cents IS NULL AND prior_source_id IS NULL)
    OR (rule_type='PRO_RATA' AND tenant_area_sq_ft > 0 AND property_area_sq_ft >= tenant_area_sq_ft AND cap_percent_units IS NULL AND prior_year_allowed_cents IS NULL AND prior_source_id IS NULL)
    OR (rule_type='CATEGORY_CAP' AND tenant_area_sq_ft > 0 AND property_area_sq_ft >= tenant_area_sq_ft AND cap_percent_units BETWEEN 0 AND 1000000 AND prior_year_allowed_cents >= 0 AND prior_source_id IS NOT NULL)
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS cam_rules_id_account_idx ON cam_rules(id,account_id);
CREATE UNIQUE INDEX IF NOT EXISTS cam_rules_one_approved_idx ON cam_rules(account_id,case_reference,lease_year,category_key) WHERE status='APPROVED';
CREATE INDEX IF NOT EXISTS cam_rules_account_case_idx ON cam_rules(account_id,case_reference,lease_year);

CREATE TABLE IF NOT EXISTS cam_assessments (
  id BIGSERIAL PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES customer_accounts(id),
  rule_id BIGINT NOT NULL,
  statement_line_id BIGINT NOT NULL,
  observed_cents BIGINT NOT NULL,
  expected_cents BIGINT,
  variance_cents BIGINT,
  status TEXT NOT NULL CHECK(status IN ('CANDIDATE','NO_VARIANCE','INSUFFICIENT')),
  calculation JSONB NOT NULL,
  assessed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(rule_id,statement_line_id),
  FOREIGN KEY (rule_id,account_id) REFERENCES cam_rules(id,account_id),
  FOREIGN KEY (statement_line_id,account_id) REFERENCES statement_lines(id,account_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS cam_assessments_id_account_idx ON cam_assessments(id,account_id);
CREATE INDEX IF NOT EXISTS cam_assessments_account_rule_idx ON cam_assessments(account_id,rule_id,status);

ALTER TABLE recovery_claims ADD COLUMN IF NOT EXISTS cam_assessment_id BIGINT;
CREATE UNIQUE INDEX IF NOT EXISTS recovery_claims_cam_assessment_idx ON recovery_claims(cam_assessment_id) WHERE cam_assessment_id IS NOT NULL;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='recovery_claims_cam_assessment_account_fkey') THEN
    ALTER TABLE recovery_claims ADD CONSTRAINT recovery_claims_cam_assessment_account_fkey
      FOREIGN KEY (cam_assessment_id,account_id) REFERENCES cam_assessments(id,account_id);
  END IF;
END $$;
