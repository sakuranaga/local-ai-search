import { toast } from "sonner";
import { uploadDocument, getProcessingStatus, type Folder } from "@/lib/api";

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------

export function formatDate(d: string): string {
  return new Date(d).toLocaleDateString("ja-JP", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
}

export function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const FILE_TYPES = ["", "md", "pdf", "docx"] as const;

export const TAG_COLORS = [
  "#ef4444", "#f97316", "#eab308", "#22c55e", "#06b6d4",
  "#3b82f6", "#8b5cf6", "#ec4899", "#6b7280",
];

export const STATUS_LABELS: Record<string, string> = {
  pending: "待機中...",
  parsing: "テキスト抽出中...",
  chunking: "チャンク分割中...",
  embedding: "ベクトル化中...",
  summarizing: "要約生成中...",
  done: "完了",
  error: "エラー",
};

// ---------------------------------------------------------------------------
// Search History (localStorage, max 50)
// ---------------------------------------------------------------------------

const SEARCH_HISTORY_KEY = "las_search_history";
const SEARCH_HISTORY_MAX = 50;

export interface SearchHistoryEntry {
  query: string;
  pinned: boolean;
  timestamp: number;
}

export function loadSearchHistory(): SearchHistoryEntry[] {
  try {
    const raw = localStorage.getItem(SEARCH_HISTORY_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

export function saveSearchHistory(entries: SearchHistoryEntry[]) {
  try {
    localStorage.setItem(SEARCH_HISTORY_KEY, JSON.stringify(entries));
  } catch {}
}

export function addSearchHistory(query: string): SearchHistoryEntry[] {
  const entries = loadSearchHistory();
  const filtered = entries.filter((e) => e.query !== query);
  const newEntry: SearchHistoryEntry = { query, pinned: false, timestamp: Date.now() };
  const existing = entries.find((e) => e.query === query);
  if (existing?.pinned) newEntry.pinned = true;
  filtered.unshift(newEntry);
  const pinned = filtered.filter((e) => e.pinned);
  const unpinned = filtered.filter((e) => !e.pinned);
  const result = [...pinned, ...unpinned].slice(0, SEARCH_HISTORY_MAX);
  saveSearchHistory(result);
  return result;
}

export function togglePinSearchHistory(query: string): SearchHistoryEntry[] {
  const entries = loadSearchHistory();
  const entry = entries.find((e) => e.query === query);
  if (entry) entry.pinned = !entry.pinned;
  saveSearchHistory(entries);
  return entries;
}

export function removeSearchHistory(query: string): SearchHistoryEntry[] {
  const entries = loadSearchHistory().filter((e) => e.query !== query);
  saveSearchHistory(entries);
  return entries;
}

// ---------------------------------------------------------------------------
// Folder tree
// ---------------------------------------------------------------------------

export interface FolderNode extends Folder {
  children: FolderNode[];
}

export function buildFolderTree(folders: Folder[]): FolderNode[] {
  const map = new Map<string, FolderNode>();
  for (const f of folders) {
    map.set(f.id, { ...f, children: [] });
  }
  const roots: FolderNode[] = [];
  for (const node of map.values()) {
    if (node.parent_id && map.has(node.parent_id)) {
      map.get(node.parent_id)!.children.push(node);
    } else {
      roots.push(node);
    }
  }
  const sortChildren = (nodes: FolderNode[]) => {
    nodes.sort((a, b) => a.name.localeCompare(b.name));
    for (const n of nodes) sortChildren(n.children);
  };
  sortChildren(roots);
  return roots;
}

// ---------------------------------------------------------------------------
// Upload with progress toast
// ---------------------------------------------------------------------------

export async function uploadWithProgress(
  file: globalThis.File,
  onUploaded: () => void,
  folderId?: string | null,
): Promise<void> {
  const toastId = toast.loading(`${file.name}: アップロード中...`);
  try {
    const doc = await uploadDocument(file, folderId);
    onUploaded();

    const poll = async () => {
      for (let i = 0; i < 300; i++) {
        await new Promise((r) => setTimeout(r, 1000));
        try {
          const s = await getProcessingStatus(doc.id);
          if (s === "done") {
            toast.success(`${file.name}: 処理完了`, { id: toastId });
            onUploaded();
            return;
          }
          if (s === "error") {
            toast.error(`${file.name}: 処理エラー`, { id: toastId });
            return;
          }
          toast.loading(`${file.name}: ${STATUS_LABELS[s] ?? s}`, { id: toastId });
        } catch {
          // ignore poll errors
        }
      }
      toast.error(`${file.name}: タイムアウト`, { id: toastId });
    };
    poll();
  } catch {
    toast.error(`${file.name}: アップロード失敗`, { id: toastId });
  }
}

// ---------------------------------------------------------------------------
// Permission string formatter
// ---------------------------------------------------------------------------

export function formatPermString(gr: boolean, gw: boolean, or_: boolean, ow: boolean): string {
  const owner = "rw";
  const group = (gr ? "r" : "-") + (gw ? "w" : "-");
  const others = (or_ ? "r" : "-") + (ow ? "w" : "-");
  return `${owner}${group}${others}`;
}
