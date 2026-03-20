import { apiFetch, API_BASE, getToken } from "./client";
import type {
  ApiKeyCreateResponse,
  ApiKeyInfo,
  AuditLogListResponse,
  Folder,
  Group,
  GroupMember,
  Role,
  StatsResponse,
  SystemSetting,
  TagInfo,
  User,
} from "./types";

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
// Stats
// ---------------------------------------------------------------------------

export async function getStats(): Promise<StatsResponse> {
  return apiFetch("/stats");
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

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

export async function updateFolder(id: string, data: {
  name?: string;
  parent_id?: string | null;
  owner_id?: string | null;
  group_id?: string | null;
  group_read?: boolean;
  group_write?: boolean;
  others_read?: boolean;
  others_write?: boolean;
  recursive?: boolean;
}): Promise<Folder> {
  return apiFetch(`/folders/${id}`, {
    method: "PATCH",
    body: JSON.stringify(data),
  });
}

export async function deleteFolder(id: string): Promise<void> {
  return apiFetch(`/folders/${id}`, { method: "DELETE" });
}

export async function createFoldersBulk(
  paths: string[],
  parentId?: string | null,
): Promise<{ folders: { path: string; id: string }[] }> {
  return apiFetch("/folders/bulk", {
    method: "POST",
    body: JSON.stringify({ paths, parent_id: parentId || null }),
  });
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

// ---------------------------------------------------------------------------
// Groups
// ---------------------------------------------------------------------------

export async function getGroups(): Promise<Group[]> {
  return apiFetch("/groups");
}

export async function createGroup(data: { name: string; description?: string }): Promise<Group> {
  return apiFetch("/groups", {
    method: "POST",
    body: JSON.stringify(data),
  });
}

export async function updateGroup(id: string, data: { name?: string; description?: string }): Promise<Group> {
  return apiFetch(`/groups/${id}`, {
    method: "PATCH",
    body: JSON.stringify(data),
  });
}

export async function deleteGroup(id: string): Promise<void> {
  return apiFetch(`/groups/${id}`, { method: "DELETE" });
}

export async function getGroupMembers(groupId: string): Promise<GroupMember[]> {
  return apiFetch(`/groups/${groupId}/members`);
}

export async function addGroupMember(groupId: string, userId: string): Promise<void> {
  return apiFetch(`/groups/${groupId}/members`, {
    method: "POST",
    body: JSON.stringify({ user_id: userId }),
  });
}

export async function removeGroupMember(groupId: string, userId: string): Promise<void> {
  return apiFetch(`/groups/${groupId}/members/${userId}`, { method: "DELETE" });
}

// ---------------------------------------------------------------------------
// API Keys
// ---------------------------------------------------------------------------

export async function getApiKeys(): Promise<ApiKeyInfo[]> {
  return apiFetch("/api-keys");
}

export async function createApiKey(data: {
  name: string;
  owner_id: string;
  folder_id?: string | null;
  permissions?: string[];
  allow_overwrite?: boolean;
  expires_at?: string | null;
}): Promise<ApiKeyCreateResponse> {
  return apiFetch("/api-keys", {
    method: "POST",
    body: JSON.stringify(data),
  });
}

export async function updateApiKey(id: string, data: {
  name?: string;
  folder_id?: string | null;
  permissions?: string[];
  allow_overwrite?: boolean;
  is_active?: boolean;
  expires_at?: string | null;
}): Promise<ApiKeyInfo> {
  return apiFetch(`/api-keys/${id}`, {
    method: "PATCH",
    body: JSON.stringify(data),
  });
}

export async function deleteApiKey(id: string): Promise<void> {
  return apiFetch(`/api-keys/${id}`, { method: "DELETE" });
}

// ---------------------------------------------------------------------------
// Audit Logs
// ---------------------------------------------------------------------------

export async function getAuditLogs(params: {
  page?: number;
  per_page?: number;
  action?: string;
  user_id?: string;
  date_from?: string;
  date_to?: string;
  q?: string;
} = {}): Promise<AuditLogListResponse> {
  const p = new URLSearchParams();
  if (params.page) p.set("page", String(params.page));
  if (params.per_page) p.set("per_page", String(params.per_page));
  if (params.action) p.set("action", params.action);
  if (params.user_id) p.set("user_id", params.user_id);
  if (params.date_from) p.set("date_from", params.date_from);
  if (params.date_to) p.set("date_to", params.date_to);
  if (params.q) p.set("q", params.q);
  return apiFetch(`/admin/audit-logs?${p.toString()}`);
}

export async function getAuditLogActions(): Promise<string[]> {
  return apiFetch("/admin/audit-logs/actions");
}

export async function exportAuditLogsCsv(params: {
  action?: string;
  user_id?: string;
  date_from?: string;
  date_to?: string;
  q?: string;
} = {}): Promise<void> {
  const p = new URLSearchParams();
  if (params.action) p.set("action", params.action);
  if (params.user_id) p.set("user_id", params.user_id);
  if (params.date_from) p.set("date_from", params.date_from);
  if (params.date_to) p.set("date_to", params.date_to);
  if (params.q) p.set("q", params.q);
  const token = getToken();
  const res = await fetch(`${API_BASE}/admin/audit-logs/export?${p.toString()}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) throw new Error("Export failed");
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "audit_logs.csv";
  a.click();
  URL.revokeObjectURL(url);
}

// ---------------------------------------------------------------------------
// Mail Recipients
// ---------------------------------------------------------------------------

export interface MailRecipient {
  id: string;
  email: string;
  on_login: boolean;
  on_create: boolean;
  on_update: boolean;
  on_delete: boolean;
  enabled: boolean;
}

export async function getMailRecipients(): Promise<MailRecipient[]> {
  return apiFetch("/admin/mail/recipients");
}

export async function addMailRecipient(email: string): Promise<MailRecipient> {
  return apiFetch("/admin/mail/recipients", {
    method: "POST",
    body: JSON.stringify({ email }),
  });
}

export async function updateMailRecipient(
  id: string,
  data: Partial<Pick<MailRecipient, "on_login" | "on_create" | "on_update" | "on_delete" | "enabled">>,
): Promise<MailRecipient> {
  return apiFetch(`/admin/mail/recipients/${id}`, {
    method: "PATCH",
    body: JSON.stringify(data),
  });
}

export async function deleteMailRecipient(id: string): Promise<void> {
  return apiFetch(`/admin/mail/recipients/${id}`, { method: "DELETE" });
}

export async function sendTestMail(to: string): Promise<{ status: string; message: string }> {
  return apiFetch("/admin/mail/test", {
    method: "POST",
    body: JSON.stringify({ to }),
  });
}
