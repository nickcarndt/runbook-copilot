'use client';

import { useState } from 'react';
import Chat from '@/components/Chat';
import FileDropzone from '@/components/FileDropzone';
import { demoRunbooks } from '@/lib/demo-runbooks';

interface Source {
  id: string;
  filename: string;
  chunkIndex: number;
}

interface DebugInfo {
  requestId: string;
  latency: number;
  sources: Source[];
}

export default function Home() {
  const [debugOpen, setDebugOpen] = useState(false);
  const [sources, setSources] = useState<Source[]>([]);
  const [debugInfo, setDebugInfo] = useState<DebugInfo | null>(null);
  const [slackSummary, setSlackSummary] = useState<string>('');
  const [slackLoading, setSlackLoading] = useState(false);
  const [lastQuestion, setLastQuestion] = useState<string>('');
  const [lastAnswer, setLastAnswer] = useState<string>('');
  const [copied, setCopied] = useState(false);

  const handleSourcesUpdate = (newSources: Source[], requestId: string, latency: number) => {
    setSources(newSources);
    setDebugInfo({ requestId, latency, sources: newSources });
  };

  const handleAnswerComplete = (question: string, answer: string) => {
    setLastQuestion(question);
    setLastAnswer(answer);
  };

  const handleDraftSlackUpdate = async () => {
    if (!lastQuestion || !lastAnswer) return;

    setSlackLoading(true);
    try {
      const response = await fetch('/api/slackSummary', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          question: lastQuestion,
          answer: lastAnswer,
        }),
      });

      const data = await response.json();
      if (response.ok) {
        setSlackSummary(data.summary);
      } else {
        setSlackSummary(`Error: ${data.error || 'Failed to generate summary'}`);
      }
    } catch (error) {
      setSlackSummary(`Error: ${error instanceof Error ? error.message : 'Failed to generate summary'}`);
    } finally {
      setSlackLoading(false);
    }
  };

  const handleCopySlackSummary = async () => {
    if (slackSummary) {
      await navigator.clipboard.writeText(slackSummary);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    }
  };

  return (
    <div className="min-h-screen p-8 max-w-6xl mx-auto">
      <h1 className="text-2xl font-bold mb-8">Runbook Copilot</h1>

      {/* Upload Section */}
      <section className="mb-8">
        <h2 className="text-xl font-semibold mb-4">Upload</h2>
        <FileDropzone onDemoRunbooksLoad={() => {}} />
      </section>

      {/* Chat Section */}
      <section className="mb-8">
        <h2 className="text-xl font-semibold mb-4">Chat</h2>
        <Chat
          onSourcesUpdate={handleSourcesUpdate}
          onAnswerComplete={handleAnswerComplete}
        />
      </section>

      {/* Sources */}
      {sources.length > 0 && (
        <section className="mb-8">
          <h2 className="text-xl font-semibold mb-4">Sources</h2>
          <div className="space-y-2">
            {sources.map((source, i) => (
              <div key={i} className="text-sm border rounded p-2">
                <div className="font-medium">{source.filename}</div>
                <div className="text-gray-600">Chunk {source.chunkIndex}</div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Draft Slack Update */}
      <section className="mb-8">
        <h2 className="text-xl font-semibold mb-4">Draft Slack Update</h2>
        <button
          onClick={handleDraftSlackUpdate}
          disabled={slackLoading || !lastQuestion || !lastAnswer}
          className="mb-2 px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:bg-gray-400"
        >
          {slackLoading ? 'Generating...' : 'Draft Slack Update'}
        </button>
        {(!lastQuestion || !lastAnswer) && (
          <div className="text-sm text-gray-500 mb-2">Ask a question first</div>
        )}
        {slackSummary && (
          <div className="border rounded p-4 bg-gray-50">
            <div className="flex justify-between items-start mb-2">
              <div className="text-sm font-medium">Summary:</div>
              <button
                onClick={handleCopySlackSummary}
                className="text-xs text-blue-600 hover:text-blue-800"
              >
                {copied ? 'Copied!' : 'Copy'}
              </button>
            </div>
            <pre className="text-sm whitespace-pre-wrap">{slackSummary}</pre>
          </div>
        )}
      </section>

      {/* Debug Drawer */}
      {debugInfo && (
        <div className="fixed bottom-0 right-0 m-4">
          <button
            onClick={() => setDebugOpen(!debugOpen)}
            className="bg-gray-200 px-4 py-2 rounded-t text-sm"
          >
            Debug {debugOpen ? '▼' : '▲'}
          </button>
          {debugOpen && (
            <div className="bg-gray-100 p-4 rounded-t border border-gray-300 max-h-96 overflow-auto w-96">
              <div className="space-y-2 text-xs">
                <div>
                  <span className="font-semibold">Request ID:</span> {debugInfo.requestId}
                </div>
                <div>
                  <span className="font-semibold">Latency:</span> {debugInfo.latency}ms
                </div>
                <div>
                  <span className="font-semibold">Retrieved Sources:</span> {debugInfo.sources.length}
                </div>
                {debugInfo.sources.length > 0 && (
                  <div className="mt-2">
                    <div className="font-semibold mb-1">Chunk IDs & Sources:</div>
                    <div className="space-y-1 max-h-64 overflow-auto">
                      {debugInfo.sources.map((source, i) => (
                        <div key={i} className="bg-white p-2 rounded border text-xs">
                          <div className="font-mono text-xs break-all">{source.id}</div>
                          <div className="text-gray-700">{source.filename} (chunk {source.chunkIndex})</div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                <details className="mt-2">
                  <summary className="cursor-pointer font-semibold">Full JSON</summary>
                  <pre className="mt-1 text-xs bg-white p-2 rounded border overflow-auto max-h-32">
                    {JSON.stringify(debugInfo, null, 2)}
                  </pre>
                </details>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
