-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Documents table
CREATE TABLE IF NOT EXISTS documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  filename TEXT NOT NULL,
  uploaded_at TIMESTAMP DEFAULT NOW(),
  CONSTRAINT documents_filename_unique UNIQUE (filename)
);

-- Chunks table with vector column
CREATE TABLE IF NOT EXISTS chunks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  chunk_index INTEGER NOT NULL,
  text TEXT NOT NULL,
  embedding vector(1536)
);

-- Query logs table
CREATE TABLE IF NOT EXISTS query_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id UUID NOT NULL,
  latency_ms INTEGER,
  status TEXT NOT NULL,
  error_message TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Upload logs table
CREATE TABLE IF NOT EXISTS upload_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id UUID NOT NULL,
  latency_ms INTEGER,
  status TEXT NOT NULL,
  error_message TEXT,
  stage_timings JSONB,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Add stage_timings column if it doesn't exist (for existing databases)
DO $$ 
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'upload_logs' AND column_name = 'stage_timings'
  ) THEN
    ALTER TABLE upload_logs ADD COLUMN stage_timings JSONB;
  END IF;
END $$;

-- Index for vector similarity search (cosine distance)
CREATE INDEX IF NOT EXISTS chunks_embedding_idx ON chunks 
USING ivfflat (embedding vector_cosine_ops)
WITH (lists = 100);

-- Index for lookups by document_id
CREATE INDEX IF NOT EXISTS chunks_document_id_idx ON chunks (document_id);

-- Index for query_logs request_id lookups
CREATE INDEX IF NOT EXISTS query_logs_request_id_idx ON query_logs (request_id);

-- Index for upload_logs request_id lookups
CREATE INDEX IF NOT EXISTS upload_logs_request_id_idx ON upload_logs (request_id);
