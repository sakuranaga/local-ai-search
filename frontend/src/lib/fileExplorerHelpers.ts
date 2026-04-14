import * as tus from "tus-js-client";
import { toast } from "sonner";
import { t } from "@/i18n";
import { getProcessingStatus, getToken, type Folder } from "@/lib/api";

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

export function formatDateTime(d: string): string {
  const dt = new Date(d);
  return dt.toLocaleDateString("ja-JP", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }) + " " + dt.toLocaleTimeString("ja-JP", {
    hour: "2-digit",
    minute: "2-digit",
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
  queued: "順番待ち...",
  scanning: "ウイルススキャン中...",
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

export function clearUnpinnedSearchHistory(): SearchHistoryEntry[] {
  const entries = loadSearchHistory().filter((e) => e.pinned);
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
  // Accumulate child document counts into parent
  const accumulate = (nodes: FolderNode[]): number => {
    let total = 0;
    for (const n of nodes) {
      n.document_count += accumulate(n.children);
      total += n.document_count;
    }
    return total;
  };
  accumulate(roots);
  return roots;
}

// ---------------------------------------------------------------------------
// Active upload tracking (survives reload)
// ---------------------------------------------------------------------------

const ACTIVE_UPLOADS_KEY = "las_active_uploads";

interface ActiveUploadEntry {
  filename: string;
  startedAt: number;
}

function getActiveUploads(): Record<string, ActiveUploadEntry> {
  try { return JSON.parse(localStorage.getItem(ACTIVE_UPLOADS_KEY) || "{}"); } catch { return {}; }
}

function saveActiveUploads(entries: Record<string, ActiveUploadEntry>) {
  localStorage.setItem(ACTIVE_UPLOADS_KEY, JSON.stringify(entries));
}

export function trackUploadStart(filename: string) {
  const entries = getActiveUploads();
  entries[filename] = { filename, startedAt: Date.now() };
  saveActiveUploads(entries);
}

export function trackUploadEnd(filename: string) {
  const entries = getActiveUploads();
  delete entries[filename];
  saveActiveUploads(entries);
}

export function checkInterruptedUploads(): string[] {
  const entries = getActiveUploads();
  return Object.values(entries).map((e) => e.filename);
}

export function clearInterruptedUpload(filename: string) {
  trackUploadEnd(filename);
  // Remove tus fingerprints from localStorage so re-upload starts fresh
  const keysToRemove: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key && key.startsWith("tus::") && key.includes(filename)) {
      keysToRemove.push(key);
    }
  }
  for (const key of keysToRemove) localStorage.removeItem(key);
}

export function clearAllInterruptedUploads() {
  saveActiveUploads({});
}

// ---------------------------------------------------------------------------
// Upload with progress toast
// ---------------------------------------------------------------------------

export function uploadWithProgress(
  file: globalThis.File,
  onUploaded: () => void,
  folderId?: string | null,
): () => void {
  // Dismiss interrupted upload toast if present
  toast.dismiss(`interrupted-${file.name}`);
  const toastId = toast.loading(t("fileExplorer:uploadToast.preparing", { name: file.name }));
  const token = getToken() || "";
  let aborted = false;
  let activeUpload: tus.Upload | null = null;

  trackUploadStart(file.name);

  const cancel = () => {
    aborted = true;
    trackUploadEnd(file.name);
    if (activeUpload) {
      activeUpload.abort(true).catch(() => {});
    }
    toast.info(t("fileExplorer:uploadToast.cancelled", { name: file.name }), { id: toastId });
  };

  const cancelAction = {
    label: t("fileExplorer:uploadToast.cancelButton"),
    onClick: cancel,
  };

  const upload = new tus.Upload(file, {
    endpoint: "/tusd/",
    retryDelays: [0, 1000, 3000, 5000],
    chunkSize: 5 * 1024 * 1024,
    metadata: {
      filename: file.name,
      filetype: file.type || "application/octet-stream",
      folder_id: folderId || "",
      token,
    },
    onProgress: (loaded, total) => {
      if (aborted) return;
      const pct = Math.round((loaded / total) * 100);
      toast.loading(t("fileExplorer:uploadToast.uploading", { name: file.name, pct }), { id: toastId, action: cancelAction });
    },
    onSuccess: () => {
      if (aborted) return;
      trackUploadEnd(file.name);
      toast.loading(t("fileExplorer:uploadToast.processing", { name: file.name }), { id: toastId, action: undefined });
      onUploaded();
      _pollProcessingByTitle(file.name, toastId, onUploaded);
    },
    onError: (error) => {
      if (aborted) return;
      // If resume failed, clear previous uploads and retry from scratch
      if (error.message && error.message.includes("failed to resume")) {
        upload.abort(true).catch(() => {});
        const freshUpload = new tus.Upload(file, { ...upload.options });
        activeUpload = freshUpload;
        freshUpload.start();
        toast.loading(t("fileExplorer:uploadToast.resuming", { name: file.name }), { id: toastId, action: cancelAction });
        return;
      }
      trackUploadEnd(file.name);
      const msg = error.message?.includes("403") || error.message?.includes("permission")
        ? t("common:noPermission")
        : error.message;
      toast.error(t("fileExplorer:uploadToast.uploadFailed", { name: file.name, msg }), { id: toastId });
    },
    removeFingerprintOnSuccess: true,
  });

  activeUpload = upload;

  // Resume previous upload if exists, otherwise start fresh
  upload.findPreviousUploads().then((prev) => {
    if (aborted) return;
    if (prev.length > 0) {
      toast.loading(t("fileExplorer:uploadToast.resumingTus", { name: file.name }), { id: toastId, action: cancelAction });
      upload.resumeFromPreviousUpload(prev[0]);
    }
    upload.start();
  }).catch(() => {
    if (!aborted) upload.start();
  });

  return cancel;
}

