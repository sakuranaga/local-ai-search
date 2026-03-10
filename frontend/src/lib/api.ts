const API_BASE = import.meta.env.VITE_API_BASE ?? "/api";

// ---------------------------------------------------------------------------
// Token helpers
// ---------------------------------------------------------------------------

export function getToken(): string | null {
  return localStorage.getItem("las_token");
}

export function setToken(token: string) {
  localStorage.setItem("las_token", token);
}

export function clearToken() {
  localStorage.removeItem("las_token");
}

// ---------------------------------------------------------------------------
// Generic fetch wrapper
// ---------------------------------------------------------------------------

async function apiFetch<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const token = getToken();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(options.headers as Record<string, string> | undefined),
  };
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }

  const res = await fetch(`${API_BASE}${path}`, { ...options, headers });

  if (res.status === 401) {
    clearToken();
    window.location.href = "/login";
    throw new Error("Unauthorized");
  }

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`API ${res.status}: ${body}`);
  }

  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LoginResponse {
  access_token: string;
  token_type: string;
}

export interface User {
  id: number;
  username: string;
  display_name: string;
  role: string;
  is_active: boolean;
  created_at: string;
}

export interface Role {
  id: number;
  name: string;
  permissions: string[];
}

export interface SearchResult {
  chunk_id: string;
  document_id: string;
  document_title: string;
  content: string;
  file_type: string;
  source: string;
  rrf_score?: number;
  distance?: number;
}

export interface SearchResponse {
  query: string;
  mode: string;
  page: number;
  per_page: number;
  total: number;
  count: number;
  results: SearchResult[];
}

export interface Document {
  id: string;
  title: string;
  content: string;
  file_type: string;
  source_path: string | null;
  is_public: boolean;
  chunk_count: number;
  created_at: string;
  updated_at: string;
  chunks: Array<{
    id: string;
    chunk_index: number;
    content: string;
    has_embedding: boolean;
  }>;
  files: Array<{
    id: string;
    filename: string;
    file_size: number;
    mime_type: string;
  }>;
}

export interface DocumentListItem {
  id: string;
  title: string;
  file_type: string;
  source_path: string | null;
  is_public: boolean;
  chunk_count: number;
  updated_at: string;
}

export interface IngestStatus {
  status: string;
  documents_processed: number;
  errors: string[];
}

export interface StatsResponse {
  total_documents: number;
  total_chunks: number;
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

export async function login(
  username: string,
  password: string,
): Promise<LoginResponse> {
  const res = await fetch(`${API_BASE}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Login failed: ${body}`);
  }
  const data: LoginResponse = await res.json();
  setToken(data.access_token);
  return data;
}

export function logout() {
  clearToken();
  window.location.href = "/login";
}

