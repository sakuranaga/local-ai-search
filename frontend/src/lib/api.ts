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
  id: string;
  username: string;
  email: string;
  display_name: string;
  avatar_url: string | null;
  is_active: boolean;
  roles: string[];
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

export interface TagInfo {
  id: number;
  name: string;
  color: string | null;
}

export interface Folder {
  id: string;
  name: string;
  parent_id: string | null;
  document_count: number;
  created_at: string;
  updated_at: string;
}

export interface Document {
  id: string;
  title: string;
  content: string;
  file_type: string;
  source_path: string | null;
  is_public: boolean;
  searchable: boolean;
  ai_knowledge: boolean;
  chunk_count: number;
  memo: string | null;
  folder_id: string | null;
  folder_name: string | null;
  tags: TagInfo[];
  created_by_name: string | null;
  updated_by_name: string | null;
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
  searchable: boolean;
  ai_knowledge: boolean;
  chunk_count: number;
  memo: string | null;
  folder_id: string | null;
  folder_name: string | null;
  tags: TagInfo[];
  created_by_name: string | null;
  updated_by_name: string | null;
  created_at: string;
  updated_at: string;
}

export interface DocumentListResponse {
  items: DocumentListItem[];
  total: number;
  page: number;
  per_page: number;
}

export interface DocumentPermissionEntry {
  user_id: string;
  username: string | null;
  can_read: boolean;
  can_write: boolean;
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

export async function getMe(): Promise<User> {
  return apiFetch<User>("/auth/me");
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
  chunk_id?: string;
}

export interface ChatContext {
  content: string;
  document_id: string;
  title: string;
  chunk_id: string;
}

export interface ToolStep {
  round: number;
  name: string;
  arguments: Record<string, string>;
  summary?: string;
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

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

export async function getDocuments(params: {
  page?: number;
  per_page?: number;
  sort_by?: string;
  sort_dir?: string;
  file_type?: string;
  q?: string;
  folder_id?: string;
  unfiled?: boolean;
  tag?: string;
} = {}): Promise<DocumentListResponse> {
  const p = new URLSearchParams();
  if (params.page) p.set("page", String(params.page));
  if (params.per_page) p.set("per_page", String(params.per_page));
  if (params.sort_by) p.set("sort_by", params.sort_by);
  if (params.sort_dir) p.set("sort_dir", params.sort_dir);
  if (params.file_type) p.set("file_type", params.file_type);
  if (params.q) p.set("q", params.q);
  if (params.folder_id) p.set("folder_id", params.folder_id);
  if (params.unfiled) p.set("unfiled", "true");
  if (params.tag) p.set("tag", params.tag);
  return apiFetch(`/documents?${p.toString()}`);
}

export async function getDocument(id: string): Promise<Document> {
  return apiFetch(`/documents/${id}`);
}

export async function updateDocument(
  id: string,
  data: { title?: string; memo?: string; is_public?: boolean; searchable?: boolean; ai_knowledge?: boolean; folder_id?: string | null; tag_ids?: number[] },
): Promise<Document> {
  return apiFetch(`/documents/${id}`, {
    method: "PATCH",
    body: JSON.stringify(data),
  });
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

export async function bulkDeleteDocuments(ids: string[]): Promise<{ deleted: number }> {
  return apiFetch("/documents/bulk-delete", {
    method: "POST",
    body: JSON.stringify({ ids }),
  });
}

export async function bulkAction(
  ids: string[],
  action: string,
  permissions?: DocumentPermissionEntry[],
  extra?: Record<string, unknown>,
): Promise<{ action: string; processed: number }> {
  return apiFetch("/documents/bulk-action", {
    method: "POST",
    body: JSON.stringify({ ids, action, permissions, ...extra }),
  });
}

export async function getDocumentPermissions(id: string): Promise<DocumentPermissionEntry[]> {
  return apiFetch(`/documents/${id}/permissions`);
}

export async function setDocumentPermissions(
  id: string,
  permissions: DocumentPermissionEntry[],
): Promise<void> {
  return apiFetch(`/documents/${id}/permissions`, {
    method: "PUT",
    body: JSON.stringify({ permissions }),
  });
}

export async function reindexDocument(id: string): Promise<{ chunk_count: number }> {
  return apiFetch(`/documents/${id}/reindex`, { method: "POST" });
}

// ---------------------------------------------------------------------------
// Trash
// ---------------------------------------------------------------------------

export interface TrashItem {
  id: string;
  title: string;
  file_type: string;
  deleted_at: string;
}

export async function getTrash(): Promise<TrashItem[]> {
  return apiFetch("/documents/trash/list");
}

export async function restoreFromTrash(ids: string[]): Promise<{ restored: number }> {
  return apiFetch("/documents/trash/restore", {
    method: "POST",
    body: JSON.stringify({ ids }),
  });
}

export async function purgeFromTrash(ids: string[]): Promise<{ purged: number }> {
  return apiFetch("/documents/trash/purge", {
    method: "POST",
    body: JSON.stringify({ ids }),
  });
}

export async function emptyTrash(): Promise<{ purged: number }> {
  return apiFetch("/documents/trash/empty", { method: "POST" });
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
  email?: string;
  display_name?: string;
  role?: string;
}): Promise<User> {
  return apiFetch("/users", {
    method: "POST",
    body: JSON.stringify(data),
  });
}

export async function updateUser(
  id: string,
  data: Partial<{
    username: string;
    email: string;
    display_name: string;
    avatar_url: string | null;
    role: string;
    is_active: boolean;
    password: string;
  }>,
): Promise<User> {
  return apiFetch(`/users/${id}`, {
    method: "PUT",
    body: JSON.stringify(data),
  });
}

export async function deleteUser(id: string): Promise<void> {
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

// ---------------------------------------------------------------------------
// Folders
// ---------------------------------------------------------------------------

export async function getFolders(): Promise<Folder[]> {
  return apiFetch("/folders");
}

export async function createFolder(data: { name: string; parent_id?: string | null }): Promise<Folder> {
  return apiFetch("/folders", {
    method: "POST",
    body: JSON.stringify(data),
  });
}

export async function updateFolder(id: string, data: { name?: string; parent_id?: string | null }): Promise<Folder> {
  return apiFetch(`/folders/${id}`, {
    method: "PATCH",
    body: JSON.stringify(data),
  });
}

export async function deleteFolder(id: string): Promise<void> {
  return apiFetch(`/folders/${id}`, { method: "DELETE" });
}

// ---------------------------------------------------------------------------
// Tags
// ---------------------------------------------------------------------------

export async function getTags(): Promise<TagInfo[]> {
  return apiFetch("/tags");
}

export async function createTag(data: { name: string; color?: string | null }): Promise<TagInfo> {
  return apiFetch("/tags", {
    method: "POST",
    body: JSON.stringify(data),
  });
}

export async function updateTag(id: number, data: { name?: string; color?: string | null }): Promise<TagInfo> {
  return apiFetch(`/tags/${id}`, {
    method: "PATCH",
    body: JSON.stringify(data),
  });
}

export async function deleteTag(id: number): Promise<void> {
  return apiFetch(`/tags/${id}`, { method: "DELETE" });
}
