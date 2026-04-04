import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Sparkles, Send, Trash2, User, Search, FileText, TextSearch, Hash, Loader2, ChevronRight, Bot, FolderOpen, List } from "lucide-react";
import {
  streamChat,
  getChatStatus,
  getConversation,
  saveMessage,
  deleteConversation,
  type ChatMessage,
  type ChatSource,
  type ChatContext,
  type ChatStatus,
  type ToolStep,
} from "@/lib/api";

interface ToolStepDisplay {
  round: number;
  name: string;
  query: string;
  summary?: string;
}

interface DisplayMessage {
  role: "user" | "assistant";
  content: string;
  sources?: ChatSource[];
  toolSteps?: ToolStepDisplay[];
  turnContext?: string;
}

// clearChatCache kept for backward compat (no-op now, DB handles persistence)
export function clearChatCache() {}

const TOOL_LABELS: Record<string, { label: string; icon: typeof Search }> = {
  search: { label: "検索", icon: Search },
  grep: { label: "テキスト検索", icon: TextSearch },
  search_by_title: { label: "タイトル検索", icon: FileText },
  read_document: { label: "文書読込", icon: FileText },
  count_results: { label: "件数確認", icon: Hash },
  list_folders: { label: "フォルダ一覧", icon: FolderOpen },
  list_documents: { label: "文書一覧", icon: List },
};

function ToolStepLine({ step, isActive }: { step: ToolStepDisplay; isActive: boolean }) {
  const info = TOOL_LABELS[step.name] || { label: step.name, icon: Search };
  const Icon = info.icon;

  return (
    <div className="flex items-start gap-1.5 text-xs text-muted-foreground">
      {isActive && !step.summary ? (
        <Loader2 className="h-3 w-3 mt-0.5 shrink-0 animate-spin" />
      ) : (
        <Icon className="h-3 w-3 mt-0.5 shrink-0" />
      )}
      <span>
        <span className="font-medium">{info.label}</span>
        {step.query && <span className="ml-1">「{step.query}」</span>}
        {step.summary && <span className="ml-1 text-foreground/60">→ {step.summary}</span>}
      </span>
    </div>
  );
}

