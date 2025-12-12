'use client';

import React, { useState } from 'react';
import { put } from '@vercel/blob';
import { demoRunbooks } from '@/lib/demo-runbooks';

interface FileDropzoneProps {
  onDemoRunbooksLoad?: () => void;
}

export default function FileDropzone({ onDemoRunbooksLoad }: FileDropzoneProps) {
  const [uploading, setUploading] = useState(false);
  const [status, setStatus] = useState<string>('');

  const handleUseDemoRunbooks = async () => {
    setUploading(true);
    setStatus('Loading demo runbooks...');

    try {
      // Convert demo runbooks to markdown files and upload
      const blobUrls: string[] = [];
      
      for (const runbook of demoRunbooks) {
        const markdownContent = runbook.content;
        const blob = new Blob([markdownContent], { type: 'text/markdown' });
        const file = new File([blob], `${runbook.title.replace(/\s+/g, '-')}.md`, {
          type: 'text/markdown',
        });

        const uploadedBlob = await put(file.name, file, {
          access: 'public',
          contentType: 'text/markdown',
        });
        blobUrls.push(uploadedBlob.url);
      }

      setStatus('Processing demo runbooks...');

      // Send blob URLs to server for processing
      const response = await fetch('/api/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ blobUrls }),
      });

      const data = await response.json();
      if (response.ok) {
        setStatus(
          `Success! Processed ${data.files_processed} file(s), ` +
          `${data.total_chunks} chunks. Request ID: ${data.request_id}`
        );
        onDemoRunbooksLoad?.();
      } else {
        setStatus(`Error: ${data.error || 'Upload failed'}`);
      }
    } catch (error) {
      console.error('Demo runbooks error:', error);
      setStatus(`Error: ${error instanceof Error ? error.message : 'Failed to load demo runbooks'}`);
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
        const blob = await put(file.name, file, {
          access: 'public',
          contentType: file.type,
        });
        blobUrls.push(blob.url);
      }

      setStatus('Processing files...');

      // Send blob URLs to server for processing
      const response = await fetch('/api/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ blobUrls }),
      });

      const data = await response.json();
      if (response.ok) {
        setStatus(
          `Success! Processed ${data.files_processed} file(s), ` +
          `${data.total_chunks} chunks. Request ID: ${data.request_id}`
        );
      } else {
        setStatus(`Error: ${data.error || 'Upload failed'}`);
      }
    } catch (error) {
      console.error('Upload error:', error);
      setStatus(`Error: ${error instanceof Error ? error.message : 'Upload failed'}`);
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
        <div className="text-sm text-gray-600 self-center">or</div>
      </div>

      <div
        onDrop={handleDrop}
        onDragOver={(e) => e.preventDefault()}
        className="border-2 border-dashed border-gray-300 rounded-lg p-8 text-center"
      >
        <input
          type="file"
          accept=".pdf,.md,.markdown"
          onChange={handleFileSelect}
          disabled={uploading}
          multiple
          className="hidden"
          id="file-input"
        />
        <label
          htmlFor="file-input"
          className={`cursor-pointer ${
            uploading ? 'text-gray-400' : 'text-blue-600 hover:text-blue-800'
          }`}
        >
          {uploading ? 'Processing...' : 'Upload my own runbooks'}
        </label>
        {status && (
          <div className={`mt-2 text-sm ${status.startsWith('Error') ? 'text-red-600' : 'text-gray-600'}`}>
            {status}
          </div>
        )}
      </div>
    </div>
  );
}
