# Deployment Guide

## Required Environment Variables

Set these in `.env.local` for local development or in Vercel project settings:

- `OPENAI_API_KEY` - OpenAI API key for embeddings and chat
- `OPENAI_MODEL` - Chat model (default: `gpt-4o-mini`)
- `OPENAI_EMBEDDING_MODEL` - Embedding model (default: `text-embedding-3-small`)
- `UPLOAD_TOKEN` - Token required for `/api/upload` only (set header `x-upload-token`). `/api/seedDemo` is public.
- `DATABASE_URL` - PostgreSQL connection string with pgvector extension
- `BLOB_READ_WRITE_TOKEN` - Vercel Blob storage token (optional for local dev)
- `PUBLIC_DEMO` - Set to `true` to enable public demo mode (hides upload UI, shows warning banner)

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
   UPLOAD_TOKEN=your_random_hex_token
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

### Step 1: Create Vercel Project

1. Go to [Vercel Dashboard](https://vercel.com/dashboard)
2. Click "Add New" → "Project"
3. Import your GitHub repository (`nickcarndt/runbook-copilot`)
4. Select Next.js framework preset
5. Click "Deploy" (don't worry about env vars yet)

### Step 2: Add Postgres Database

1. In your Vercel project dashboard, go to **Storage** tab
2. Click **Create Database** → **Postgres**
3. Choose a name (e.g., `runbook-db`) and region
4. After creation, go to **Settings** → **Extensions**
5. Enable **pgvector** extension
6. Go to **.env.local** tab and copy the `POSTGRES_URL` value

### Step 3: Add Blob Storage

1. In **Storage** tab, click **Create Database** → **Blob**
2. Choose a name (e.g., `runbook-blob`) and region
3. After creation, go to **Settings** → **Environment Variables**
4. Copy the `BLOB_READ_WRITE_TOKEN` value

### Step 4: Set Environment Variables

1. Go to **Settings** → **Environment Variables**
2. Add each variable (Production, Preview, Development):
   - `OPENAI_API_KEY` = your OpenAI API key
   - `OPENAI_MODEL` = `gpt-4o-mini`
   - `OPENAI_EMBEDDING_MODEL` = `text-embedding-3-small`
   - `UPLOAD_TOKEN` = a secure random token for upload routes (e.g., generate with `openssl rand -hex 16`)
   - `DATABASE_URL` = the `POSTGRES_URL` from Step 2
   - `BLOB_READ_WRITE_TOKEN` = the token from Step 3
   - `PUBLIC_DEMO` = `true` (optional, for public demos - hides upload UI)

### Step 5: Apply Database Schema

Run the migration using the `db:vercel` script template:

```bash
npm run db:vercel
```

This prints the `psql` command. Copy it, replace `YOUR_DATABASE_URL` with your actual `POSTGRES_URL` from Vercel, and run it locally.

Alternatively, use Vercel Postgres SQL Editor:
1. Go to **Storage** → your Postgres database → **Data** tab
2. Click **SQL Editor**
3. Copy contents of `lib/schema.sql` and paste into editor
4. Click **Run**

### Step 6: Redeploy

1. Go to **Deployments** tab
2. Click **⋯** on latest deployment → **Redeploy**
3. Wait for deployment to complete

### Step 7: Seed Demo Data

The `/api/seedDemo` endpoint is public (no token required). You can seed demo data either:

**Option 1: Via UI**
1. Open your deployed app
2. Click "Use demo runbooks" button

**Option 2: Via API**
```bash
curl -X POST https://your-app.vercel.app/api/seedDemo \
  -H "Content-Type: application/json" \
  -d '{}'
```

Replace `your-app.vercel.app` with your actual Vercel domain.

You should see a response with `inserted_documents` and `inserted_chunks` counts.

**Note:** `/api/upload` requires `UPLOAD_TOKEN` (header `x-upload-token`), but `/api/seedDemo` is public for easy demo setup.

