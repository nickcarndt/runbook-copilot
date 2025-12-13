'use client';

import { useState, useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import Chat, { ChatRef } from '@/components/Chat';
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
  const [publicDemo, setPublicDemo] = useState(false);
  const [errorRequestId, setErrorRequestId] = useState<string>('');
  const [suggestedQuestions, setSuggestedQuestions] = useState<string[]>([]);
  const [resetToast, setResetToast] = useState(false);
  const [resetKey, setResetKey] = useState(0);
  const chatRef = useRef<ChatRef>(null);
  const router = useRouter();

  useEffect(() => {
    // Fetch public demo config
    fetch('/api/config')
      .then(res => res.json())
      .then(data => setPublicDemo(data.publicDemo || false))
      .catch(() => {});
  }, []);

  const handleSourcesUpdate = (newSources: Source[], requestId: string, latency: number, error?: { message: string; code?: string }) => {
    setSources(newSources);
    if (error) {
      setErrorRequestId(requestId);
      setDebugInfo({ requestId, latency, sources: newSources });
    } else {
      setErrorRequestId('');
      setDebugInfo({ requestId, latency, sources: newSources });
    }
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
        if (data.request_id) {
          setErrorRequestId(data.request_id);
        }
      } else {
        const errorMsg = data.error?.message || data.error || 'Failed to generate summary';
        setSlackSummary(`Error: ${errorMsg}`);
        if (data.request_id) {
          setErrorRequestId(data.request_id);
        }
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Failed to generate summary';
      setSlackSummary(`Error: ${errorMsg}`);
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

  const handleUploadSuccess = (data: { filenames: string[]; chunks: number; requestId: string }) => {
    // Generate human-friendly suggested questions for demo flow
    const questions = [
      "What's the fastest safe triage for this incident?",
      "What are the first 5 commands to run?",
      "Draft a Slack update for this incident",
    ];
    
    setSuggestedQuestions(questions);
  };

  const handleUploadStart = () => {
    // Clear suggested questions when new upload starts
    setSuggestedQuestions([]);
  };

  const handleResetDemo = () => {
    // Clear all UI state
    setSuggestedQuestions([]);
    setSources([]);
    setDebugInfo(null);
    setSlackSummary('');
    setLastQuestion('');
    setLastAnswer('');
    setErrorRequestId('');
    
    // Clear localStorage keys
    localStorage.removeItem('rbc_upload_token');
    localStorage.removeItem('rbc_upload_verified');
    localStorage.removeItem('rbc_public_demo');
    localStorage.removeItem('rbc_demo_loaded');
    
    // Reset chat if ref is available
    if (chatRef.current) {
      chatRef.current.reset();
    }
    
    // Trigger FileDropzone reset via key change
    setResetKey(prev => prev + 1);
    
    // Show toast
    setResetToast(true);
    setTimeout(() => setResetToast(false), 2000);
    
    // Force refresh
    router.refresh();
  };

  return (
    <div className="min-h-screen p-8 max-w-6xl mx-auto">
      <h1 className="text-2xl font-bold mb-8">Runbook Copilot</h1>

      {publicDemo && (
        <div className="mb-4 p-3 bg-yellow-100 border border-yellow-400 rounded text-sm text-yellow-800">
          Public demo — do not upload sensitive data.
        </div>
      )}

      {/* Upload Section */}
      <section className="mb-8">
        <div className="flex justify-between items-center mb-4">
          <h2 className="text-xl font-semibold">Upload</h2>
          <button
            onClick={handleResetDemo}
            type="button"
            className="text-xs px-2 py-1 bg-gray-100 text-gray-700 border border-gray-300 rounded hover:bg-gray-200 focus:outline-none focus:ring-1 focus:ring-gray-500 focus:ring-offset-1 transition-colors"
          >
            Reset demo
          </button>
          {resetToast && (
            <div className="fixed bottom-4 right-4 bg-gray-900 text-white text-xs px-3 py-2 rounded shadow-lg z-50">
              Demo reset.
            </div>
          )}
        </div>
        {/* Render FileDropzone once - publicDemo prop will update but component won't remount */}
        <FileDropzone onDemoRunbooksLoad={() => {}} demoOnly={publicDemo} onUploadSuccess={handleUploadSuccess} onUploadStart={handleUploadStart} resetKey={resetKey} />
      </section>

      {/* Chat Section */}
      <section className="mb-8">
        <h2 className="text-xl font-semibold mb-4">Chat</h2>
        <Chat
          ref={chatRef}
          onSourcesUpdate={handleSourcesUpdate}
          onAnswerComplete={handleAnswerComplete}
          suggestedQuestions={suggestedQuestions}
          onQuestionSubmit={() => setSuggestedQuestions([])}
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
                  <span className="font-semibold">Request ID:</span> {errorRequestId || debugInfo.requestId}
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
