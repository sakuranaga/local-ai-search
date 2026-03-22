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
}): Promise<DocumentSearchResponse> {
  const p = new URLSearchParams();
  p.set("q", params.q);
  if (params.page) p.set("page", String(params.page));
  if (params.per_page) p.set("per_page", String(params.per_page));
  if (params.folder_id) p.set("folder_id", params.folder_id);
  if (params.unfiled) p.set("unfiled", "true");
  if (params.tags?.length) p.set("tags", params.tags.join(","));
  if (params.file_type) p.set("file_type", params.file_type);
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
): AbortController {
  const controller = new AbortController();
  const token = getToken();

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers["Authorization"] = `Bearer ${token}`;

  fetch(`${API_BASE}/chat/stream`, {
    method: "POST",
    headers,
    body: JSON.stringify({ messages, context }),
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
