'use client';

import React, { useState, useEffect } from 'react';
import { put } from '@vercel/blob';

interface FileDropzoneProps {
  onDemoRunbooksLoad?: () => void;
  demoOnly?: boolean; // When true, hides upload UI (for public demos)
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

export default function FileDropzone({ onDemoRunbooksLoad, demoOnly = false }: FileDropzoneProps) {
  const [uploading, setUploading] = useState(false);
  const [status, setStatus] = useState<string>('');
  const [blobAvailable, setBlobAvailable] = useState<boolean | null>(null);

  // Check if Blob is available (we'll detect this on first upload attempt)
  useEffect(() => {
    // We can't check env vars on client, so we'll detect on first use
    setBlobAvailable(null);
  }, []);

  const handleUseDemoRunbooks = async () => {
    setUploading(true);
    setStatus('Loading demo runbooks...');

    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      
      const response = await fetch('/api/seedDemo', {
        method: 'POST',
        headers,
      });

      const data = await parseResponse(response);
      
      if (response.ok) {
        setStatus(
          `Success! Indexed ${data.inserted_documents} document(s), ` +
          `${data.inserted_chunks} chunks. Request ID: ${data.request_id}`
        );
        onDemoRunbooksLoad?.();
      } else {
        const errorMsg = data.error?.message || data.error || 'Failed to load demo runbooks';
        setStatus(`Error: ${errorMsg} (${data.error?.code || 'UNKNOWN'})`);
      }
    } catch (error) {
      console.error('Demo runbooks error:', error);
      const errorMessage = error instanceof Error ? error.message : 'Failed to load demo runbooks';
      setStatus(`Error: ${errorMessage}`);
    } finally {
      setUploading(false);
    }
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    const files = Array.from(e.dataTransfer.files) as File[];
    await uploadFiles(files);
  };

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
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
    setStatus('Uploading to Blob...');

    try {
      // Upload files to Vercel Blob
      const blobUrls: string[] = [];
      for (const file of validFiles) {
        try {
          const blob = await put(file.name, file, {
            access: 'public',
            contentType: file.type,
          });
          blobUrls.push(blob.url);
        } catch (blobError: any) {
          // Check for Blob token error
          const errorMsg = blobError?.message || String(blobError);
          if (errorMsg.includes('No token found') || errorMsg.includes('token') || errorMsg.includes('BLOB_READ_WRITE_TOKEN')) {
            setBlobAvailable(false);
            setStatus('Blob uploads require Vercel Blob to be configured; use demo runbooks for local testing.');
            setUploading(false);
            return;
          }
          throw blobError;
        }
      }

      setBlobAvailable(true);
      setStatus('Processing files...');

      // Send blob URLs to server for processing
      const response = await fetch('/api/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ blobUrls }),
      });

      const data = await parseResponse(response);
      
      if (response.ok) {
        setStatus(
          `Success! Processed ${data.files_processed} file(s), ` +
          `${data.total_chunks} chunks. Request ID: ${data.request_id}`
        );
      } else {
        const errorCode = data.error?.code || '';
        if (response.status === 401 && (errorCode === 'UNAUTHORIZED' || errorCode === 'UPLOAD_LOCKED')) {
          setStatus('Uploads are locked for the public demo. Ask Nick for an upload code.');
        } else {
          const errorMsg = data.error?.message || data.error || 'Upload failed';
          setStatus(`Error: ${errorMsg} (${errorCode || 'UNKNOWN'})`);
        }
      }
    } catch (error) {
      console.error('Upload error:', error);
      const errorMessage = error instanceof Error ? error.message : 'Upload failed';
      if (errorMessage.includes('No token found') || errorMessage.includes('token') || errorMessage.includes('BLOB_READ_WRITE_TOKEN')) {
        setBlobAvailable(false);
        setStatus('Blob uploads require Vercel Blob to be configured; use demo runbooks for local testing.');
      } else if (errorMessage.includes('Non-JSON response')) {
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
      <div className="flex gap-4">
        <button
          onClick={handleUseDemoRunbooks}
          disabled={uploading}
          className="px-4 py-2 bg-green-600 text-white rounded hover:bg-green-700 disabled:bg-gray-400"
        >
          Use demo runbooks
        </button>
        {!demoOnly && <div className="text-sm text-gray-600 self-center">or</div>}
      </div>

      {!demoOnly && (
        <div
          onDrop={handleDrop}
          onDragOver={(e) => e.preventDefault()}
          className={`border-2 border-dashed rounded-lg p-8 text-center ${
            blobAvailable === false 
              ? 'border-gray-200 bg-gray-50' 
              : 'border-gray-300'
          }`}
        >
          <input
            type="file"
            accept=".pdf,.md,.markdown"
            onChange={handleFileSelect}
            disabled={uploading || blobAvailable === false}
            multiple
            className="hidden"
            id="file-input"
          />
          {blobAvailable === false ? (
            <div className="text-sm text-gray-600">
              Blob uploads require Vercel Blob to be configured; use demo runbooks for local testing.
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
          {status && (
            <div className={`mt-2 text-sm ${status.startsWith('Error') ? 'text-red-600' : 'text-gray-600'}`}>
              {status}
            </div>
          )}
        </div>
      )}
      {status && demoOnly && (
        <div className={`text-sm ${status.startsWith('Error') ? 'text-red-600' : 'text-gray-600'}`}>
          {status}
        </div>
      )}
    </div>
  );
}
