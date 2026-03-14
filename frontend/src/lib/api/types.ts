export interface LoginResponse {
  access_token: string;
  refresh_token: string;
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

export interface TagInfo {
  id: number;
  name: string;
  color: string | null;
}

export interface Folder {
  id: string;
  name: string;
  parent_id: string | null;
  owner_id: string | null;
  group_id: string | null;
  group_name: string | null;
  group_read: boolean;
  group_write: boolean;
  others_read: boolean;
  others_write: boolean;
  document_count: number;
  created_at: string;
  updated_at: string;
}

export interface Document {
  id: string;
  title: string;
  summary: string | null;
  content: string;
  file_type: string;
  source_path: string | null;
  searchable: boolean;
  ai_knowledge: boolean;
  chunk_count: number;
  memo: string | null;
  folder_id: string | null;
  folder_name: string | null;
  owner_id: string | null;
  owner_name: string | null;
  group_id: string | null;
  group_name: string | null;
  group_read: boolean;
  group_write: boolean;
  others_read: boolean;
  others_write: boolean;
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
  searchable: boolean;
  ai_knowledge: boolean;
  chunk_count: number;
  memo: string | null;
  folder_id: string | null;
  folder_name: string | null;
  owner_id: string | null;
  owner_name: string | null;
  group_id: string | null;
  group_name: string | null;
  group_read: boolean;
  group_write: boolean;
  others_read: boolean;
  others_write: boolean;
  permissions: string;
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

export interface UnixPermissions {
  owner_id?: string | null;
  group_id?: string | null;
  group_read?: boolean;
  group_write?: boolean;
  others_read?: boolean;
  others_write?: boolean;
}

export interface Group {
  id: string;
  name: string;
  description: string;
  member_count: number;
  created_at: string;
  updated_at: string;
}

export interface GroupMember {
  user_id: string;
  username: string;
  display_name: string;
  created_at: string;
}

export interface StatsResponse {
  total_documents: number;
  total_chunks: number;
  disk_used_bytes: number;
  disk_total_bytes: number;
}

export interface TrashItem {
  id: string;
  title: string;
  file_type: string;
  deleted_at: string;
}

export interface SystemSetting {
  key: string;
  value: string;
  description: string | null;
  placeholder: string | null;
  secret: boolean;
}

export interface ApiKeyInfo {
  id: string;
  name: string;
  key_prefix: string;
  owner_id: string;
  owner_name: string;
  folder_id: string | null;
  folder_name: string | null;
  permissions: string[];
  allow_overwrite: boolean;
  is_active: boolean;
  last_used_at: string | null;
  expires_at: string | null;
  created_at: string;
}

export interface ApiKeyCreateResponse extends ApiKeyInfo {
  plaintext_key: string;
}

export interface DocumentSearchItem extends DocumentListItem {
  rrf_score?: number;
}

export interface DocumentSearchResponse {
  items: DocumentSearchItem[];
  total: number;
  page: number;
  per_page: number;
  tokens: string[];
}

export interface ChatStatus {
  model: string;
  available: boolean;
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
