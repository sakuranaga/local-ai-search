import { apiFetch, API_BASE } from "./client";

export interface ShareLinkInfo {
  id: string;
  document_id: string;
  document_title: string;
  token: string;
  url: string;
  permission: string;
  has_password: boolean;
  max_downloads: number | null;
  download_count: number;
  expires_at: string | null;
  created_by_name: string;
  created_at: string;
  is_active: boolean;
  access_count: number;
}

export interface SharePublicInfo {
  document_title: string;
  file_type: string;
  permission: string;
  requires_password: boolean;
  created_by_name: string;
  expires_at: string | null;
}

// Authenticated endpoints

export async function createShareLink(data: {
  document_id: string;
  permission?: string;
  password?: string | null;
  max_downloads?: number | null;
  expires_in?: string | null;
}): Promise<ShareLinkInfo> {
  return apiFetch("/share", {
    method: "POST",
    body: JSON.stringify(data),
  });
}

export async function getShareLinks(): Promise<ShareLinkInfo[]> {
  return apiFetch("/share/list");
}

export async function deleteShareLink(id: string): Promise<void> {
  return apiFetch(`/share/${id}`, { method: "DELETE" });
}

export async function updateShareLink(id: string, data: {
  permission?: string;
  password?: string | null;
  max_downloads?: number | null;
  expires_in?: string | null;
  is_active?: boolean;
}): Promise<ShareLinkInfo> {
  return apiFetch(`/share/${id}`, {
    method: "PATCH",
    body: JSON.stringify(data),
  });
}

// Public endpoints (no auth required)

export async function getSharePublic(token: string): Promise<SharePublicInfo> {
  const res = await fetch(`${API_BASE}/share/public/${token}`);
  if (!res.ok) {
    const body = await res.json().catch(() => ({ detail: "Error" }));
    throw new Error(body.detail || `Error ${res.status}`);
  }
  return res.json();
}

export async function verifySharePassword(token: string, password: string): Promise<{ share_token: string }> {
  const res = await fetch(`${API_BASE}/share/public/${token}/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ detail: "Error" }));
    throw new Error(body.detail || `Error ${res.status}`);
  }
  return res.json();
}

export async function getSharePreview(token: string, shareToken?: string): Promise<{ title: string; file_type: string; content: string }> {
  const headers: Record<string, string> = {};
  if (shareToken) headers["x-share-token"] = shareToken;
  const res = await fetch(`${API_BASE}/share/public/${token}/preview`, { headers });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ detail: "Error" }));
    throw new Error(body.detail || `Error ${res.status}`);
  }
  return res.json();
}

export function getShareDownloadUrl(token: string, shareToken?: string): string {
  const base = `${API_BASE}/share/public/${token}/download`;
  return shareToken ? `${base}?share_token=${shareToken}` : base;
}
