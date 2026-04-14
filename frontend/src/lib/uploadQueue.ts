import * as tus from "tus-js-client";
import { t } from "@/i18n";
import { getToken } from "@/lib/api";
import { getProcessingStatus, getDocuments } from "@/lib/api/documents";
import { trackUploadStart, trackUploadEnd } from "./fileExplorerHelpers";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface QueueItem {
  id: string;
  file: File | null; // nulled after upload completes (memory management)
  filename: string;
  folderId: string | null;
  status: "queued" | "uploading" | "processing" | "done" | "error" | "cancelled";
  progress: number;
  processingStatus?: string;
  processingLabel?: string;
  error?: string;
  bytesUploaded: number;
  bytesTotal: number;
  processingStartedAt?: number;
}

export interface QueueState {
  items: QueueItem[];
  activeCount: number;
  totalBytes: number;
  uploadedBytes: number;
  completedCount: number;
  errorCount: number;
  cancelledCount: number;
  isRunning: boolean;
}

export type QueueListener = (state: QueueState) => void;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_CONCURRENT = 3;
const POLL_INTERVAL = 2000;
const PROCESSING_TIMEOUT = 5 * 60 * 1000; // 5 minutes

// ---------------------------------------------------------------------------
// UploadQueueManager
// ---------------------------------------------------------------------------

export class UploadQueueManager {
  private queue: QueueItem[] = [];
  private activeUploads = new Map<string, tus.Upload>();
  private listeners = new Set<QueueListener>();
  private processingDocIds = new Map<string, string>(); // itemId → docId
  private pollingTimer: ReturnType<typeof setInterval> | null = null;
  private completedSinceLastReload = 0;
  private aborted = false;
  private onBatchReload: () => void;

