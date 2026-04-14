import { useEffect, useState } from "react";
import { X, Minimize2, Maximize2, AlertCircle, Loader2, CheckCircle2, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { formatBytes } from "@/lib/fileExplorerHelpers";
import { t } from "@/i18n";
import type { QueueState, QueueItem } from "@/lib/uploadQueue";

interface Props {
  state: QueueState;
  onAbort: () => void;
  onClear: () => void;
}

export function UploadProgressPanel({ state, onAbort, onClear }: Props) {
  const [minimized, setMinimized] = useState(false);
  const [showErrors, setShowErrors] = useState(false);
  const [confirmAbort, setConfirmAbort] = useState(false);

  // Auto-hide when all done with no errors
  useEffect(() => {
    const terminal = state.completedCount + state.errorCount + state.cancelledCount;
    if (terminal === state.items.length && state.items.length > 0 && state.errorCount === 0) {
      const timer = setTimeout(onClear, 3000);
      return () => clearTimeout(timer);
    }
  }, [state, onClear]);

  const pct = state.totalBytes > 0 ? Math.round((state.uploadedBytes / state.totalBytes) * 100) : 0;
  const uploading = state.items.filter((i) => i.status === "uploading");
  const processing = state.items.filter((i) => i.status === "processing");
  const errors = state.items.filter((i) => i.status === "error");
  const allTerminal = !state.isRunning;

  function handleClose() {
    if (state.isRunning) {
      setConfirmAbort(true);
    } else {
      onClear();
    }
  }

  function handleConfirmAbort() {
    setConfirmAbort(false);
    onAbort();
  }

  // Minimized view
  if (minimized) {
    return (
      <div
        className="fixed bottom-4 right-4 z-40 flex items-center gap-2 rounded-lg bg-card text-card-foreground border shadow-lg px-3 py-2 cursor-pointer select-none"
        onClick={() => setMinimized(false)}
      >
        <Maximize2 className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="text-sm font-medium">
          {t("fileExplorer:uploadProgress.progress", { completed: state.completedCount, total: state.items.length })}
        </span>
        <div className="w-24 h-1.5 rounded-full bg-muted overflow-hidden">
          <div className="h-full bg-primary rounded-full transition-all" style={{ width: `${pct}%` }} />
        </div>
        <span className="text-xs text-muted-foreground">
          {formatBytes(state.uploadedBytes)}/{formatBytes(state.totalBytes)}
        </span>
        {state.errorCount > 0 && (
          <AlertCircle className="h-3.5 w-3.5 text-destructive" />
        )}
      </div>
    );
  }

  // Expanded view
  return (
    <>
      {/* Abort confirmation */}
      {confirmAbort && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="bg-card rounded-lg border shadow-lg p-4 max-w-sm">
            <p className="text-sm font-medium mb-3">
              {t("fileExplorer:uploadProgress.cancelConfirm")}
            </p>
            <div className="flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={() => setConfirmAbort(false)}>
                {t("common:cancel")}
              </Button>
              <Button variant="destructive" size="sm" onClick={handleConfirmAbort}>
                {t("fileExplorer:uploadProgress.abort")}
              </Button>
            </div>
          </div>
        </div>
      )}

      <div className="fixed bottom-4 right-4 z-40 w-96 rounded-lg bg-card text-card-foreground border shadow-lg overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-3 py-2 border-b bg-muted/30">
          <span className="text-sm font-medium">
            {t("fileExplorer:uploadProgress.title", { completed: state.completedCount, total: state.items.length })}
          </span>
          <div className="flex items-center gap-0.5">
            <button
              className="p-1 rounded hover:bg-muted"
              onClick={() => setMinimized(true)}
              title={t("fileExplorer:uploadProgress.minimize")}
            >
              <Minimize2 className="h-3.5 w-3.5" />
            </button>
            <button
              className="p-1 rounded hover:bg-muted"
              onClick={handleClose}
              title={t("common:close")}
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>

        {/* Overall progress */}
        <div className="px-3 py-2">
          <div className="flex items-center justify-between text-xs text-muted-foreground mb-1">
            <span>{pct}%</span>
            <span>{formatBytes(state.uploadedBytes)} / {formatBytes(state.totalBytes)}</span>
          </div>
          <div className="w-full h-2 rounded-full bg-muted overflow-hidden">
            <div
              className="h-full bg-primary rounded-full transition-all duration-300"
              style={{ width: `${pct}%` }}
            />
          </div>
        </div>

        {/* Active uploads + processing */}
        {(uploading.length > 0 || processing.length > 0) && (
          <div className="px-3 pb-2 max-h-40 overflow-y-auto space-y-1">
            {uploading.map((item) => (
              <ItemRow key={item.id} item={item} />
            ))}
            {processing.map((item) => (
              <ItemRow key={item.id} item={item} />
            ))}
          </div>
        )}

        {/* Completed message */}
        {allTerminal && state.items.length > 0 && (
          <div className="px-3 pb-2">
            <div className="flex items-center gap-1.5 text-sm">
              {state.errorCount > 0 ? (
                <AlertCircle className="h-4 w-4 text-destructive shrink-0" />
              ) : (
                <CheckCircle2 className="h-4 w-4 text-green-500 shrink-0" />
              )}
              <span>
                {t("fileExplorer:uploadProgress.completed", { completed: state.completedCount })}
                {state.errorCount > 0 && t("fileExplorer:uploadProgress.errorSuffix", { count: state.errorCount })}
                {state.cancelledCount > 0 && t("fileExplorer:uploadProgress.cancelledSuffix", { count: state.cancelledCount })}
              </span>
            </div>
          </div>
        )}

        {/* Error details */}
        {errors.length > 0 && (
          <div className="border-t px-3 py-2">
            <button
              className="flex items-center gap-1 text-xs text-destructive hover:underline"
              onClick={() => setShowErrors(!showErrors)}
            >
              <AlertCircle className="h-3 w-3" />
              {t("fileExplorer:uploadProgress.errorCount", { count: errors.length })} {showErrors ? "▲" : "▼"}
            </button>
            {showErrors && (
              <div className="mt-1 space-y-1 max-h-24 overflow-y-auto">
                {errors.map((item) => (
                  <div key={item.id} className="flex items-start gap-1.5 text-xs">
                    <XCircle className="h-3 w-3 text-destructive shrink-0 mt-0.5" />
                    <div className="min-w-0">
                      <span className="font-medium truncate block">{item.filename}</span>
                      <span className="text-muted-foreground">{item.error}</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Footer actions */}
        {state.isRunning && (
          <div className="border-t px-3 py-2 flex justify-end">
            <Button variant="outline" size="sm" onClick={() => setConfirmAbort(true)}>
              {t("fileExplorer:uploadProgress.cancelAll")}
            </Button>
          </div>
        )}
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Item row sub-component
// ---------------------------------------------------------------------------

function ItemRow({ item }: { item: QueueItem }) {
  const isUploading = item.status === "uploading";
  const isProcessing = item.status === "processing";

  return (
    <div className="flex items-center gap-2 text-xs">
      {isUploading && <Loader2 className="h-3 w-3 animate-spin text-primary shrink-0" />}
      {isProcessing && <Loader2 className="h-3 w-3 animate-spin text-muted-foreground shrink-0" />}
      <span className="truncate flex-1 min-w-0">{item.filename}</span>
      <span className="text-muted-foreground shrink-0">
        {isUploading && `${item.progress}%`}
        {isProcessing && (item.processingLabel || t("fileExplorer:processingLabel"))}
      </span>
    </div>
  );
}
