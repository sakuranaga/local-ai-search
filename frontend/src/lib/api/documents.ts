import { API_BASE, apiFetch, getToken } from "./client";
import type { Document, DocumentListResponse, UnixPermissions, TrashItem } from "./types";

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

export async function checkDuplicates(titles: string[]): Promise<string[]> {
  const data = await apiFetch<{ duplicates: string[] }>("/documents/check-duplicates", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(titles),
  });
  return data.duplicates;
}

export async function updateDocument(
  id: string,
  data: { title?: string; summary?: string; memo?: string; searchable?: boolean; ai_knowledge?: boolean; folder_id?: string | null; tag_ids?: number[]; group_id?: string | null; group_read?: boolean; group_write?: boolean; others_read?: boolean; others_write?: boolean },
): Promise<Document> {
  return apiFetch(`/documents/${id}`, {
    method: "PATCH",
    body: JSON.stringify(data),
  });
}

export async function uploadDocument(file: File, folderId?: string | null): Promise<Document> {
  const token = getToken();
  const form = new FormData();
  form.append("file", file);
  const url = folderId
    ? `${API_BASE}/documents/upload?folder_id=${encodeURIComponent(folderId)}`
    : `${API_BASE}/documents/upload`;
  const res = await fetch(url, {
    method: "POST",
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    body: form,
  });
  if (!res.ok) throw new Error(`Upload failed: ${res.status}`);
  return res.json();
}

export async function getProcessingStatus(docId: string): Promise<string> {
  const data = await apiFetch<{ status: string }>(`/documents/status/${docId}`);
  return data.status;
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
  extra?: Record<string, unknown>,
): Promise<{ action: string; processed: number }> {
  return apiFetch("/documents/bulk-action", {
    method: "POST",
    body: JSON.stringify({ ids, action, ...extra }),
  });
}

export async function getDocumentPermissions(id: string): Promise<UnixPermissions> {
  return apiFetch(`/documents/${id}/permissions`);
}

export async function setDocumentPermissions(
  id: string,
  permissions: UnixPermissions,
): Promise<void> {
  return apiFetch(`/documents/${id}/permissions`, {
    method: "PATCH",
    body: JSON.stringify(permissions),
  });
}

export async function reindexDocument(id: string): Promise<{ chunk_count: number }> {
  return apiFetch(`/documents/${id}/reindex`, { method: "POST" });
}

// ---------------------------------------------------------------------------
// Trash
// ---------------------------------------------------------------------------

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
