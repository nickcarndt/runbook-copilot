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
}

export default function Chat({ onSourcesUpdate, onAnswerComplete }: ChatProps) {
  const [messages, setMessages] = useState<Array<{ role: 'user' | 'assistant'; content: string }>>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [currentRequestId, setCurrentRequestId] = useState<string>('');
  const [startTime, setStartTime] = useState<number>(0);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || loading) return;

    const userMessage = { role: 'user' as const, content: input };
    const question = input;
    setMessages(prev => [...prev, userMessage]);
    setInput('');
    setLoading(true);
    setStartTime(Date.now());

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
      console.error('Chat error:', error);
      setMessages(prev => [...prev, { role: 'assistant', content: 'Error: Failed to get response' }]);
    } finally {
      setLoading(false);
    }
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
      <form onSubmit={handleSubmit}>
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
