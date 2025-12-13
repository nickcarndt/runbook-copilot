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

  // Load upload code and verified state from localStorage
  useEffect(() => {
    const stored = localStorage.getItem('rbc_upload_token');
    const verified = localStorage.getItem('rbc_upload_verified') === 'true';
    if (stored && verified && demoOnly) {
      setUploadCode(stored);
      setUploadAuth('unlocked');
    }
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
  const uploadsEnabled = !demoOnly || uploadAuth === 'unlocked';

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
    if (!uploadsEnabled) return;
    const files = Array.from(e.dataTransfer.files) as File[];
    await uploadFiles(files);
  };

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!uploadsEnabled) return;
    const files = Array.from(e.target.files || []) as File[];
    await uploadFiles(files);
  };

  const uploadFiles = async (files: File[]) => {
    // Filter to PDF/MD only
    const validFiles = files.filter(
      file => 
        file.type === 'application/pdf' ||
        file.name.endsWith('.md') ||
        file.name.endsWith('.MD') ||
        file.name.endsWith('.markdown')
    );

    if (validFiles.length === 0) {
      setStatus('Error: Only PDF and Markdown files are supported');
      return;
    }

    setUploading(true);
    setStatus('Uploading and processing files...');

    try {
      // Build FormData with files
      const formData = new FormData();
      for (const file of validFiles) {
        formData.append('files', file);
      }

      // Build headers - include upload token if present
      const headers: Record<string, string> = {};
      if (uploadCode) {
        headers['x-upload-token'] = uploadCode;
      }

      // Upload files directly to server
      const response = await fetch('/api/upload', {
        method: 'POST',
        headers,
        body: formData,
      });

      const data = await parseResponse(response);
      
      if (response.ok) {
        setStatus(
          `Success! Processed ${data.files_processed} file(s), ` +
          `${data.total_chunks} chunks. Request ID: ${data.request_id}`
        );
      } else {
        const errorCode = data.error?.code || '';
        if (response.status === 401 && (errorCode === 'UNAUTHORIZED' || errorCode === 'UPLOAD_LOCKED' || errorCode === 'INVALID_UPLOAD_CODE')) {
          // Relock on 401
          if (demoOnly) {
            setUploadAuth('locked');
            localStorage.removeItem('rbc_upload_verified');
            localStorage.removeItem('rbc_upload_token');
          }
          setStatus('Uploads are locked for the public demo. Ask Nick for an upload code.');
        } else if (errorCode === 'BLOB_NOT_CONFIGURED') {
          setStatus(`Error: ${data.error?.message || 'Blob storage not configured'} (Request ID: ${data.request_id})`);
        } else {
          const errorMsg = data.error?.message || data.error || 'Upload failed';
          setStatus(`Error: ${errorMsg} (${errorCode || 'UNKNOWN'})`);
        }
      }
    } catch (error) {
      console.error('Upload error:', error);
      const errorMessage = error instanceof Error ? error.message : 'Upload failed';
      if (errorMessage.includes('Non-JSON response')) {
        setStatus(`Error: ${errorMessage}`);
      } else {
        setStatus(`Error: ${errorMessage}`);
      }
    } finally {
      setUploading(false);
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
                // Reset to locked/invalid when code changes (don't verify on keystroke)
                if (uploadAuth === 'unlocked' || uploadAuth === 'invalid') {
                  setUploadAuth('locked');
                  localStorage.removeItem('rbc_upload_verified');
                  if (!newCode.trim()) {
                    localStorage.removeItem('rbc_upload_token');
                  }
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
              {uploadAuth === 'checking' ? 'Verifying...' : uploadAuth === 'unlocked' ? 'Unlocked' : 'Unlock uploads'}
            </button>
          </div>
          {uploadAuth === 'unlocked' && (
            <p className="mt-2 text-sm text-green-600">
              ✓ Uploads unlocked
            </p>
          )}
          {uploadAuth === 'invalid' && (
            <p className="mt-2 text-sm text-red-600">
              Invalid code. Please check and try again.
            </p>
          )}
          {uploadAuth === 'locked' && uploadCode && (
            <p className="mt-2 text-sm text-gray-600">
              Optional — needed only to upload your own runbooks.
            </p>
          )}
          {uploadAuth === 'locked' && !uploadCode && (
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
            Uploads are locked for the public demo. Ask Nick for an upload code.
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
