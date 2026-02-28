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

