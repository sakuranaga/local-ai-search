import { apiFetch } from "./client";
import type {
  ApiKeyCreateResponse,
  ApiKeyInfo,
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
