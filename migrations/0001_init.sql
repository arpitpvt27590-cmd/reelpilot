CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  ig_user_id TEXT NOT NULL UNIQUE,
  username TEXT NOT NULL,
  encrypted_token TEXT NOT NULL,
  token_expires_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  caption TEXT NOT NULL,
  filename TEXT NOT NULL,
  file_size INTEGER NOT NULL,
  status TEXT NOT NULL,
  cover_url TEXT,
  idempotency_key TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS job_results (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL,
  account_name TEXT NOT NULL,
  status TEXT NOT NULL,
  message TEXT NOT NULL,
  media_id TEXT,
  container_id TEXT,
  updated_at INTEGER NOT NULL,
  UNIQUE(job_id, account_id)
);

CREATE INDEX IF NOT EXISTS idx_jobs_created_at ON jobs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_results_job_id ON job_results(job_id);
