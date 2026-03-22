import { apiFetch } from "./client";
import type { NoteTreeItem, NoteDetail } from "./types";

export async function getNoteTree(): Promise<NoteTreeItem[]> {
  return apiFetch("/notes");
}

export async function getNote(id: string): Promise<NoteDetail> {
  return apiFetch(`/notes/${id}`);
}

export async function createNote(parentNoteId?: string | null): Promise<{ id: string; title: string; parent_note_id: string | null; note_order: number }> {
  return apiFetch("/notes", {
    method: "POST",
    body: JSON.stringify({ parent_note_id: parentNoteId || null }),
  });
}

export async function updateNote(id: string, data: { title?: string; note_content?: unknown }): Promise<{ id: string; title: string; updated_at: string }> {
  return apiFetch(`/notes/${id}`, {
    method: "PATCH",
    body: JSON.stringify(data),
  });
}

export async function moveNote(id: string, data: { parent_note_id?: string | null; note_order?: number; position?: number }): Promise<void> {
  return apiFetch(`/notes/${id}/move`, {
    method: "PATCH",
    body: JSON.stringify(data),
  });
}

export async function removeNote(id: string): Promise<void> {
  return apiFetch(`/notes/${id}/remove`, { method: "POST" });
}

export async function deleteNoteWithFile(id: string): Promise<void> {
  return apiFetch(`/notes/${id}/delete-with-file`, { method: "POST" });
}

export async function convertToNote(documentId: string, parentNoteId?: string | null): Promise<{ id: string; title: string; is_note: boolean }> {
  return apiFetch(`/notes/from-document/${documentId}`, {
    method: "POST",
    body: JSON.stringify({ parent_note_id: parentNoteId || null }),
  });
}

export async function exportNoteMd(id: string): Promise<{ markdown: string; title: string }> {
  return apiFetch(`/notes/${id}/export-md`, { method: "POST" });
}

// Admin
export interface AdminNoteItem {
  id: string;
  title: string;
  parent_note_id: string | null;
  note_order: number;
  file_type: string;
  note_readonly: boolean;
  created_at: string;
  updated_at: string;
}

export async function adminToggleNoteReadonly(noteId: string, noteReadonly: boolean): Promise<{ id: string; note_readonly: boolean }> {
  return apiFetch(`/notes/admin/${noteId}/readonly`, {
    method: "PATCH",
    body: JSON.stringify({ note_readonly: noteReadonly }),
  });
}

export async function adminListNotes(): Promise<AdminNoteItem[]> {
  return apiFetch("/notes/admin/list");
}

export async function adminBulkDeleteNotes(noteIds: string[]): Promise<{ deleted: number }> {
  return apiFetch("/notes/admin/bulk-delete", {
    method: "POST",
    body: JSON.stringify({ note_ids: noteIds }),
  });
}
