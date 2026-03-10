import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Sparkles, Send, Trash2, User } from "lucide-react";
import {
  streamChat,
  type ChatMessage,
  type ChatSource,
} from "@/lib/api";

interface DisplayMessage {
  role: "user" | "assistant";
  content: string;
  sources?: ChatSource[];
}

interface ChatPanelProps {
  /** Initial query from search — triggers automatic first message */
  initialQuery?: string;
}

function LoadingDots() {
  return (
    <span className="inline-flex gap-1 items-center">
      <span className="h-1.5 w-1.5 rounded-full bg-primary animate-bounce [animation-delay:0ms]" />
      <span className="h-1.5 w-1.5 rounded-full bg-primary animate-bounce [animation-delay:150ms]" />
      <span className="h-1.5 w-1.5 rounded-full bg-primary animate-bounce [animation-delay:300ms]" />
    </span>
  );
}

export function ChatPanel({ initialQuery }: ChatPanelProps) {
  const navigate = useNavigate();
  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  const [input, setInput] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const lastInitialQueryRef = useRef("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Auto-scroll to bottom
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const sendMessage = useCallback(
    (userText: string, history: DisplayMessage[]) => {
      const userMsg: DisplayMessage = { role: "user", content: userText };
      const newMessages = [...history, userMsg];
      setMessages([...newMessages, { role: "assistant", content: "" }]);
      setIsStreaming(true);

      abortRef.current?.abort();

      const chatMessages: ChatMessage[] = newMessages.map((m) => ({
        role: m.role,
        content: m.content,
      }));

      let accumulated = "";
      let sources: ChatSource[] = [];

      abortRef.current = streamChat(
        chatMessages,
        true,
        (token) => {
          accumulated += token;
          setMessages((prev) => {
            const updated = [...prev];
            updated[updated.length - 1] = {
              role: "assistant",
              content: accumulated,
              sources,
            };
            return updated;
          });
        },
        (s) => {
          sources = s;
          setMessages((prev) => {
            const updated = [...prev];
            updated[updated.length - 1] = {
              ...updated[updated.length - 1],
              sources: s,
            };
            return updated;
          });
        },
        () => setIsStreaming(false),
        () => setIsStreaming(false),
      );
    },
    [],
  );

  // Trigger initial query from search
  useEffect(() => {
    if (initialQuery && initialQuery !== lastInitialQueryRef.current) {
      lastInitialQueryRef.current = initialQuery;
      setMessages([]);
      sendMessage(initialQuery, []);
    }
  }, [initialQuery, sendMessage]);

  // Clear when no query
  useEffect(() => {
    if (!initialQuery) {
      abortRef.current?.abort();
      setMessages([]);
      setInput("");
      lastInitialQueryRef.current = "";
    }
  }, [initialQuery]);

  // Cleanup
  useEffect(() => {
    return () => abortRef.current?.abort();
  }, []);

  function handleSubmit() {
    const text = input.trim();
    if (!text || isStreaming) return;
    setInput("");
    sendMessage(text, messages);
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  }

  function handleClear() {
    abortRef.current?.abort();
    setMessages([]);
    setInput("");
    lastInitialQueryRef.current = "";
  }

  if (!initialQuery && messages.length === 0) {
    return (
      <Card className="h-full border-dashed">
        <CardContent className="flex flex-col items-center justify-center h-full min-h-48 text-muted-foreground gap-2">
          <Sparkles className="h-8 w-8" />
          <p className="text-sm">検索するとAIが回答を生成します</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="h-full flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2 border-b shrink-0">
        <div className="flex items-center gap-2 text-sm font-medium">
          <Sparkles className="h-4 w-4 text-primary" />
          AI チャット
        </div>
        {messages.length > 0 && (
          <Button variant="ghost" size="sm" onClick={handleClear} className="h-7 px-2">
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        )}
      </div>

      {/* Messages */}
      <ScrollArea className="flex-1 min-h-0" ref={scrollRef}>
        <div className="p-4 space-y-4">
          {messages.map((msg, idx) => (
            <div key={idx} className={`flex gap-2 ${msg.role === "user" ? "justify-end" : ""}`}>
              {msg.role === "assistant" && (
                <div className="shrink-0 h-6 w-6 rounded-full bg-primary/10 flex items-center justify-center">
                  <Sparkles className="h-3.5 w-3.5 text-primary" />
                </div>
              )}
              <div
                className={`max-w-[85%] rounded-lg px-3 py-2 text-sm ${
                  msg.role === "user"
                    ? "bg-primary text-primary-foreground"
                    : "bg-muted"
                }`}
              >
                <p className="whitespace-pre-wrap leading-relaxed">
                  {msg.content}
                  {msg.role === "assistant" && isStreaming && idx === messages.length - 1 && (
                    <LoadingDots />
                  )}
                </p>
                {msg.sources && msg.sources.length > 0 && (
                  <div className="mt-2 pt-2 border-t border-border/50">
                    <p className="text-xs text-muted-foreground mb-1">参照元:</p>
                    <div className="flex flex-wrap gap-1">
                      {msg.sources.map((s) => (
                        <Badge
                          key={s.chunk_id}
                          variant="secondary"
                          className="cursor-pointer hover:bg-accent text-[10px] px-1.5 py-0"
                          onClick={() => navigate(`/documents/${s.document_id}`)}
                        >
                          {s.title}
                        </Badge>
                      ))}
                    </div>
                  </div>
                )}
              </div>
              {msg.role === "user" && (
                <div className="shrink-0 h-6 w-6 rounded-full bg-primary flex items-center justify-center">
                  <User className="h-3.5 w-3.5 text-primary-foreground" />
                </div>
              )}
            </div>
          ))}
        </div>
      </ScrollArea>

      {/* Input */}
      <div className="border-t p-3 shrink-0">
        <div className="flex gap-2">
          <Textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="質問を入力... (Enter で送信、Shift+Enter で改行)"
            className="min-h-[40px] max-h-[120px] resize-none text-sm"
            rows={1}
          />
          <Button
            size="sm"
            onClick={handleSubmit}
            disabled={!input.trim() || isStreaming}
            className="shrink-0 h-10 w-10 p-0"
          >
            <Send className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </Card>
  );
}
