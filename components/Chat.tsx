'use client';

import React, { useState } from 'react';

interface Source {
  id: string;
  filename: string;
  chunkIndex: number;
}

interface ChatProps {
  onSourcesUpdate?: (sources: Source[], requestId: string, latency: number, error?: { message: string; code?: string }) => void;
  onAnswerComplete?: (question: string, answer: string) => void;
  suggestedQuestions?: string[];
  onQuestionSubmit?: () => void; // Callback when user submits a question (to clear suggested questions)
}

export default function Chat({ onSourcesUpdate, onAnswerComplete, suggestedQuestions = [], onQuestionSubmit }: ChatProps) {
  const [messages, setMessages] = useState<Array<{ role: 'user' | 'assistant'; content: string }>>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [currentRequestId, setCurrentRequestId] = useState<string>('');
  const [startTime, setStartTime] = useState<number>(0);

  const submitQuestion = async (question: string) => {
    if (!question.trim() || loading) return;

    // Notify parent to clear suggested questions when user submits
    if (onQuestionSubmit) {
      onQuestionSubmit();
    }

    const userMessage = { role: 'user' as const, content: question };
    setMessages(prev => [...prev, userMessage]);
    setInput('');
    setLoading(true);
    const submitStartTime = Date.now();
    setStartTime(submitStartTime);

    try {
      const response = await fetch('/api/query', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: question }),
      });

      const requestId = response.headers.get('X-Request-ID') || '';
      setCurrentRequestId(requestId);

      // Handle non-200 responses
      if (!response.ok) {
        let errorMessage = 'Failed to get response';
        let errorCode = 'UNKNOWN';
        try {
          const errorData = await response.json();
          errorMessage = errorData.error?.message || errorData.error || errorMessage;
          errorCode = errorData.error?.code || errorCode;
          if (onSourcesUpdate) {
            onSourcesUpdate([], requestId || '', Date.now() - startTime, { message: errorMessage, code: errorCode });
          }
        } catch (e) {
          // If JSON parsing fails, use status text
          errorMessage = `${response.status} ${response.statusText}`;
          if (onSourcesUpdate) {
            onSourcesUpdate([], requestId || '', Date.now() - startTime, { message: errorMessage, code: String(response.status) });
          }
        }
        setMessages(prev => [...prev, { role: 'assistant', content: `Error: ${errorMessage}` }]);
        setLoading(false);
        return;
      }

      if (!response.body) throw new Error('No response body');

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let assistantMessage = '';
      let sources: Source[] = [];

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value);
        
        // Check for sources tag
        if (chunk.includes('<SOURCES>')) {
          const sourcesMatch = chunk.match(/<SOURCES>([\s\S]*?)<\/SOURCES>/);
          if (sourcesMatch) {
            try {
              const sourcesData = JSON.parse(sourcesMatch[1]);
              if (sourcesData.sources && Array.isArray(sourcesData.sources)) {
                sources = sourcesData.sources;
                // Remove sources tag from message
                assistantMessage = assistantMessage.replace(/<SOURCES>.*?<\/SOURCES>/s, '').trim();
              }
            } catch (e) {
              // Ignore parsing errors
            }
          }
        } else {
          assistantMessage += chunk;
        }

        setMessages(prev => {
          const newMessages = [...prev];
          if (newMessages[newMessages.length - 1]?.role === 'assistant') {
            newMessages[newMessages.length - 1].content = assistantMessage;
          } else {
            newMessages.push({ role: 'assistant', content: assistantMessage });
          }
          return newMessages;
        });
      }

      // Extract sources if not already found
      if (sources.length === 0 && assistantMessage.includes('<SOURCES>')) {
        const sourcesMatch = assistantMessage.match(/<SOURCES>(.*?)<\/SOURCES>/s);
        if (sourcesMatch) {
          try {
            const sourcesData = JSON.parse(sourcesMatch[1]);
            if (sourcesData.sources && Array.isArray(sourcesData.sources)) {
              sources = sourcesData.sources;
              assistantMessage = assistantMessage.replace(/<SOURCES>.*?<\/SOURCES>/s, '').trim();
              setMessages(prev => {
                const newMessages = [...prev];
                if (newMessages[newMessages.length - 1]?.role === 'assistant') {
                  newMessages[newMessages.length - 1].content = assistantMessage;
                }
                return newMessages;
              });
            }
          } catch (e) {
            // Ignore parsing errors
          }
        }
      }

      const latency = Date.now() - startTime;
      
      // Notify parent of sources and debug info
      if (onSourcesUpdate && sources.length > 0) {
        onSourcesUpdate(sources, requestId, latency);
      }

      // Notify parent of completed answer
      if (onAnswerComplete) {
        onAnswerComplete(question, assistantMessage);
      }
    } catch (error) {
      // Only log errors in development or if DEBUG_UPLOADS is enabled
      if (process.env.NODE_ENV === 'development' || (typeof window !== 'undefined' && (window as any).__DEBUG_UPLOADS === true)) {
        console.error('Chat error:', error);
      }
      setMessages(prev => [...prev, { role: 'assistant', content: 'Error: Failed to get response' }]);
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    await submitQuestion(input);
  };

  return (
    <div className="border rounded-lg p-4">
      <div className="h-64 overflow-y-auto mb-4 space-y-2">
        {messages.map((msg, i) => (
          <div key={i} className={msg.role === 'user' ? 'text-right' : 'text-left'}>
            <div className={`inline-block p-2 rounded ${msg.role === 'user' ? 'bg-blue-100' : 'bg-gray-100'} ${msg.role === 'assistant' ? 'whitespace-pre-wrap' : ''}`}>
              {msg.content}
            </div>
          </div>
        ))}
      </div>
      {suggestedQuestions.length > 0 && (
        <div className="mb-3">
          <div className="text-xs text-gray-600 mb-2">Suggested questions:</div>
          <div className="flex flex-wrap gap-2">
            {suggestedQuestions.map((q, i) => (
              <button
                key={i}
                type="button"
                onClick={() => submitQuestion(q)}
                disabled={loading}
                className="text-xs px-3 py-1.5 bg-blue-50 text-blue-700 border border-blue-200 rounded-full hover:bg-blue-100 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {q}
              </button>
            ))}
          </div>
        </div>
      )}
      <form onSubmit={handleSubmit} id="chat-form">
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Ask a question..."
          className="w-full border rounded px-3 py-2"
          disabled={loading}
        />
      </form>
    </div>
  );
}
