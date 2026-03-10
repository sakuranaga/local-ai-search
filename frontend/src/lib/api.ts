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
  document_id: number;
  title: string;
  snippet: string;
  score: number;
  file_type: string;
  source: string;
  updated_at: string;
}

export interface SearchResponse {
  results: SearchResult[];
  total: number;
  query: string;
  elapsed_ms: number;
}

export interface Document {
  id: number;
  title: string;
  content: string;
  file_type: string;
  source: string;
  created_at: string;
  updated_at: string;
}

export interface DocumentListItem {
  id: number;
  title: string;
  file_type: string;
  source: string;
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
  limit = 20,
): Promise<SearchResponse> {
  return apiFetch<SearchResponse>(
    `/search?q=${encodeURIComponent(query)}&limit=${limit}`,
  );
}

export function streamAIAnswer(
  query: string,
  onChunk: (text: string) => void,
  onSources: (sources: Array<{ document_id: number; title: string }>) => void,
  onDone: () => void,
  onError: (err: Error) => void,
): AbortController {
  const controller = new AbortController();
  const token = getToken();

  fetch(`${API_BASE}/search/ai?q=${encodeURIComponent(query)}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    signal: controller.signal,
  })
    .then(async (res) => {
      if (!res.ok) throw new Error(`AI stream error: ${res.status}`);
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
              if (parsed.type === "chunk") {
                onChunk(parsed.text);
              } else if (parsed.type === "sources") {
                onSources(parsed.sources);
              }
            } catch {
              // plain text chunk
              onChunk(payload);
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

export async function getDocument(id: number): Promise<Document> {
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

export async function deleteDocument(id: number): Promise<void> {
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
