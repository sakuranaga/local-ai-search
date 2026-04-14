import { apiFetch } from "./client";
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
  tags?: string[];
  date_from?: string;
  date_to?: string;
  created_by?: string;
  favorites?: boolean;
  recent?: boolean;
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
  if (params.tags?.length) p.set("tags", params.tags.join(","));
  if (params.date_from) p.set("date_from", params.date_from);
  if (params.date_to) p.set("date_to", params.date_to);
  if (params.created_by) p.set("created_by", params.created_by);
  if (params.favorites) p.set("favorites", "true");
  if (params.recent) p.set("recent", "true");
  return apiFetch(`/documents?${p.toString()}`);
}

export interface FilterOptions {
  file_types: string[];
  creators: { id: string; name: string }[];
}

export async function getFilterOptions(): Promise<FilterOptions> {
  return apiFetch("/documents/filter-options");
}

export async function getDocument(id: string): Promise<Document> {
  return apiFetch(`/documents/${id}`);
}

export async function resolveTitles(ids: string[]): Promise<Record<string, { title: string; is_note: boolean; file_type: string; deleted: boolean }>> {
  return apiFetch("/documents/resolve-titles", {
    method: "POST",
    body: JSON.stringify({ ids }),
  });
}

export async function checkDuplicates(titles: string[], folderId?: string | null): Promise<string[]> {
  const params = folderId ? `?folder_id=${folderId}` : "";
  const data = await apiFetch<{ duplicates: string[] }>(`/documents/check-duplicates${params}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(titles),
  });
  return data.duplicates;
}

export async function updateDocument(
  id: string,
  data: { title?: string; summary?: string; memo?: string; content?: string; searchable?: boolean; ai_knowledge?: boolean; folder_id?: string | null; tag_ids?: number[]; group_id?: string | null; group_read?: boolean; group_write?: boolean; others_read?: boolean; others_write?: boolean; share_prohibited?: boolean; download_prohibited?: boolean },
): Promise<Document> {
  return apiFetch(`/documents/${id}`, {
    method: "PATCH",
    body: JSON.stringify(data),
  });
}

export async function getProcessingStatus(docId: string): Promise<string> {
  const data = await apiFetch<{ status: string }>(`/documents/status/${docId}`);
  return data.status;
}

export async function deleteDocument(id: string): Promise<void> {
  return apiFetch(`/documents/${id}`, { method: "DELETE" });
}

export async function bulkAction(
  ids: string[],
  action: string,
  extra?: Record<string, unknown>,
): Promise<{ action: string; processed: number; job_ids?: string[] }> {
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

export async function reindexDocument(id: string): Promise<{ id: string }> {
  return apiFetch(`/documents/${id}/reindex`, { method: "POST" });
}

// ---------------------------------------------------------------------------
// Job queue polling
// ---------------------------------------------------------------------------

export interface JobStatus {
  id: string;
  job_type: string;
  status: string;  // pending, running, completed, failed
  progress: string | null;
  error: string | null;
  created_at: string | null;
  started_at: string | null;
  completed_at: string | null;
}

export async function getJobsStatus(jobIds: string[]): Promise<JobStatus[]> {
  const res = await apiFetch<{ jobs: JobStatus[] }>(`/jobs?ids=${jobIds.join(",")}`);
  return res.jobs;
}

/**
 * Poll job statuses until all reach "completed" or "failed".
 * Calls onProgress with (completed, total) on each tick.
 */
export async function pollJobsProgress(
  jobIds: string[],
  onProgress: (completed: number, total: number) => void,
): Promise<{ done: number; errors: number }> {
  const pending = new Set(jobIds);
  let doneCount = 0;
  let errorCount = 0;

  while (pending.size > 0) {
    try {
      const jobs = await getJobsStatus([...pending]);
      for (const job of jobs) {
        if (job.status === "completed") {
          pending.delete(job.id);
          doneCount++;
        } else if (job.status === "failed") {
          pending.delete(job.id);
          errorCount++;
        }
      }
    } catch {
      break;
    }
    onProgress(doneCount + errorCount, jobIds.length);
    if (pending.size > 0) {
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
  return { done: doneCount, errors: errorCount };
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

export async function createTextDocument(data: {
  title: string;
  content: string;
  folder_id?: string | null;
}): Promise<Document> {
  return apiFetch("/documents/create-text", {
    method: "POST",
    body: JSON.stringify(data),
  });
}

export async function emptyTrash(): Promise<{ purged: number }> {
  return apiFetch("/documents/trash/empty", { method: "POST" });
}

// ---------------------------------------------------------------------------
// Favorites
// ---------------------------------------------------------------------------

export async function getFavorites(): Promise<string[]> {
  return apiFetch("/favorites");
}

export async function addFavorite(docId: string): Promise<void> {
  return apiFetch(`/favorites/${docId}`, { method: "POST" });
}

export async function removeFavorite(docId: string): Promise<void> {
  return apiFetch(`/favorites/${docId}`, { method: "DELETE" });
}

// ---------------------------------------------------------------------------
// Versions
// ---------------------------------------------------------------------------

export interface DocumentVersion {
  version_number: number;
  title: string;
  file_type: string;
  file_size: number | null;
  change_type: string | null;
  created_by_name: string | null;
  created_at: string;
  is_current: boolean;
}

export async function getDocumentVersions(docId: string): Promise<DocumentVersion[]> {
  return apiFetch(`/documents/${docId}/versions`);
}

export async function restoreDocumentVersion(docId: string, versionNumber: number): Promise<void> {
  return apiFetch(`/documents/${docId}/versions/${versionNumber}/restore`, { method: "POST" });
}
