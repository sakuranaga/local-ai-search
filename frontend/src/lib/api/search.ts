import { API_BASE, apiFetch, getToken } from "./client";
import type {
  ChatContext,
  ChatMessage,
  ChatSource,
  ChatStatus,
  DocumentSearchResponse,
  ToolStep,
} from "./types";

export async function searchDocumentsList(params: {
  q: string;
  page?: number;
  per_page?: number;
  folder_id?: string;
  unfiled?: boolean;
  tags?: string[];
  file_type?: string;
  include_unsearchable?: boolean;
}): Promise<DocumentSearchResponse> {
  const p = new URLSearchParams();
  p.set("q", params.q);
  if (params.page) p.set("page", String(params.page));
  if (params.per_page) p.set("per_page", String(params.per_page));
  if (params.folder_id) p.set("folder_id", params.folder_id);
  if (params.unfiled) p.set("unfiled", "true");
  if (params.tags?.length) p.set("tags", params.tags.join(","));
  if (params.file_type) p.set("file_type", params.file_type);
  if (params.include_unsearchable) p.set("include_unsearchable", "true");
  return apiFetch(`/search/documents?${p.toString()}`);
}

export async function getChatStatus(): Promise<ChatStatus> {
  return apiFetch("/chat/status");
}

export function streamChat(
  messages: ChatMessage[],
  context: ChatContext[],
  onToken: (text: string) => void,
  onContext: (ctx: ChatContext[], sources: ChatSource[]) => void,
  onDone: () => void,
  onError: (err: Error) => void,
  onToolEvent?: (step: ToolStep) => void,
  onTurnContext?: (summary: string) => void,
): AbortController {
  const controller = new AbortController();
  const token = getToken();

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers["Authorization"] = `Bearer ${token}`;

  fetch(`${API_BASE}/chat/stream`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      messages: messages.map((m) => ({
        role: m.role,
        content: m.content,
        ...(m.turnContext ? { turn_context: m.turnContext } : {}),
      })),
      context,
    }),
    signal: controller.signal,
  })
    .then(async (res) => {
      if (!res.ok) throw new Error(`Chat stream error: ${res.status}`);
      const reader = res.body?.getReader();
      if (!reader) throw new Error("No reader");

      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (line.startsWith("data: ")) {
            const payload = line.slice(6).trim();
            if (payload === "[DONE]") {
              onDone();
              return;
            }
            try {
              const parsed = JSON.parse(payload);
              if (parsed.type === "token") {
                onToken(parsed.content);
              } else if (parsed.type === "tool_call") {
                onToolEvent?.({
                  round: parsed.round,
                  name: parsed.name,
                  arguments: parsed.arguments,
                });
              } else if (parsed.type === "tool_result") {
                onToolEvent?.({
                  round: parsed.round,
                  name: parsed.name,
                  arguments: {},
                  summary: parsed.summary,
                });
              } else if (parsed.type === "sources") {
                const sources: ChatSource[] = parsed.sources;
                onContext([], sources);
              } else if (parsed.type === "turn_context") {
                onTurnContext?.(parsed.summary);
              } else if (parsed.type === "context") {
                const ctx: ChatContext[] = parsed.context;
                const sources: ChatSource[] = ctx.map((c: ChatContext) => ({
                  document_id: c.document_id,
                  title: c.title,
                  chunk_id: c.chunk_id,
                }));
                onContext(ctx, sources);
              }
            } catch {
              onToken(payload);
            }
          }
        }
      }
      onDone();
    })
    .catch((err) => {
      if (err.name !== "AbortError") onError(err);
    });

  return controller;
}

// ---------------------------------------------------------------------------
// Chat history persistence
// ---------------------------------------------------------------------------

export interface ConversationMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  turn_context: string | null;
  sources: ChatSource[] | null;
  tool_steps: Array<{ round: number; name: string; query?: string; summary?: string }> | null;
  created_at: string | null;
}

export interface Conversation {
  id: string;
  query: string;
  messages: ConversationMessage[];
  created_at: string | null;
  updated_at: string | null;
}

export async function getConversation(query: string): Promise<Conversation | null> {
  return apiFetch(`/chat/conversations?query=${encodeURIComponent(query)}`);
}

export async function saveMessage(params: {
  query: string;
  role: string;
  content: string;
  turn_context?: string | null;
  sources?: ChatSource[] | null;
  tool_steps?: Array<{ round: number; name: string; query?: string; summary?: string }> | null;
}): Promise<{ id: string; conversation_id: string }> {
  return apiFetch("/chat/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
}

export async function deleteConversation(query: string): Promise<{ deleted: boolean }> {
  return apiFetch(`/chat/conversations?query=${encodeURIComponent(query)}`, {
    method: "DELETE",
  });
}