interface ChatPanelProps {
  initialQuery?: string;
  onSourceClick?: (documentId: string) => void;
  onCollapse?: () => void;
  onStreamingChange?: (streaming: boolean) => void;
  collapsed?: boolean;
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

export function ChatPanel({ initialQuery, onSourceClick, onCollapse, onStreamingChange, collapsed }: ChatPanelProps) {
  const navigate = useNavigate();

  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  const [ragContext, setRagContext] = useState<ChatContext[]>([]);
  const [input, setInput] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [loadingHistory, setLoadingHistory] = useState(false);
  useEffect(() => { onStreamingChange?.(isStreaming); }, [isStreaming, onStreamingChange]);
  const [chatStatus, setChatStatus] = useState<ChatStatus | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const lastInitialQueryRef = useRef("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // Track how many messages are already persisted in DB
  const persistedCountRef = useRef(0);

  const collapsedRef = useRef(false);
  useEffect(() => { collapsedRef.current = !!collapsed; }, [collapsed]);

  // Request notification permission on mount
  useEffect(() => {
    if ("Notification" in window && Notification.permission === "default") {
      Notification.requestPermission();
    }
  }, []);

  // Fetch LLM status
  useEffect(() => {
    getChatStatus().then(setChatStatus).catch(() => setChatStatus({ model: "", available: false }));
  }, []);

  // Auto-scroll to bottom
  useEffect(() => {
    const root = scrollRef.current;
    if (!root) return;
    const viewport = root.querySelector('[data-slot="scroll-area-viewport"]') as HTMLElement | null;
    const el = viewport ?? root;
    el.scrollTop = el.scrollHeight;
  }, [messages]);

  const currentQueryRef = useRef("");

  const sendMessage = useCallback(
    (userText: string, history: DisplayMessage[], currentContext: ChatContext[]) => {
      const query = currentQueryRef.current;
      const userMsg: DisplayMessage = { role: "user", content: userText };
      const newMessages = [...history, userMsg];
      setMessages([...newMessages, { role: "assistant", content: "", toolSteps: [] }]);
      setIsStreaming(true);

      // Save user message to DB
      if (query) {
        saveMessage({ query, role: "user", content: userText }).catch(() => {});
      }

      abortRef.current?.abort();

      const chatMessages: ChatMessage[] = newMessages.map((m) => ({
        role: m.role,
        content: m.content,
        ...(m.turnContext ? { turnContext: m.turnContext } : {}),
      }));

      let accumulated = "";
      let finalSources: ChatSource[] | undefined;
      let finalToolSteps: ToolStepDisplay[] | undefined;
      let finalTurnContext: string | undefined;

      abortRef.current = streamChat(
        chatMessages,
        currentContext,
        // onToken
        (token) => {
          accumulated += token;
          setMessages((prev) => {
            const updated = [...prev];
            updated[updated.length - 1] = {
              ...updated[updated.length - 1],
              content: accumulated,
            };
            return updated;
          });
        },
        // onContext
        (_ctx, sources) => {
          finalSources = sources;
          setRagContext(_ctx);
          setMessages((prev) => {
            const updated = [...prev];
            updated[updated.length - 1] = {
              ...updated[updated.length - 1],
              sources,
            };
            return updated;
          });
        },
        // onDone — save assistant message to DB & notify if hidden
        () => {
          setIsStreaming(false);
          if (query && accumulated) {
            saveMessage({
              query,
              role: "assistant",
              content: accumulated,
              turn_context: finalTurnContext ?? null,
              sources: finalSources ?? null,
              tool_steps: finalToolSteps ?? null,
            }).catch(() => {});
          }
          // Browser notification when chat panel is collapsed or tab is hidden
          if (
            "Notification" in window &&
            Notification.permission === "granted" &&
            (document.hidden || collapsedRef.current)
          ) {
            const preview = accumulated.slice(0, 100) + (accumulated.length > 100 ? "…" : "");
            const n = new Notification("AI回答が完了しました", { body: preview, tag: "ai-chat" });
            n.onclick = () => { window.focus(); n.close(); };
          }
        },
        // onError
        () => setIsStreaming(false),
        // onToolEvent
        (step: ToolStep) => {
          setMessages((prev) => {
            const updated = [...prev];
            const last = { ...updated[updated.length - 1] };
            const steps = [...(last.toolSteps || [])];

            if (step.summary) {
              let idx = -1;
              for (let i = steps.length - 1; i >= 0; i--) {
                if (steps[i].name === step.name && steps[i].round === step.round && !steps[i].summary) {
                  idx = i;
                  break;
                }
              }
              if (idx >= 0) {
                steps[idx] = { ...steps[idx], summary: step.summary };
              }
            } else {
              const q = step.arguments.query || step.arguments.pattern || step.arguments.id || "";
              steps.push({ round: step.round, name: step.name, query: q });
            }

            last.toolSteps = steps;
            finalToolSteps = steps;
            updated[updated.length - 1] = last;
            return updated;
          });
        },
        // onTurnContext
        (summary: string) => {
          finalTurnContext = summary;
          setMessages((prev) => {
            const updated = [...prev];
            updated[updated.length - 1] = {
              ...updated[updated.length - 1],
              turnContext: summary,
            };
            return updated;
          });
        },
      );
    },
    [],
  );

  // Trigger initial query from search — load history or start new
  useEffect(() => {
    if (initialQuery && initialQuery !== lastInitialQueryRef.current) {
      lastInitialQueryRef.current = initialQuery;
      currentQueryRef.current = initialQuery;
      setMessages([]);
      setRagContext([]);
      setLoadingHistory(true);

      getConversation(initialQuery)
        .then((conv) => {
          if (conv && conv.messages.length > 0) {
            // Restore from DB
            const restored: DisplayMessage[] = conv.messages.map((m) => ({
              role: m.role as "user" | "assistant",
              content: m.content,
              turnContext: m.turn_context ?? undefined,
              sources: m.sources ?? undefined,
              toolSteps: m.tool_steps?.map((s: { round: number; name: string; query?: string; summary?: string }) => ({
                round: s.round,
                name: s.name,
                query: s.query ?? "",
                summary: s.summary,
              })) ?? undefined,
            }));
            persistedCountRef.current = restored.length;
            setMessages(restored);
            setLoadingHistory(false);
          } else {
            // No history — start new conversation
            persistedCountRef.current = 0;
            setLoadingHistory(false);
            sendMessage(initialQuery, [], []);
          }
        })
        .catch(() => {
          persistedCountRef.current = 0;
          setLoadingHistory(false);
          sendMessage(initialQuery, [], []);
        });
    }
  }, [initialQuery, sendMessage]);

  // Cleanup
  useEffect(() => {
    return () => abortRef.current?.abort();
  }, []);

  function handleSubmit() {
    const text = input.trim();
    if (!text || isStreaming) return;
    setInput("");
    sendMessage(text, messages, ragContext);
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      handleSubmit();
    }
  }

  function handleClear() {
    abortRef.current?.abort();
    const query = currentQueryRef.current;
    if (query) {
      deleteConversation(query).catch(() => {});
    }
    setMessages([]);
    setRagContext([]);
    setInput("");
    lastInitialQueryRef.current = "";
    currentQueryRef.current = "";
    persistedCountRef.current = 0;
  }

  if (messages.length === 0) {
    return (
      <Card className="h-full border-dashed flex flex-col !py-0 !gap-0">
        {onCollapse && (
          <div className="flex items-center justify-between px-4 py-1.5 border-b shrink-0">
            <button onClick={onCollapse} className="flex items-center gap-2 text-sm font-medium hover:text-muted-foreground transition-colors">
              <Sparkles className={`h-4 w-4 text-primary ${isStreaming ? "animate-ai-glow" : ""}`} />
              AI チャット
            </button>
            <Button variant="ghost" size="sm" onClick={onCollapse} className="h-7 px-2" title="閉じる">
              <ChevronRight className="h-3.5 w-3.5" />
            </Button>
          </div>
        )}
        <CardContent className="flex flex-col items-center justify-center flex-1 min-h-48 text-muted-foreground gap-2">
          <Sparkles className="h-8 w-8" />
          <p className="text-sm">検索するとAIが回答を生成します</p>
          {chatStatus && (
            chatStatus.available ? (
              <p className="text-xs">({chatStatus.model})</p>
            ) : (
              <p className="text-xs text-red-500">（モデル未設定）</p>
            )
          )}
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="h-full flex flex-col !py-0 !gap-0">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-1.5 border-b shrink-0">
        <button onClick={onCollapse} className="flex items-center gap-2 text-sm font-medium hover:text-muted-foreground transition-colors">
          <Sparkles className={`h-4 w-4 text-primary ${isStreaming ? "animate-ai-glow" : ""}`} />
          AI チャット
          {chatStatus && (
            chatStatus.available ? (
              <span className="text-xs font-normal text-muted-foreground">({chatStatus.model})</span>
            ) : (
              <span className="text-xs font-normal text-red-500">（モデル未設定）</span>
            )
          )}
        </button>
        <div className="flex items-center">
          {messages.length > 0 && (
            <Button variant="ghost" size="sm" onClick={handleClear} className="h-7 px-2">
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          )}
          {onCollapse && (
            <Button variant="ghost" size="sm" onClick={onCollapse} className="h-7 px-2" title="閉じる">
              <ChevronRight className="h-3.5 w-3.5" />
            </Button>
          )}
        </div>
      </div>

      {/* Messages */}
      <ScrollArea className="flex-1 min-h-0" ref={scrollRef}>
        <div className="p-4 space-y-4">
          {messages.map((msg, idx) => (
            <div key={idx} className={`flex gap-2 ${msg.role === "user" ? "justify-end" : ""}`}>
              {msg.role === "assistant" && (
                <div className="shrink-0 h-6 w-6 rounded-full bg-primary/10 flex items-center justify-center">
                  <Bot className="h-3.5 w-3.5 text-primary" />
                </div>
              )}
              <div
                className={`max-w-[85%] rounded-lg px-3 py-2 text-sm ${
                  msg.role === "user"
                    ? "bg-primary text-primary-foreground"
                    : "bg-muted"
                }`}
              >
                {msg.role === "assistant" && (
                  <>
                    {/* Tool steps */}
                    {msg.toolSteps && msg.toolSteps.length > 0 && (
                      <div className="mb-2 space-y-1 pb-2 border-b border-border/50">
                        {msg.toolSteps.map((step, i) => (
                          <ToolStepLine
                            key={i}
                            step={step}
                            isActive={isStreaming && idx === messages.length - 1}
                          />
                        ))}
                      </div>
                    )}
                    {/* Show loading when streaming but no content yet */}
                    {isStreaming && idx === messages.length - 1 && !msg.content && (
                      <LoadingDots />
                    )}
                    <div className="prose prose-sm dark:prose-invert max-w-none prose-p:my-1 prose-ul:my-1 prose-ol:my-1 prose-li:my-0.5 prose-headings:my-2 prose-pre:my-1">
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>{msg.content}</ReactMarkdown>
                      {isStreaming && idx === messages.length - 1 && msg.content && <LoadingDots />}
                    </div>
                  </>
                )}
                {msg.role === "user" && (
                  <p className="whitespace-pre-wrap leading-relaxed">{msg.content}</p>
                )}
                {msg.sources && msg.sources.length > 0 && (
                  <div className="mt-2 pt-2 border-t border-border/50">
                    <p className="text-xs text-muted-foreground mb-1">参照元:</p>
                    <div className="flex flex-wrap gap-1">
                      {msg.sources.map((s, i) => (
                        <Badge
                          key={s.document_id + i}
                          variant="secondary"
                          className="cursor-pointer hover:bg-accent text-[10px] px-1.5 py-0"
                          title={s.title}
                          onClick={() => onSourceClick ? onSourceClick(s.document_id) : navigate(`/documents/${s.document_id}`)}
                        >
                          {s.title.length > 20 ? s.title.slice(0, 20) + "…" : s.title}
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
      <div className="border-t px-3 py-2 shrink-0">
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
