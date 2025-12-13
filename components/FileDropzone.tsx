'use client';

import React, { useState, useEffect } from 'react';

interface FileDropzoneProps {
  onDemoRunbooksLoad?: () => void;
  demoOnly?: boolean; // When true, shows upload UI in locked state (for public demos)
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

export default function FileDropzone({ onDemoRunbooksLoad, demoOnly = false }: FileDropzoneProps) {
  const [uploading, setUploading] = useState(false);
  const [status, setStatus] = useState<string>(''); // Upload status only
  const [demoStatus, setDemoStatus] = useState<string>(''); // Demo runbooks status
  const [uploadCode, setUploadCode] = useState<string>('');
  const [showUploadCode, setShowUploadCode] = useState(false);
  const [uploadAuth, setUploadAuth] = useState<UploadAuthState>(demoOnly ? 'locked' : 'unlocked');

  // Load upload code and verify on mount if token exists
  // Never trust localStorage verified flag alone - always verify with server
  useEffect(() => {
    if (!demoOnly) return;
    
    const stored = localStorage.getItem('rbc_upload_token') ?? '';
    const hasToken = !!stored.trim();
    
    if (!hasToken) {
      // No token - must be locked
      setUploadAuth('locked');
      localStorage.removeItem('rbc_upload_verified');
      return;
    }
    
    // Token exists - load it and verify with server
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

  // Clear upload status when uploads become locked (to avoid showing stale success messages)
  useEffect(() => {
    if (!uploadsEnabled && status && !status.includes('locked') && !status.includes('Invalid')) {
      setStatus('');
    }
  }, [uploadsEnabled, status]);

  const handleUseDemoRunbooks = async () => {
    setUploading(true);
    setDemoStatus('Loading demo runbooks...');
    setStatus(''); // Clear upload status

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
    console.log('[FileDropzone] handleDrop called, uploadsEnabled:', uploadsEnabled);
    if (!uploadsEnabled) {
      console.log('[FileDropzone] Uploads disabled, returning early');
      return;
    }
    const files = Array.from(e.dataTransfer.files) as File[];
    console.log('[FileDropzone] Dropped files:', files.length);
    await uploadFiles(files);
  };

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    console.log('[FileDropzone] handleFileSelect called, uploadsEnabled:', uploadsEnabled);
    if (!uploadsEnabled) {
      console.log('[FileDropzone] Uploads disabled, returning early');
      return;
    }
    const files = Array.from(e.target.files || []) as File[];
    console.log('[FileDropzone] Selected files:', files.length);
    await uploadFiles(files);
  };

  const uploadFiles = async (files: File[]) => {
    console.log('[FileDropzone] uploadFiles called with', files.length, 'files');
    
    // Filter to PDF/MD only
    const validFiles = files.filter(
      file => 
        file.type === 'application/pdf' ||
        file.name.endsWith('.md') ||
        file.name.endsWith('.MD') ||
        file.name.endsWith('.markdown')
    );

    console.log('[FileDropzone] validFiles:', validFiles.length, validFiles.map(f => ({ name: f.name, type: f.type, size: f.size })));

    if (validFiles.length === 0) {
      console.log('[FileDropzone] No valid files, returning early');
      setStatus('Error: Only PDF and Markdown files are supported');
      return;
    }

    console.log('[FileDropzone] Setting uploading=true, status="Uploading..."');
    setUploading(true);
    setStatus('Uploading and processing files...');

    try {
      // Build FormData with files
      const formData = new FormData();
      for (const file of validFiles) {
        formData.append('files', file);
        console.log('[FileDropzone] Added file to FormData:', file.name, file.size, 'bytes');
      }

      // Build headers - include upload token if present
      // IMPORTANT: do NOT set Content-Type manually (browser sets it with boundary)
      const headers: Record<string, string> = {};
      if (uploadCode) {
        headers['x-upload-token'] = uploadCode;
        console.log('[FileDropzone] Including upload token in headers');
      } else {
        console.log('[FileDropzone] No upload token - uploads may be locked');
      }

      console.log('[FileDropzone] Starting fetch to /api/upload...');
      const fetchStartTime = Date.now();
      
      // Upload files directly to server
      const response = await fetch('/api/upload', {
        method: 'POST',
        headers,
        body: formData,
      });

      const fetchDuration = Date.now() - fetchStartTime;
      console.log('[FileDropzone] Fetch completed:', {
        status: response.status,
        ok: response.ok,
        duration: fetchDuration + 'ms',
        headers: Object.fromEntries(response.headers.entries()),
      });

      // Read response body as text first, then parse JSON
      console.log('[FileDropzone] Reading response body...');
      const raw = await response.text();
      console.log('[FileDropzone] Response body length:', raw.length, 'chars');
      console.log('[FileDropzone] Response body preview:', raw.substring(0, 200));
      
      let data: any = null;
      let parseSucceeded = false;
      
      try {
        data = raw ? JSON.parse(raw) : {};
        parseSucceeded = true;
        console.log('[FileDropzone] JSON parse succeeded:', Object.keys(data));
      } catch (parseError) {
        parseSucceeded = false;
        console.error('[FileDropzone] Failed to parse response as JSON:', parseError, 'Raw response:', raw.substring(0, 200));
      }

      // Log response details for debugging
      console.log('[FileDropzone] Upload response summary:', {
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
        console.log('[FileDropzone] Response not OK, handling error...');
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
          setStatus(`Uploads are locked. Request ID: ${requestId}`);
        } else {
          setStatus(`Error: ${errorMessage} (Request ID: ${requestId})`);
        }
        return;
      }

      // Success - build message with inserted filenames
      console.log('[FileDropzone] Response OK, building success message...');
      const requestId = data?.request_id || 'unknown';
      let successMsg = `Success! Indexed ${data.inserted_filenames?.length || data.files_processed || 0} file(s): ${(data.inserted_filenames || []).join(', ')}. `;
      successMsg += `${data.total_chunks || 0} chunks created.`;
      
      // Add verification status
      if (data.verified_searchable === true && data.top_retrieval_preview && data.top_retrieval_preview.length > 0) {
        const firstResult = data.top_retrieval_preview[0];
        successMsg += ` Verified searchable: "${firstResult.textPreview}" (from ${firstResult.filename})`;
      } else if (data.verified_searchable === false) {
        successMsg += ` (Search verification pending - content may not be immediately searchable)`;
      }
      
      successMsg += ` Request ID: ${requestId}`;
      console.log('[FileDropzone] Setting success status:', successMsg);
      setStatus(successMsg);
      console.log('[FileDropzone] Status set, about to exit try block');
    } catch (error) {
      console.error('[FileDropzone] Upload error caught:', error);
      const errorMessage = error instanceof Error ? error.message : 'Upload failed';
      console.log('[FileDropzone] Setting error status:', errorMessage);
      setStatus(`Error: ${errorMessage}`);
    } finally {
      // Always clear uploading state - this is critical
      console.log('[FileDropzone] Finally block: setting uploading=false');
      setUploading(false);
      console.log('[FileDropzone] Upload flow complete');
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
        {/* Only show status if it's from an upload attempt (not from demo runbooks) */}
        {status && (status.includes('Processed') || status.includes('Upload') || status.includes('Error') || status.includes('locked')) && (
          <div className={`mt-2 text-sm ${status.startsWith('Error') ? 'text-red-600' : 'text-gray-600'}`}>
            {status}
          </div>
        )}
      </div>
    </div>
  );
}
