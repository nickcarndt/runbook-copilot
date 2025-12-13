# Deployment Guide

## Required Environment Variables

Set these in `.env.local` for local development or in Vercel project settings:

- `OPENAI_API_KEY` - OpenAI API key for embeddings and chat
- `OPENAI_MODEL` - Chat model (default: `gpt-4o-mini`)
- `OPENAI_EMBEDDING_MODEL` - Embedding model (default: `text-embedding-3-small`)
- `RBC_DEMO_TOKEN` - Demo safety token (required for all `/api/*` routes if set)
- `DATABASE_URL` - PostgreSQL connection string with pgvector extension
- `BLOB_READ_WRITE_TOKEN` - Vercel Blob storage token (optional for local dev)

## Local Setup

1. **Install dependencies:**
   ```bash
   npm install
   ```

2. **Start Postgres with pgvector:**
   ```bash
   docker run --name runbook-pgvector -e POSTGRES_PASSWORD=postgres -p 5432:5432 -d ankane/pgvector
   ```

3. **Set environment variables in `.env.local`:**
   ```
   OPENAI_API_KEY=your_key
   OPENAI_MODEL=gpt-4o-mini
   OPENAI_EMBEDDING_MODEL=text-embedding-3-small
   RBC_DEMO_TOKEN=devtoken
   DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres
   ```

4. **Run database migration:**
   ```bash
   npm run db:migrate
   ```

5. **Start dev server:**
   ```bash
   npm run dev
   ```

## Seed Demo Data

After starting the dev server:

1. Open http://localhost:3000
2. Click "Use demo runbooks" button
3. Wait for success message showing document and chunk counts

Or via API:
```bash
curl -X POST http://localhost:3000/api/seedDemo \
  -H "Content-Type: application/json" \
  -H "x-rbc-token: devtoken" \
  -d '{}'
```

## Vercel Deployment

1. **Create Vercel project:**
   - Connect GitHub repository
   - Select Next.js framework preset

2. **Add Postgres database:**
   - Vercel Dashboard → Storage → Create Database → Postgres
   - Enable pgvector extension in database settings
   - Copy connection string to `DATABASE_URL`

3. **Add Blob storage:**
   - Vercel Dashboard → Storage → Create Database → Blob
   - Copy token to `BLOB_READ_WRITE_TOKEN`

4. **Set environment variables:**
   - Vercel Dashboard → Settings → Environment Variables
   - Add all required variables listed above

5. **Run schema migration:**
   - Use Vercel Postgres dashboard SQL editor to run `lib/schema.sql`
   - Or run `npm run db:migrate` with `DATABASE_URL` set

6. **Deploy:**
   - Push to main branch (auto-deploys)
   - Or manually deploy from Vercel Dashboard

7. **Seed demo data:**
   - Call `/api/seedDemo` endpoint with `x-rbc-token` header matching `RBC_DEMO_TOKEN`:
   ```bash
   curl -X POST https://your-app.vercel.app/api/seedDemo \
     -H "Content-Type: application/json" \
     -H "x-rbc-token: your_token" \
     -d '{}'
   ```