async function _pollProcessingByTitle(
  filename: string,
  toastId: string | number,
  onUploaded: () => void,
) {
  // Wait a moment for tus-hook to create the Document
  await new Promise((r) => setTimeout(r, 2000));

  // Find the document by title to get its ID
  const { getDocuments } = await import("@/lib/api");
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      const data = await getDocuments({ q: filename, per_page: 1 });
      if (data.items.length > 0) {
        const docId = data.items[0].id;
        // Now poll processing status
        for (let i = 0; i < 300; i++) {
          await new Promise((r) => setTimeout(r, 1000));
          try {
            const s = await getProcessingStatus(docId);
            if (s === "done") {
              toast.success(t("fileExplorer:uploadToast.processingDone", { name: filename }), { id: toastId, action: undefined });
              onUploaded();
              return;
            }
            if (s === "error") {
              toast.error(t("fileExplorer:uploadToast.processingError", { name: filename }), { id: toastId, action: undefined });
              return;
            }
            toast.loading(t("fileExplorer:uploadToast.processingStatus", { name: filename, status: t(`fileExplorer:status.${s}`) || s }), { id: toastId, action: undefined });
          } catch {
            // ignore poll errors
          }
        }
        toast.error(t("fileExplorer:uploadToast.timeout", { name: filename }), { id: toastId, action: undefined });
        return;
      }
    } catch {
      // retry
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  // Couldn't find the document — show success anyway (upload itself succeeded)
  toast.success(t("fileExplorer:uploadToast.uploadDone", { name: filename }), { id: toastId, action: undefined });
  onUploaded();
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

// ---------------------------------------------------------------------------
// Directory entry traversal (for folder drag-and-drop upload)
// ---------------------------------------------------------------------------

export interface FileWithPath {
  file: File;
  /** Relative folder path, e.g. "営業資料/見積書" (empty string for root files) */
  folderPath: string;
}

/**
 * Check if a DataTransfer contains directory entries.
 */
export function hasDirectoryEntries(dataTransfer: DataTransfer): boolean {
  const items = dataTransfer.items;
  for (let i = 0; i < items.length; i++) {
    const entry = items[i].webkitGetAsEntry?.();
    if (entry?.isDirectory) return true;
  }
  return false;
}

export interface TraversalResult {
  files: FileWithPath[];
  truncated: boolean;
}

/**
 * Recursively traverse DataTransfer entries (files + directories).
 * Returns a flat list of files with their relative folder paths.
 * If maxFiles is set, stops early and returns truncated: true.
 */
export async function traverseDataTransferItems(
  dataTransfer: DataTransfer,
  maxFiles?: number,
): Promise<TraversalResult> {
  const results: FileWithPath[] = [];
  const entries: FileSystemEntry[] = [];

  for (let i = 0; i < dataTransfer.items.length; i++) {
    const entry = dataTransfer.items[i].webkitGetAsEntry?.();
    if (entry) entries.push(entry);
  }

  let truncated = false;
  for (const entry of entries) {
    if (truncated) break;
    truncated = await _traverseEntry(entry, "", results, maxFiles);
  }

  return { files: results, truncated };
}

/** Returns true if limit was hit */
async function _traverseEntry(
  entry: FileSystemEntry,
  parentPath: string,
  results: FileWithPath[],
  maxFiles?: number,
): Promise<boolean> {
  if (maxFiles && results.length > maxFiles) {
    return true;
  }

  if (entry.isFile) {
    const fileEntry = entry as FileSystemFileEntry;
    const file = await new Promise<File>((resolve, reject) => {
      fileEntry.file(resolve, reject);
    });
    // Skip hidden files (e.g. .DS_Store)
    if (!file.name.startsWith(".")) {
      results.push({ file, folderPath: parentPath });
    }
  } else if (entry.isDirectory) {
    // Skip hidden directories (e.g. .git, .svn, __MACOSX)
    if (entry.name.startsWith(".") || entry.name === "__MACOSX") {
      return false;
    }
    const dirEntry = entry as FileSystemDirectoryEntry;
    const dirPath = parentPath ? `${parentPath}/${entry.name}` : entry.name;
    const reader = dirEntry.createReader();

    let batch: FileSystemEntry[];
    do {
      batch = await new Promise<FileSystemEntry[]>((resolve, reject) => {
        reader.readEntries(resolve, reject);
      });
      for (const child of batch) {
        const hit = await _traverseEntry(child, dirPath, results, maxFiles);
        if (hit) return true;
      }
    } while (batch.length > 0);
  }

  return false;
}
