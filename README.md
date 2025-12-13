# Runbook Copilot

AI-powered runbook assistant that helps you find and apply incident response procedures from your documentation.

## Features

- **Upload runbooks** (PDF/Markdown) → automatically extracted, chunked, and embedded
- **Ask questions** → AI agent searches your runbooks and answers with citations
- **Draft Slack updates** → generate concise incident updates from the same context
- **Public demo mode** → rate-limited, upload-gated for safe public demos

## Setup

### 1) Database (Neon Postgres + pgvector)

1. Create a Neon Postgres database.
2. Apply `lib/schema.sql` (idempotent). It enables:
   - `vector` extension (for embeddings)
   - `pgcrypto` extension (for `gen_random_uuid()`)

### 2) Environment Variables

Create `.env.local` (or set in Vercel):

**Required:**
- `DATABASE_URL` = Neon connection string
- `OPENAI_API_KEY` = OpenAI API key

**Demo / safety:**
- `PUBLIC_DEMO` = `true` (recommended for public demos)
- `UPLOAD_TOKEN` = random token used to unlock uploads (only for `/api/upload`)

**Optional:**
- `BLOB_READ_WRITE_TOKEN` = enables saving uploaded files to Vercel Blob (indexing works even without it)
- `NEXT_PUBLIC_DEBUG_UPLOADS` = `true` (enables verbose console logging for debugging; default: false)

### 3) Local Dev

```bash
npm install
npm run dev
```

### 4) Vercel Deploy

1. Import the GitHub repo as a Vercel Project (auto-deploy on push).
2. Set env vars in Vercel (Production + Preview as needed).
3. Deploy.

### 5) Public Demo Mode Behavior (`PUBLIC_DEMO=true`)

- `/api/query` and `/api/slackSummary` are public and rate-limited.
- `/api/seedDemo` is public and rate-limited.
- `/api/upload` requires `UPLOAD_TOKEN` (header: `x-upload-token`).
- UI shows a "Public demo — do not upload sensitive data." banner.
- Upload UI is locked until a valid upload code is verified.

## Troubleshooting

- **If uploads appear "unlocked" unexpectedly**: Clear site localStorage keys:
  - `rbc_upload_token`
  - `rbc_upload_verified`
- **For detailed deployment instructions**: See `DEPLOYMENT.md`

