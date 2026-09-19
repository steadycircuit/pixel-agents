import { useEffect, useRef, useState } from 'react';

import type { AgentConversation } from '../../../core/src/messages.js';
import { transport } from '../transport/index.js';

interface Props {
  agentId: number;
  displayName?: string;
  messages: AgentConversation['messages'];
  onClose: () => void;
}

export function ConversationDrawer({ agentId, displayName, messages, onClose }: Props) {
  const [prompt, setPrompt] = useState('');
  const feedRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    transport.send({ type: 'requestAgentConversation', id: agentId });
    const timer = window.setInterval(() => {
      transport.send({ type: 'requestAgentConversation', id: agentId });
    }, 1800);
    return () => window.clearInterval(timer);
  }, [agentId]);

  useEffect(() => {
    // Set the scroll position directly so a long history opens at the newest
    // message instead of visibly scrolling from the top.
    const feed = feedRef.current;
    if (feed) feed.scrollTop = feed.scrollHeight;
  }, [messages.length]);

  const send = () => {
    const value = prompt.trim();
    if (!value) return;
    transport.send({ type: 'sendAgentPrompt', id: agentId, prompt: value });
    setPrompt('');
  };

  const title = displayName ?? `Agent ${agentId}`;
  const agentFirstName = displayName?.trim().split(/\s+/)[0] ?? `Agent ${agentId}`;
  return (
    <aside className="conversation-drawer" aria-label={`Conversation with ${title}`}>
      <div className="conversation-header">
        <div>
          <div className="conversation-kicker">CONVERSATION HISTORY</div>
          <h2>{title}</h2>
        </div>
        <button className="conversation-close" onClick={onClose} aria-label="Close conversation">
          ×
        </button>
      </div>
      <div ref={feedRef} className="conversation-feed">
        {messages.length === 0 && (
          <div className="conversation-empty">No conversation recorded yet.</div>
        )}
        {messages.map((message, index) => {
          const previous = messages[index - 1];
          const startsRoleRun = !previous || previous.role !== message.role;
          return (
            <div
              key={`${message.timestamp ?? index}-${index}`}
              className={`comic-bubble ${message.role}`}
            >
              {startsRoleRun && (
                <div className="bubble-label">
                  {message.role === 'user' ? 'YOU' : agentFirstName}
                </div>
              )}
              <div className="bubble-text">{message.text}</div>
            </div>
          );
        })}
      </div>
      <div className="conversation-compose">
        <textarea
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              send();
            }
          }}
          placeholder={`Reply to ${agentFirstName}…`}
          rows={3}
        />
        <button className="conversation-send" onClick={send} disabled={!prompt.trim()}>
          SEND ✦
        </button>
      </div>
    </aside>
  );
}
