'use client';

import React, { useState, useEffect } from 'react';

interface FileDropzoneProps {
  onDemoRunbooksLoad?: () => void;
  demoOnly?: boolean; // When true, shows upload UI in locked state (for public demos)
  onUploadSuccess?: (data: { filenames: string[]; chunks: number; requestId: string }) => void;
  onUploadStart?: () => void;
}

// Helper to safely parse response
async function parseResponse(response: Response): Promise<any> {
  const contentType = response.headers.get('content-type') || '';
  
  if (contentType.includes('application/json')) {
    return await response.json();
  } else {
    const text = await response.text();
    const status = response.status;
    const statusText = response.statusText;
    throw new Error(`Non-JSON response: ${status} ${statusText} ${text.substring(0, 200)}`);
  }
}

type UploadAuthState = 'locked' | 'checking' | 'unlocked' | 'invalid';

interface UploadSuccessData {
  filenames: string[];
  chunks: number;
  requestId: string;
  verifiedSearchable: boolean;
  topRetrievalPreview?: Array<{ filename: string; chunkIndex: number; textPreview: string; distance?: number; keywordScore?: number }>;
}

// Debug logging flag (set NEXT_PUBLIC_DEBUG_UPLOADS=true in env to enable verbose logs)
const DEBUG_UPLOADS = typeof window !== 'undefined' 
  ? (window as any).__DEBUG_UPLOADS === true || 
    (typeof process !== 'undefined' && process.env.NEXT_PUBLIC_DEBUG_UPLOADS === 'true') ||
    process.env.NODE_ENV === 'development'
  : false;

const debugLog = (...args: any[]) => {
  if (DEBUG_UPLOADS) {
    console.log(...args);
  }
};

