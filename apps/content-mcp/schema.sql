-- D1 schema: gym-content rich content
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS content_docs (
  doc_id TEXT PRIMARY KEY,
  entity_type TEXT NOT NULL, -- e.g. 'class_definition' | 'instructor' | 'product' | 'gym'
  entity_id TEXT NOT NULL,   -- core id (e.g. class_def_id) or canonical address
  locale TEXT NOT NULL DEFAULT 'en',
  title TEXT,
  slug TEXT,
  body_markdown TEXT NOT NULL,
  tags_json TEXT,
  created_at_iso TEXT NOT NULL,
  updated_at_iso TEXT NOT NULL,
  UNIQUE(entity_type, entity_id, locale)
);

CREATE INDEX IF NOT EXISTS idx_content_docs_entity ON content_docs(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_content_docs_updated ON content_docs(updated_at_iso);

-- Crawl metadata for public web pages (change detection)
CREATE TABLE IF NOT EXISTS web_crawl_pages (
  url TEXT PRIMARY KEY,
  etag TEXT,
  last_modified TEXT,
  content_hash TEXT,
  title TEXT,
  status_code INTEGER,
  last_fetched_at_iso TEXT,
  last_changed_at_iso TEXT,
  error TEXT,
  updated_at_iso TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_web_crawl_pages_updated ON web_crawl_pages(updated_at_iso);