export async function refreshToken(): Promise<LoginResponse> {
  return apiFetch<LoginResponse>("/auth/refresh", { method: "POST" });
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

export async function searchDocuments(
  query: string,
  page = 1,
  perPage = 20,
): Promise<SearchResponse> {
  return apiFetch<SearchResponse>(
    `/search?q=${encodeURIComponent(query)}&page=${page}&per_page=${perPage}`,
  );
}

// Alias matching backend response shape
export interface BackendSearchResponse {
  query: string;
  mode: string;
  count: number;
  results: Array<{
    document_id: string;
    document_title: string;
    chunk_id: string;
    content: string;
    score: number;
  }>;
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface ChatSource {
  document_id: string;
  title: string;
  chunk_id: string;
}

export interface ChatContext {
  content: string;
  document_id: string;
  title: string;
  chunk_id: string;
}

export function streamChat(
  messages: ChatMessage[],
  context: ChatContext[],
  onToken: (text: string) => void,
  onContext: (ctx: ChatContext[], sources: ChatSource[]) => void,
  onDone: () => void,
  onError: (err: Error) => void,
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
              } else if (parsed.type === "context") {
                const ctx: ChatContext[] = parsed.context;
                const sources: ChatSource[] = ctx.map((c: ChatContext) => ({
                  document_id: c.document_id,
                  title: c.title,
                  chunk_id: c.chunk_id,
                }));
                onContext(ctx, sources);
              } else if (parsed.type === "sources") {
                const sources: ChatSource[] = parsed.sources;
                const ctx: ChatContext[] = sources.map((s: ChatSource) => ({
                  content: "",
                  document_id: s.document_id,
                  title: s.title,
                  chunk_id: s.chunk_id,
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
// Documents
// ---------------------------------------------------------------------------

export async function getDocuments(
  page = 1,
  limit = 50,
): Promise<{ items: DocumentListItem[]; total: number }> {
  return apiFetch(`/documents?page=${page}&limit=${limit}`);
}

export async function getDocument(id: string): Promise<Document> {
  return apiFetch(`/documents/${id}`);
}

export async function uploadDocument(file: File): Promise<Document> {
  const token = getToken();
  const form = new FormData();
  form.append("file", file);
  const res = await fetch(`${API_BASE}/documents/upload`, {
    method: "POST",
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    body: form,
  });
  if (!res.ok) throw new Error(`Upload failed: ${res.status}`);
  return res.json();
}

export async function deleteDocument(id: string): Promise<void> {
  return apiFetch(`/documents/${id}`, { method: "DELETE" });
}

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

export async function getUsers(): Promise<User[]> {
  return apiFetch("/users");
}

export async function createUser(data: {
  username: string;
  password: string;
  display_name: string;
  role: string;
}): Promise<User> {
  return apiFetch("/users", {
    method: "POST",
    body: JSON.stringify(data),
  });
}

export async function updateUser(
  id: number,
  data: Partial<{
    display_name: string;
    role: string;
    is_active: boolean;
    password: string;
  }>,
): Promise<User> {
  return apiFetch(`/users/${id}`, {
    method: "PATCH",
    body: JSON.stringify(data),
  });
}

export async function deleteUser(id: number): Promise<void> {
  return apiFetch(`/users/${id}`, { method: "DELETE" });
}

// ---------------------------------------------------------------------------
// Roles
// ---------------------------------------------------------------------------

export async function getRoles(): Promise<Role[]> {
  return apiFetch("/roles");
}

export async function createRole(data: {
  name: string;
  permissions: string[];
}): Promise<Role> {
  return apiFetch("/roles", {
    method: "POST",
    body: JSON.stringify(data),
  });
}

export async function deleteRole(id: number): Promise<void> {
  return apiFetch(`/roles/${id}`, { method: "DELETE" });
}

// ---------------------------------------------------------------------------
// Ingest
// ---------------------------------------------------------------------------

export async function triggerWikiSync(): Promise<IngestStatus> {
  return apiFetch("/ingest/wiki-sync", { method: "POST" });
}

export async function triggerDirectoryIngest(
  path: string,
): Promise<IngestStatus> {
  return apiFetch("/ingest/directory", {
    method: "POST",
    body: JSON.stringify({ path }),
  });
}

export async function getIngestStatus(): Promise<IngestStatus> {
  return apiFetch("/ingest/status");
}

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

export async function getStats(): Promise<StatsResponse> {
  return apiFetch("/stats");
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export interface SystemSetting {
  key: string;
  value: string;
  description: string | null;
  placeholder: string | null;
  secret: boolean;
}

export async function getSettings(): Promise<SystemSetting[]> {
  return apiFetch("/settings");
}

export async function getPublicSetting(key: string): Promise<{ key: string; value: string }> {
  return apiFetch(`/settings/public/${key}`);
}

export async function updateSetting(
  key: string,
  value: string,
): Promise<SystemSetting> {
  return apiFetch(`/settings/${key}`, {
    method: "PUT",
    body: JSON.stringify({ value }),
  });
}
