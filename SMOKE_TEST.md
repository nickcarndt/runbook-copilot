# Recruiter Demo Smoke Test

Quick validation checklist to ensure production is stable.

## 1. Health Check

```bash
curl https://your-vercel-url.vercel.app/api/health
```

**Expected:**
```json
{
  "ok": true,
  "db_ok": true,
  "has_stage_timings": true,
  "commit": "d1e6545..."
}
```

## 2. Demo Runbooks

**UI:** Click "Use demo runbooks" button

**Expected:**
- Success message showing document and chunk counts
- No 500 errors
- Request ID in response

## 3. Upload Test

**UI:** Upload `runbook_example_checkout_latency.pdf` (or any small PDF)

**Expected:**
- Success banner: "✅ Indexed [filename]. X chunks created."
- "Search verified." message (if ENABLE_VERIFY_SEARCH=true)
- Preview cards with similarity scores visible when clicking "Show details"
- No 500 errors
- Request ID in response

## Verification

All three steps should complete without 500 errors. If any step fails:
1. Check Vercel logs for `request_id`
2. Verify `GET /api/health` shows `has_stage_timings: true`
3. Check database connection in Vercel env vars
