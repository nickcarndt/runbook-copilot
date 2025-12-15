'use client';

import React, { useState, useImperativeHandle, forwardRef, useCallback } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

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

export interface ChatRef {
  reset: () => void;
}

const Chat = forwardRef<ChatRef, ChatProps>(({ onSourcesUpdate, onAnswerComplete, suggestedQuestions = [], onQuestionSubmit }, ref) => {
  const [messages, setMessages] = useState<Array<{ role: 'user' | 'assistant'; content: string }>>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [currentRequestId, setCurrentRequestId] = useState<string>('');
  const [startTime, setStartTime] = useState<number>(0);
  const [isThinking, setIsThinking] = useState(false);
  const [hasReceivedFirstToken, setHasReceivedFirstToken] = useState(false);

  // Expose reset function via ref
  useImperativeHandle(ref, () => ({
    reset: () => {
      setMessages([]);
      setInput('');
      setLoading(false);
      setCurrentRequestId('');
      setStartTime(0);
      setIsThinking(false);
      setHasReceivedFirstToken(false);
    }
  }));

  const linkifySources = useCallback((text: string) => {
    // Convert `[Source: foo.pdf]` -> `[Source: foo.pdf](#sources)`.
    // Avoid double-linking if it's already followed by `(#sources)`.
    return text.replace(/\[Source:\s*([^\]]+)\](?!\(#sources\))/g, (_m, filename) => {
      const clean = String(filename).trim();
      return `[Source: ${clean}](#sources)`;
    });
  }, []);

  const normalizeCitations = useCallback((text: string) => {
    // Convert plain text citations like "Source: somefile.pdf." or "Source: somefile.md" 
    // into markdown links: "Source: [somefile.pdf](#sources)"
    // 
    // IDEMPOTENT: This function is safe to call multiple times on the same text.
    // It only acts as a fallback for plain-text citations. The agent prompt already
    // outputs canonical format: "Source: [filename](#sources)".
    //
    // Nuke-proof: Skip entire line if it already contains ](#sources) or Source: [
    // Example: normalizeCitations("Source: [file.pdf](#sources)") returns unchanged
    //          normalizeCitations("Source: file.pdf.") returns "Source: [file.pdf](#sources)"
    const lines = text.split('\n');
    const normalizedLines = lines.map(line => {
      // Skip lines that already contain markdown link markers (idempotent check)
      if (line.includes('](#sources)') || line.includes('Source: [')) {
        return line;
      }
      
      // Only process lines that match plain text citation pattern (fallback only)
      return line.replace(/Source:\s*([^\s]+\.(pdf|md|PDF|MD))[.,;:!?]*/g, (match, filename) => {
        const clean = filename.replace(/[.,;:!?]+$/, '');
        return `Source: [${clean}](#sources)`;
      });
    });
    
    let normalized = normalizedLines.join('\n');
    
    // Defensive cleanup: collapse repeated ](#sources) sequences (safety net)
    normalized = normalized.replace(/(\]\(#sources\))+/g, '](#sources)');
    
    return normalized;
  }, []);

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
    setIsThinking(true);
    setHasReceivedFirstToken(false);
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
            onSourcesUpdate([], requestId || '', Date.now() - submitStartTime, { message: errorMessage, code: errorCode });
          }
        } catch (e) {
          // If JSON parsing fails, use status text
          errorMessage = `${response.status} ${response.statusText}`;
          if (onSourcesUpdate) {
            onSourcesUpdate([], requestId || '', Date.now() - submitStartTime, { message: errorMessage, code: String(response.status) });
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
          // Store raw streamed text during streaming (no normalization yet)
          assistantMessage += chunk;
          if (!hasReceivedFirstToken && assistantMessage.trim().length > 0) {
            setHasReceivedFirstToken(true);
          }
        }

        setMessages(prev => {
          const newMessages = [...prev];
          if (newMessages[newMessages.length - 1]?.role === 'assistant') {
            // Display raw text during streaming
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
              // Normalize citations once after stream completes
              assistantMessage = linkifySources(assistantMessage);
              assistantMessage = normalizeCitations(assistantMessage);
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

      const latency = Date.now() - submitStartTime;
      
      // Notify parent of sources and debug info
      if (onSourcesUpdate && sources.length > 0) {
        onSourcesUpdate(sources, requestId, latency);
      }

      assistantMessage = linkifySources(assistantMessage);
      assistantMessage = normalizeCitations(assistantMessage);

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
      setIsThinking(false);
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
            <div className={`inline-block p-2 rounded ${msg.role === 'user' ? 'bg-blue-100' : 'bg-gray-100'}`}>
              {msg.role === 'assistant' ? (
                <div className="prose prose-sm max-w-none">
                  <ReactMarkdown
                    remarkPlugins={[remarkGfm]}
                    components={{
                      a: ({ href, children, ...props }: any) => {
                        // Check if this is a #sources link (exact match or ending in #sources with optional punctuation)
                        const isSourcesLink = href && /#sources[.,;:!?]*$/.test(href);
                        
                        // Check if this is a citation link:
                        // 1. Link text looks like a filename (ends in .pdf or .md)
                        // 2. Link text contains "Source:" (citation pattern)
                        const linkText = String(children).trim();
                        const isFilenameLink = /\.(pdf|md)$/i.test(linkText);
                        const containsSource = /Source:/i.test(linkText);
                        
                        // Treat as citation if it's a filename link or contains "Source:"
                        // and href is not a full URL (to avoid breaking external links)
                        const isCitationLink = (isFilenameLink || containsSource) && href && !href.startsWith('http') && !href.startsWith('/');
                        
                        if (isSourcesLink || isCitationLink) {
                          return (
                            <a
                              href={href}
                              onClick={(e) => {
                                e.preventDefault();
                                const el = document.getElementById('sources');
                                if (el) {
                                  const y = el.getBoundingClientRect().top + window.scrollY - 96;
                                  window.scrollTo({ top: y, behavior: 'smooth' });
                                } else {
                                  console.warn('[sources-link] anchor not found', { href, linkText });
                                }
                              }}
                              className="text-blue-600 hover:text-blue-800 underline"
                              {...props}
                            >
                              {children}
                            </a>
                          );
                        }
                        return (
                          <a
                            href={href}
                            target="_blank"
                            rel="noreferrer"
                            className="text-blue-600 hover:text-blue-800 underline"
                            {...props}
                          >
                            {children}
                          </a>
                        );
                      },
                      // Style inline code
                      code: ({ inline, className, children, ...props }: any) => {
                        if (inline) {
                          return (
                            <code className="bg-gray-100 px-1 py-0.5 rounded text-sm font-mono" {...props}>
                              {children}
                            </code>
                          );
                        }
                        return (
                          <code className="block bg-gray-100 p-2 rounded text-sm font-mono overflow-x-auto" {...props}>
                            {children}
                          </code>
                        );
                      },
                      // Style code blocks
                      pre: ({ children }: any) => {
                        return <pre className="bg-gray-100 p-2 rounded text-sm font-mono overflow-x-auto my-2">{children}</pre>;
                      },
                    }}
                  >
                    {msg.content}
                  </ReactMarkdown>
                </div>
              ) : (
                <span className="whitespace-pre-wrap">{msg.content}</span>
              )}
            </div>
          </div>
        ))}
        {isThinking && !hasReceivedFirstToken && (
          <div className="text-left">
            <div className="inline-block p-2 rounded bg-gray-100">
              <div className="prose prose-sm max-w-none" aria-live="polite">
                <span className="sr-only">Assistant is typing…</span>
                <div className="flex items-center gap-1">
                  <span className="w-2 h-2 bg-gray-400 rounded-full animate-pulse"></span>
                  <span className="w-2 h-2 bg-gray-400 rounded-full animate-pulse" style={{ animationDelay: '0.2s' }}></span>
                  <span className="w-2 h-2 bg-gray-400 rounded-full animate-pulse" style={{ animationDelay: '0.4s' }}></span>
                </div>
              </div>
            </div>
          </div>
        )}
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
});

Chat.displayName = 'Chat';

export default Chat;