  constructor(onBatchReload: () => void) {
    this.onBatchReload = onBatchReload;
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /** Enqueue files with a single shared folderId */
  enqueue(files: File[], folderId?: string | null): void;
  /** Enqueue files with per-file folderId */
  enqueue(items: { file: File; folderId: string | null }[]): void;
  enqueue(
    filesOrItems: File[] | { file: File; folderId: string | null }[],
    folderId?: string | null,
  ): void {
    this.aborted = false;
    for (const entry of filesOrItems) {
      const isFileObj = entry instanceof File;
      const file = isFileObj ? entry : entry.file;
      const folder = isFileObj ? (folderId ?? null) : entry.folderId;
      this.queue.push({
        id: crypto.randomUUID(),
        file,
        filename: file.name,
        folderId: folder,
        status: "queued",
        progress: 0,
        bytesUploaded: 0,
        bytesTotal: file.size,
      });
    }
    this._notify();
    this._processNext();
  }

  abort(): void {
    this.aborted = true;

    for (const [id, upload] of this.activeUploads) {
      upload.abort(true).catch(() => {});
      const item = this.queue.find((i) => i.id === id);
      if (item) {
        item.status = "cancelled";
        if (item.filename) trackUploadEnd(item.filename);
      }
    }
    this.activeUploads.clear();

    for (const item of this.queue) {
      if (item.status === "queued") {
        item.status = "cancelled";
      }
    }

    this._stopPolling();
    this._notify();
  }

  cancel(itemId: string): void {
    const item = this.queue.find((i) => i.id === itemId);
    if (item && item.status === "queued") {
      item.status = "cancelled";
      this._notify();
    }
  }

  clear(): void {
    this.queue = this.queue.filter(
      (i) => i.status !== "done" && i.status !== "error" && i.status !== "cancelled",
    );
    if (this.queue.length === 0) {
      this.aborted = false;
      this.completedSinceLastReload = 0;
    }
    this._notify();
  }

  subscribe(listener: QueueListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getState(): QueueState {
    let activeCount = 0;
    let totalBytes = 0;
    let uploadedBytes = 0;
    let completedCount = 0;
    let errorCount = 0;
    let cancelledCount = 0;

    for (const item of this.queue) {
      totalBytes += item.bytesTotal;
      if (item.status === "uploading") {
        activeCount++;
        uploadedBytes += item.bytesUploaded;
      } else if (item.status === "done") {
        completedCount++;
        uploadedBytes += item.bytesTotal;
      } else if (item.status === "error") {
        errorCount++;
        uploadedBytes += item.bytesUploaded;
      } else if (item.status === "cancelled") {
        cancelledCount++;
      } else if (item.status === "processing") {
        uploadedBytes += item.bytesTotal; // upload part is done
      }
    }

    const isRunning = this.queue.some(
      (i) => i.status === "queued" || i.status === "uploading" || i.status === "processing",
    );

    return {
      items: [...this.queue],
      activeCount,
      totalBytes,
      uploadedBytes,
      completedCount,
      errorCount,
      cancelledCount,
      isRunning,
    };
  }

  // -----------------------------------------------------------------------
  // Internal: queue processing
  // -----------------------------------------------------------------------

  private _processNext(): void {
    if (this.aborted) return;

    const activeCount = this.queue.filter((i) => i.status === "uploading").length;
    if (activeCount >= MAX_CONCURRENT) return;

    const next = this.queue.find((i) => i.status === "queued");
    if (!next || !next.file) return;

    next.status = "uploading";
    this._notify();

    this._startUpload(next);

    // Fill remaining slots
    if (activeCount + 1 < MAX_CONCURRENT) {
      this._processNext();
    }
  }

  private _startUpload(item: QueueItem): void {
    const file = item.file!;
    const token = getToken() || "";

    trackUploadStart(file.name);

    const upload = new tus.Upload(file, {
      endpoint: "/tusd/",
      retryDelays: [0, 1000, 3000, 5000],
      chunkSize: 5 * 1024 * 1024,
      metadata: {
        filename: file.name,
        filetype: file.type || "application/octet-stream",
        folder_id: item.folderId || "",
        token,
      },
      onProgress: (loaded, total) => {
        if (this.aborted || item.status !== "uploading") return;
        item.bytesUploaded = loaded;
        item.bytesTotal = total;
        item.progress = Math.round((loaded / total) * 100);
        this._notify();
      },
      onSuccess: () => {
        if (item.status !== "uploading") return;
        trackUploadEnd(item.filename);
        item.status = "processing";
        item.progress = 100;
        item.bytesUploaded = item.bytesTotal;
        item.processingStartedAt = Date.now();
        item.file = null; // release memory
        this.activeUploads.delete(item.id);
        this._startPolling();
        this._onItemUploaded();
        this._notify();
        this._processNext();
      },
      onError: (error) => {
        if (this.aborted || item.status !== "uploading") return;

        // Resume failure: retry from scratch
        if (error.message?.includes("failed to resume")) {
          upload.abort(true).catch(() => {});
          const freshUpload = new tus.Upload(file, {
            ...upload.options,
            removeFingerprintOnSuccess: true,
          });
          this.activeUploads.set(item.id, freshUpload);
          freshUpload.start();
          return;
        }

        trackUploadEnd(item.filename);
        item.status = "error";
        item.error = error.message?.includes("403") || error.message?.includes("permission")
          ? t("common:noPermission")
          : error.message || t("common:failed");
        item.file = null;
        this.activeUploads.delete(item.id);
        this._notify();
        this._processNext();
        this._checkDrain();
      },
      removeFingerprintOnSuccess: true,
    });

    this.activeUploads.set(item.id, upload);

    upload
      .findPreviousUploads()
      .then((prev) => {
        if (this.aborted || item.status !== "uploading") return;
        if (prev.length > 0) {
          upload.resumeFromPreviousUpload(prev[0]);
        }
        upload.start();
      })
      .catch(() => {
        if (!this.aborted && item.status === "uploading") upload.start();
      });
  }

  // -----------------------------------------------------------------------
  // Internal: post-upload tracking
  // -----------------------------------------------------------------------

  private _onItemUploaded(): void {
    this.completedSinceLastReload++;
    if (this.completedSinceLastReload >= 5) {
      this.completedSinceLastReload = 0;
      this.onBatchReload();
    }
  }

  private _checkDrain(): void {
    const hasActive = this.queue.some(
      (i) => i.status === "queued" || i.status === "uploading" || i.status === "processing",
    );
    if (!hasActive && this.queue.length > 0) {
      this.onBatchReload();
      this.completedSinceLastReload = 0;
    }
  }

  // -----------------------------------------------------------------------
  // Internal: batch polling for processing status
  // -----------------------------------------------------------------------

  private _startPolling(): void {
    if (this.pollingTimer) return;
    this.pollingTimer = setInterval(() => this._pollBatch(), POLL_INTERVAL);
  }

  private _stopPolling(): void {
    if (this.pollingTimer) {
      clearInterval(this.pollingTimer);
      this.pollingTimer = null;
    }
  }

  private async _pollBatch(): Promise<void> {
    const processing = this.queue.filter((i) => i.status === "processing");
    if (processing.length === 0) {
      this._stopPolling();
      this._checkDrain();
      return;
    }

    // Resolve docIds for items that don't have one yet
    for (const item of processing) {
      if (this.processingDocIds.has(item.id)) continue;
      try {
        const data = await getDocuments({ q: item.filename, per_page: 1 });
        if (data.items.length > 0) {
          this.processingDocIds.set(item.id, data.items[0].id);
        }
      } catch {
        // retry next cycle
      }
    }

    let changed = false;

    for (const item of processing) {
      // Timeout check
      if (item.processingStartedAt && Date.now() - item.processingStartedAt > PROCESSING_TIMEOUT) {
        item.status = "error";
        item.error = t("fileExplorer:processingTimeout");
        this.processingDocIds.delete(item.id);
        changed = true;
        continue;
      }

      const docId = this.processingDocIds.get(item.id);
      if (!docId) continue;

      try {
        const s = await getProcessingStatus(docId);
        item.processingStatus = s;
        item.processingLabel = t(`fileExplorer:status.${s}`) || s;

        if (s === "done") {
          item.status = "done";
          this.processingDocIds.delete(item.id);
          changed = true;
        } else if (s === "error") {
          item.status = "error";
          item.error = t("fileExplorer:processingError");
          this.processingDocIds.delete(item.id);
          changed = true;
        }
      } catch {
        // ignore individual poll errors
      }
    }

    if (changed) {
      this._checkDrain();
    }
    this._notify();
  }

  // -----------------------------------------------------------------------
  // Internal: notifications
  // -----------------------------------------------------------------------

  private _notify(): void {
    const state = this.getState();
    for (const listener of this.listeners) {
      listener(state);
    }
  }
}
