import { apiFetch, API_BASE, getToken } from "./client";

export interface ShareLinkInfo {
  id: string;
  document_id: string;
  document_title: string;
  token: string;
  url: string;
  has_password: boolean;
  expires_at: string;
  created_by_name: string;
  created_at: string;
  is_active: boolean;
}

export async function createShareLink(data: {
  document_id: string;
  password?: string | null;
  expires_in?: string;
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

export async function testShareConnection(): Promise<{ ok: boolean; error?: string; active_links?: number }> {
  return apiFetch("/share/test-connection", { method: "POST" });
}

export async function getShareEnabled(): Promise<boolean> {
  try {
    const data = await apiFetch<{ key: string; value: string }>("/settings/public/share_enabled");
    return data.value === "true";
  } catch {
    return false;
  }
}