export default function FileDropzone({ onDemoRunbooksLoad, demoOnly = false, onUploadSuccess, onUploadStart }: FileDropzoneProps) {
  const [uploading, setUploading] = useState(false);
  const [status, setStatus] = useState<string>(''); // Upload status only
  const [demoStatus, setDemoStatus] = useState<string>(''); // Demo runbooks status
  const [uploadCode, setUploadCode] = useState<string>('');
  const [showUploadCode, setShowUploadCode] = useState(false);
  const [uploadAuth, setUploadAuth] = useState<UploadAuthState>(demoOnly ? 'locked' : 'unlocked');
  const [uploadSuccessData, setUploadSuccessData] = useState<UploadSuccessData | null>(null);
  const [showDetails, setShowDetails] = useState(false);
  const [showMorePreviews, setShowMorePreviews] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [copiedDetails, setCopiedDetails] = useState(false);
  const [showTooltip, setShowTooltip] = useState<string | null>(null);

  // Load upload code and verify on mount
  // Only unlock if BOTH token exists AND verified flag is true
  // Auto-clean stale verified flags if token is missing
  useEffect(() => {
    if (!demoOnly) return;
    
    const stored = localStorage.getItem('rbc_upload_token') ?? '';
    const verified = localStorage.getItem('rbc_upload_verified') === 'true';
    const hasToken = !!stored.trim();
    
    // Auto-clean: if verified flag exists but token is missing/blank, remove both
    if (verified && !hasToken) {
      debugLog('[FileDropzone] Auto-cleaning stale verified flag (token missing)');
      localStorage.removeItem('rbc_upload_verified');
      localStorage.removeItem('rbc_upload_token');
      setUploadAuth('locked');
      setUploadCode('');
      return;
    }
    
    // Only unlock if BOTH token and verified exist
    if (!hasToken || !verified) {
      // Missing either - must be locked
      setUploadAuth('locked');
      if (!hasToken) {
        localStorage.removeItem('rbc_upload_verified');
        localStorage.removeItem('rbc_upload_token');
      }
      if (hasToken) {
        // Token exists but not verified - load it but keep locked
        setUploadCode(stored);
      }
      return;
    }
    
    // Both exist - load token and verify with server to confirm it's still valid
    setUploadCode(stored);
    setUploadAuth('checking');
    
    // Verify token with server
    fetch('/api/upload/verify', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-upload-token': stored,
      },
    })
      .then(async (response) => {
        try {
          const data = await response.json();
          if (response.ok && data.valid === true) {
            setUploadAuth('unlocked');
            localStorage.setItem('rbc_upload_verified', 'true');
          } else {
            // Verification failed - lock and clean
            setUploadAuth('locked');
            localStorage.removeItem('rbc_upload_verified');
            localStorage.removeItem('rbc_upload_token');
            setUploadCode('');
          }
        } catch (parseError) {
          setUploadAuth('locked');
          localStorage.removeItem('rbc_upload_verified');
        }
      })
      .catch(() => {
        setUploadAuth('locked');
        localStorage.removeItem('rbc_upload_verified');
      });
  }, [demoOnly]);

  // Verify upload code (only called on explicit button click)
  const handleVerifyUploadCode = async () => {
    if (!uploadCode.trim()) {
      setUploadAuth('invalid');
      setStatus('Error: Please enter an upload code');
      return;
    }

    setUploadAuth('checking');
    setStatus('Verifying upload code...');

    try {
      const response = await fetch('/api/upload/verify', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-upload-token': uploadCode,
        },
      });

      const data = await parseResponse(response);

      if (response.ok && data.valid === true) {
        setUploadAuth('unlocked');
        setStatus('');
        // Only persist token after successful verification
        localStorage.setItem('rbc_upload_token', uploadCode);
        localStorage.setItem('rbc_upload_verified', 'true');
      } else {
        setUploadAuth('invalid');
        setStatus('Invalid code');
        // Don't persist invalid tokens
        localStorage.removeItem('rbc_upload_token');
        localStorage.removeItem('rbc_upload_verified');
      }
    } catch (error) {
      setUploadAuth('invalid');
      const errorMessage = error instanceof Error ? error.message : 'Verification failed';
      setStatus(`Error: ${errorMessage}`);
      localStorage.removeItem('rbc_upload_token');
      localStorage.removeItem('rbc_upload_verified');
    }
  };

  // Check if uploads are enabled
  // Require BOTH verified status AND non-empty token
  const hasToken = !!uploadCode?.trim();
  const uploadsEnabled = !demoOnly || (uploadAuth === 'unlocked' && hasToken);

  // Don't clear status automatically - only clear when new upload starts

  const handleUseDemoRunbooks = async () => {
    setUploading(true);
    setDemoStatus('Loading demo runbooks...');
    // Don't clear upload status - keep it visible

    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      
      const response = await fetch('/api/seedDemo', {
        method: 'POST',
        headers,
      });

      const data = await parseResponse(response);
      
      if (response.ok) {
        setDemoStatus(
          `Success! Indexed ${data.inserted_documents} document(s), ` +
          `${data.inserted_chunks} chunks. Request ID: ${data.request_id}`
        );
        onDemoRunbooksLoad?.();
      } else {
        const errorMsg = data.error?.message || data.error || 'Failed to load demo runbooks';
        setDemoStatus(`Error: ${errorMsg} (${data.error?.code || 'UNKNOWN'})`);
      }
    } catch (error) {
      console.error('Demo runbooks error:', error);
      const errorMessage = error instanceof Error ? error.message : 'Failed to load demo runbooks';
      setDemoStatus(`Error: ${errorMessage}`);
    } finally {
      setUploading(false);
    }
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    debugLog('[FileDropzone] handleDrop called, uploadsEnabled:', uploadsEnabled);
    if (!uploadsEnabled) {
      debugLog('[FileDropzone] Uploads disabled, returning early');
      return;
    }
    const files = Array.from(e.dataTransfer.files) as File[];
    debugLog('[FileDropzone] Dropped files:', files.length);
    await uploadFiles(files);
  };

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    debugLog('[FileDropzone] handleFileSelect called, uploadsEnabled:', uploadsEnabled);
    if (!uploadsEnabled) {
      debugLog('[FileDropzone] Uploads disabled, returning early');
      return;
    }
    const files = Array.from(e.target.files || []) as File[];
    debugLog('[FileDropzone] Selected files:', files.length);
    await uploadFiles(files);
  };

  const uploadFiles = async (files: File[]) => {
    debugLog('[FileDropzone] uploadFiles called with', files.length, 'files');
    
    // Filter to PDF/MD only
    const validFiles = files.filter(
      file => 
        file.type === 'application/pdf' ||
        file.name.endsWith('.md') ||
        file.name.endsWith('.MD') ||
        file.name.endsWith('.markdown')
    );

    debugLog('[FileDropzone] validFiles:', validFiles.length, validFiles.map(f => ({ name: f.name, type: f.type, size: f.size })));

    if (validFiles.length === 0) {
      debugLog('[FileDropzone] No valid files, returning early');
      setStatus('Error: Only PDF and Markdown files are supported');
      return;
    }

    debugLog('[FileDropzone] Setting uploading=true, status="Uploading..."');
    // Clear previous status only when starting a new upload
    // Clear previous status and success data when starting a new upload
    setStatus('');
    setUploadSuccessData(null);
    setShowDetails(false);
    setShowMorePreviews(false);
    setShowAdvanced(false);
    setCopiedDetails(false);
    setUploading(true);
    setStatus('Uploading and processing files...');
    
    // Notify parent that upload started (to clear suggested questions)
    if (onUploadStart) {
      onUploadStart();
    }

    try {
      // Build FormData with files
      const formData = new FormData();
      for (const file of validFiles) {
        formData.append('files', file);
        debugLog('[FileDropzone] Added file to FormData:', file.name, file.size, 'bytes');
      }

      // Build headers - include upload token if present
      // IMPORTANT: do NOT set Content-Type manually (browser sets it with boundary)
      const headers: Record<string, string> = {};
      if (uploadCode) {
        headers['x-upload-token'] = uploadCode;
        debugLog('[FileDropzone] Including upload token in headers');
      } else {
        debugLog('[FileDropzone] No upload token - uploads may be locked');
      }

      debugLog('[FileDropzone] Starting fetch to /api/upload...');
      const fetchStartTime = Date.now();
      
      // Upload files directly to server
      const response = await fetch('/api/upload', {
        method: 'POST',
        headers,
        body: formData,
      });

      const fetchDuration = Date.now() - fetchStartTime;
      debugLog('[FileDropzone] Fetch completed:', {
        status: response.status,
        ok: response.ok,
        duration: fetchDuration + 'ms',
        headers: Object.fromEntries(response.headers.entries()),
      });

      // Read response body as text first, then parse JSON
      debugLog('[FileDropzone] Reading response body...');
      const raw = await response.text();
      debugLog('[FileDropzone] Response body length:', raw.length, 'chars');
      debugLog('[FileDropzone] Response body preview:', raw.substring(0, 200));
      
      let data: any = null;
      let parseSucceeded = false;
      
      try {
        data = raw ? JSON.parse(raw) : {};
        parseSucceeded = true;
        debugLog('[FileDropzone] JSON parse succeeded:', Object.keys(data));
      } catch (parseError) {
        parseSucceeded = false;
        if (DEBUG_UPLOADS) {
          console.error('[FileDropzone] Failed to parse response as JSON:', parseError, 'Raw response:', raw.substring(0, 200));
        }
      }

      // Log response details for debugging
      debugLog('[FileDropzone] Upload response summary:', {
        status: response.status,
        ok: response.ok,
        parseSucceeded,
        requestId: data?.request_id || 'unknown',
        hasError: !!data?.error,
        errorCode: data?.error?.code,
        errorMessage: data?.error?.message,
        filesProcessed: data?.files_processed,
        totalChunks: data?.total_chunks,
        insertedFilenames: data?.inserted_filenames,
        verifiedSearchable: data?.verified_searchable,
      });

      if (!response.ok) {
        debugLog('[FileDropzone] Response not OK, handling error...');
        // Show real server message
        const errorMessage = data?.error?.message || data?.error || raw || `Upload failed: ${response.status}`;
        const requestId = data?.request_id || 'unknown';
        
        // Handle 401 by relocking
        if (response.status === 401) {
          if (demoOnly) {
            setUploadAuth('locked');
            localStorage.removeItem('rbc_upload_verified');
            localStorage.removeItem('rbc_upload_token');
            setUploadCode('');
          }
          setStatus(`Upload failed: Authentication required. Request ID: ${requestId}`);
        } else {
          setStatus(`Error: ${errorMessage} (Request ID: ${requestId})`);
        }
        return;
      }

      // Success - store data for compact display and suggested questions
      debugLog('[FileDropzone] Response OK, storing success data...');
      const requestId = data?.request_id || 'unknown';
      const filenames = data.inserted_filenames || [];
      const chunks = data.total_chunks || 0;
      
      const successData: UploadSuccessData = {
        filenames,
        chunks,
        requestId,
        verifiedSearchable: data.verified_searchable === true,
        topRetrievalPreview: data.top_retrieval_preview || undefined,
      };
      
      setUploadSuccessData(successData);
      setStatus('success'); // Use special status value to trigger compact display
      
      // Notify parent component for suggested questions
      if (onUploadSuccess) {
        onUploadSuccess({ filenames, chunks, requestId });
      }
      debugLog('[FileDropzone] Status set, about to exit try block');
    } catch (error) {
      if (DEBUG_UPLOADS) {
        console.error('[FileDropzone] Upload error caught:', error);
      }
      const errorMessage = error instanceof Error ? error.message : 'Upload failed';
      debugLog('[FileDropzone] Setting error status:', errorMessage);
      setStatus(`Error: ${errorMessage}`);
    } finally {
      // Always clear uploading state - this is critical
      debugLog('[FileDropzone] Finally block: setting uploading=false');
      setUploading(false);
      debugLog('[FileDropzone] Upload flow complete');
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex gap-4 items-start">
        <div className="flex-1">
          <button
            onClick={handleUseDemoRunbooks}
            disabled={uploading}
            className="px-4 py-2 bg-green-600 text-white rounded hover:bg-green-700 disabled:bg-gray-400"
          >
            Use demo runbooks
          </button>
          {demoStatus && (
            <div className={`mt-2 text-sm ${demoStatus.startsWith('Error') ? 'text-red-600' : 'text-gray-600'}`}>
              {demoStatus}
            </div>
          )}
        </div>
        <div className="text-sm text-gray-600 self-center">or</div>
      </div>

      {/* Upload code input for public demo */}
      {demoOnly && (
        <div className="border rounded-lg p-4 bg-gray-50">
          <label className="block text-sm font-medium mb-2">Upload Code</label>
          <div className="flex gap-2">
            <div className="relative flex-1">
              <input
                type={showUploadCode ? 'text' : 'password'}
                value={uploadCode}
              onChange={(e) => {
                const newCode = e.target.value;
                setUploadCode(newCode);
                // Always reset to locked when code changes - require re-verification
                setUploadAuth('locked');
                localStorage.removeItem('rbc_upload_verified');
                // Only clear token if input is empty
                if (!newCode.trim()) {
                  localStorage.removeItem('rbc_upload_token');
                } else {
                  // Save token as user types (but don't unlock until verified)
                  localStorage.setItem('rbc_upload_token', newCode);
                }
              }}
                placeholder="Enter upload code"
                disabled={uploadAuth === 'checking'}
                className="w-full border rounded px-3 py-2 text-sm pr-20 disabled:bg-gray-100"
              />
              <button
                type="button"
                onClick={() => setShowUploadCode(!showUploadCode)}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-gray-600 hover:text-gray-800 px-2"
              >
                {showUploadCode ? 'Hide' : 'Show'}
              </button>
            </div>
            <button
              onClick={handleVerifyUploadCode}
              disabled={!uploadCode.trim() || uploadAuth === 'checking' || uploadAuth === 'unlocked'}
              className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:bg-gray-400 text-sm whitespace-nowrap"
            >
              {uploadAuth === 'checking' ? 'Verifying...' : uploadAuth === 'unlocked' ? 'Verified' : 'Unlock uploads'}
            </button>
          </div>
          {/* Only show "Uploads unlocked" if BOTH token exists AND verified AND auth is unlocked */}
          {uploadAuth === 'unlocked' && hasToken && (
            <p className="mt-2 text-sm text-green-600">
              ✓ Uploads unlocked
            </p>
          )}
          {uploadAuth === 'invalid' && (
            <p className="mt-2 text-sm text-red-600">
              Invalid code. Please check and try again.
            </p>
          )}
          {uploadAuth === 'locked' && (
            <p className="mt-2 text-sm text-gray-600">
              Optional — needed only to upload your own runbooks.
            </p>
          )}
          {uploadAuth === 'unlocked' && hasToken && (
            <button
              onClick={() => {
                localStorage.removeItem('rbc_upload_token');
                localStorage.removeItem('rbc_upload_verified');
                setUploadCode('');
                setUploadAuth('locked');
              }}
              className="mt-2 text-xs text-gray-500 hover:text-gray-700 underline"
            >
              Forget upload code
            </button>
          )}
        </div>
      )}

      {/* Upload dropzone - always shown */}
      <div
        onDrop={uploadsEnabled ? handleDrop : (e) => e.preventDefault()}
        onDragOver={(e) => e.preventDefault()}
        className={`border-2 border-dashed rounded-lg p-8 text-center ${
          !uploadsEnabled
            ? 'border-gray-200 bg-gray-50 opacity-60'
            : 'border-gray-300'
        }`}
      >
        <input
          type="file"
          accept=".pdf,.md,.markdown"
          onChange={handleFileSelect}
          disabled={uploading || !uploadsEnabled}
          multiple
          className="hidden"
          id="file-input"
        />
        {!uploadsEnabled ? (
          <div className="text-sm text-gray-600">
            {demoOnly ? 'Uploads are locked. Enter an upload code above to unlock.' : 'Uploads disabled'}
          </div>
        ) : (
          <label
            htmlFor="file-input"
            className={`cursor-pointer ${
              uploading ? 'text-gray-400' : 'text-blue-600 hover:text-blue-800'
            }`}
          >
            {uploading ? 'Processing...' : 'Upload my own runbooks'}
          </label>
        )}
      </div>

      {/* Status message - always shown unconditionally */}
      <div className="mt-4">
        {uploading ? (
          <div className="text-sm text-gray-600">Uploading and processing files...</div>
        ) : status === 'success' && uploadSuccessData ? (
          <div className="text-sm p-2.5 rounded border text-green-600 bg-green-50/80 border-green-200">
            <div className="flex items-start justify-between">
              <div className="flex-1">
                <div>
                  <span className="font-medium">✅ Indexed {uploadSuccessData.filenames.join(', ')}.</span>
                  <span className="ml-1">{uploadSuccessData.chunks} chunks created.</span>
                  {uploadSuccessData.verifiedSearchable && (
                    <span className="ml-1">Search verified.</span>
                  )}
                </div>
                <div className="text-xs text-green-700/80 mt-1">
                  You can now ask questions below.
                </div>
              </div>
              <button
                onClick={() => setShowDetails(!showDetails)}
                className="ml-2 text-xs text-green-700 hover:text-green-900 underline focus:outline-none focus:ring-1 focus:ring-green-500 focus:ring-offset-1 rounded px-1 flex-shrink-0"
                type="button"
                aria-expanded={showDetails}
                aria-label={showDetails ? 'Hide details' : 'Show details'}
              >
                {showDetails ? 'Hide' : 'Show'} details
              </button>
            </div>
            {showDetails && (
              <div className="mt-3 pt-3 border-t border-green-200 space-y-3 text-xs">
                <div className="flex items-center justify-between">
                  <div>
                    <span className="font-medium">Request ID:</span> <span className="font-mono text-gray-700">{uploadSuccessData.requestId}</span>
                  </div>
                  <button
                    onClick={async () => {
                      // Copy details: filename, chunks, request_id, and preview snippets
                      const previews = showMorePreviews 
                        ? uploadSuccessData.topRetrievalPreview || []
                        : uploadSuccessData.topRetrievalPreview?.slice(0, 1) || [];
                      
                      const details = [
                        `Filename: ${uploadSuccessData.filenames.join(', ')}`,
                        `Chunks: ${uploadSuccessData.chunks}`,
                        `Request ID: ${uploadSuccessData.requestId}`,
                        '',
                        'Retrieval preview:',
                        ...previews.map((r, i) => {
                          let previewText = `${r.filename} (chunk ${r.chunkIndex}):\n${r.textPreview}`;
                          // Include similarity metric if advanced mode is enabled and distance is available
                          if (showMorePreviews && showAdvanced && r.distance !== undefined) {
                            const similarity = Math.max(0, Math.min(1, 1 - r.distance));
                            previewText += `\nSimilarity: ${similarity.toFixed(2)} (derived from cosine distance ${r.distance.toFixed(4)})`;
                          }
                          return previewText;
                        }),
                      ].join('\n');
                      
                      await navigator.clipboard.writeText(details);
                      setCopiedDetails(true);
                      setTimeout(() => setCopiedDetails(false), 1200);
                    }}
                    className="text-green-700 hover:text-green-900 underline text-xs focus:outline-none focus:ring-1 focus:ring-green-500 focus:ring-offset-1 rounded px-1"
                    type="button"
                  >
                    {copiedDetails ? 'Copied!' : 'Copy details'}
                  </button>
                </div>
                {uploadSuccessData.topRetrievalPreview && uploadSuccessData.topRetrievalPreview.length > 0 && (
                  <div>
                    <div className="space-y-2">
                      {/* Show first preview always */}
                      <div className="bg-white p-2.5 rounded border border-green-200">
                        <div className="font-medium text-gray-800 mb-1">
                          {uploadSuccessData.topRetrievalPreview[0].filename} (chunk {uploadSuccessData.topRetrievalPreview[0].chunkIndex})
                        </div>
                        <div className="text-gray-700 mt-1 leading-relaxed">{uploadSuccessData.topRetrievalPreview[0].textPreview}</div>
                        {/* Show similarity for first preview only when advanced is enabled AND show more is expanded */}
                        {/* Cosine distance (<=>) ranges 0-2, so similarity = clamp(1 - distance, 0, 1) */}
                        {showMorePreviews && showAdvanced && uploadSuccessData.topRetrievalPreview[0].distance !== undefined && (
                          <div className="text-gray-500 text-xs mt-1.5 space-y-0.5">
                            <div className="flex items-center gap-1 relative">
                              <span>
                                Similarity: {Math.max(0, Math.min(1, 1 - uploadSuccessData.topRetrievalPreview[0].distance)).toFixed(2)} (higher is better)
                              </span>
                              <button
                                type="button"
                                className="text-gray-400 hover:text-gray-600 focus:outline-none focus:ring-1 focus:ring-gray-400 rounded"
                                aria-label="Information about similarity metric"
                                aria-describedby="tooltip-similarity-0"
                                onMouseEnter={() => setShowTooltip('similarity-0')}
                                onMouseLeave={() => setShowTooltip(null)}
                                onFocus={() => setShowTooltip('similarity-0')}
                                onBlur={() => setShowTooltip(null)}
                                onClick={() => setShowTooltip(showTooltip === 'similarity-0' ? null : 'similarity-0')}
                              >
                                <span aria-hidden="true">ℹ️</span>
                              </button>
                              {showTooltip === 'similarity-0' && (
                                <div
                                  id="tooltip-similarity-0"
                                  role="tooltip"
                                  className="absolute left-0 bottom-full mb-2 z-10 bg-gray-900 text-white text-xs rounded px-2 py-1.5 shadow-lg whitespace-nowrap"
                                >
                                  Derived from cosine distance (pgvector &lt;=&gt;).
                                  <div className="absolute top-full left-2 -mt-1 w-2 h-2 bg-gray-900 rotate-45" />
                                </div>
                              )}
                            </div>
                            <div className="text-gray-400 text-[10px]">
                              Cosine distance: {uploadSuccessData.topRetrievalPreview[0].distance.toFixed(4)} (lower is better)
                            </div>
                          </div>
                        )}
                      </div>
                      
                      {/* Show "Show more" link if there are more previews */}
                      {uploadSuccessData.topRetrievalPreview.length > 1 && !showMorePreviews && (
                        <button
                          onClick={() => setShowMorePreviews(true)}
                          className="text-green-700 hover:text-green-900 underline text-xs focus:outline-none focus:ring-1 focus:ring-green-500 focus:ring-offset-1 rounded px-1"
                          type="button"
                          aria-expanded={false}
                          aria-label={`Show ${uploadSuccessData.topRetrievalPreview.length - 1} more preview${uploadSuccessData.topRetrievalPreview.length - 1 > 1 ? 's' : ''}`}
                        >
                          Show more ({uploadSuccessData.topRetrievalPreview.length - 1})
                        </button>
                      )}
                      
                      {/* Show remaining previews when expanded */}
                      {showMorePreviews && uploadSuccessData.topRetrievalPreview.slice(1).map((result, i) => (
                        <div key={i + 1} className="bg-white p-2.5 rounded border border-green-200">
                          <div className="font-medium text-gray-800 mb-1">
                            {result.filename} (chunk {result.chunkIndex})
                          </div>
                          <div className="text-gray-700 mt-1 leading-relaxed">{result.textPreview}</div>
                          {/* Cosine distance (<=>) ranges 0-2, so similarity = clamp(1 - distance, 0, 1) */}
                          {showAdvanced && result.distance !== undefined && (
                            <div className="text-gray-500 text-xs mt-1.5 space-y-0.5">
                              <div className="flex items-center gap-1 relative">
                                <span>
                                  Similarity: {Math.max(0, Math.min(1, 1 - result.distance)).toFixed(2)} (higher is better)
                                </span>
                                <button
                                  type="button"
                                  className="text-gray-400 hover:text-gray-600 focus:outline-none focus:ring-1 focus:ring-gray-400 rounded"
                                  aria-label="Information about similarity metric"
                                  aria-describedby={`tooltip-similarity-${i + 1}`}
                                  onMouseEnter={() => setShowTooltip(`similarity-${i + 1}`)}
                                  onMouseLeave={() => setShowTooltip(null)}
                                  onFocus={() => setShowTooltip(`similarity-${i + 1}`)}
                                  onBlur={() => setShowTooltip(null)}
                                  onClick={() => setShowTooltip(showTooltip === `similarity-${i + 1}` ? null : `similarity-${i + 1}`)}
                                >
                                  <span aria-hidden="true">ℹ️</span>
                                </button>
                                {showTooltip === `similarity-${i + 1}` && (
                                  <div
                                    id={`tooltip-similarity-${i + 1}`}
                                    role="tooltip"
                                    className="absolute left-0 bottom-full mb-2 z-10 bg-gray-900 text-white text-xs rounded px-2 py-1.5 shadow-lg whitespace-nowrap"
                                  >
                                    Derived from cosine distance (pgvector &lt;=&gt;).
                                    <div className="absolute top-full left-2 -mt-1 w-2 h-2 bg-gray-900 rotate-45" />
                                  </div>
                                )}
                              </div>
                              <div className="text-gray-400 text-[10px]">
                                Cosine distance: {result.distance.toFixed(4)} (lower is better)
                              </div>
                            </div>
                          )}
                        </div>
                      ))}
                      
                      {/* Scoring toggle (only show when "Show more" is expanded) */}
                      {showMorePreviews && uploadSuccessData.topRetrievalPreview.length > 1 && (
                        <button
                          onClick={() => setShowAdvanced(!showAdvanced)}
                          className="text-gray-600 hover:text-gray-800 underline text-xs focus:outline-none focus:ring-1 focus:ring-gray-500 focus:ring-offset-1 rounded px-1"
                          type="button"
                          aria-expanded={showAdvanced}
                          aria-label={showAdvanced ? 'Hide scoring metrics' : 'Show scoring metrics'}
                        >
                          {showAdvanced ? 'Hide' : 'Show'} scoring
                        </button>
                      )}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        ) : status ? (
          <div className={`text-sm p-3 rounded border ${
            status.startsWith('Error') || status.includes('failed')
              ? 'text-red-600 bg-red-50 border-red-200' 
              : 'text-gray-600 bg-gray-50 border-gray-200'
          }`}>
            {status}
          </div>
        ) : null}
      </div>

    </div>
  );
}
