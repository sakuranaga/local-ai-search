import { useEffect, useState, useCallback } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ChevronLeft, ChevronRight, Download } from "lucide-react";
import { getDocument, getToken, type Document, type SearchResult } from "@/lib/api";
import { toast } from "sonner";
import { DocumentPreview } from "@/components/DocumentPreview";

interface DocumentModalProps {
  results: SearchResult[];
  currentIndex: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onNavigate: (index: number) => void;
}

export function DocumentModal({
  results,
  currentIndex,
  open,
  onOpenChange,
  onNavigate,
}: DocumentModalProps) {
  const [doc, setDoc] = useState<Document | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [tab, setTab] = useState<"preview" | "raw">("preview");

  const current = results[currentIndex];
  const hasPrev = currentIndex > 0;
  const hasNext = currentIndex < results.length - 1;

  useEffect(() => {
    if (!open || !current) return;
    setLoading(true);
    setError("");
    setDoc(null);
    setTab("preview");
    getDocument(current.document_id)
      .then(setDoc)
      .catch(() => setError("文書の取得に失敗しました"))
      .finally(() => setLoading(false));
  }, [open, current?.document_id]);

  const goPrev = useCallback(() => {
    if (hasPrev) onNavigate(currentIndex - 1);
  }, [hasPrev, currentIndex, onNavigate]);

  const goNext = useCallback(() => {
    if (hasNext) onNavigate(currentIndex + 1);
  }, [hasNext, currentIndex, onNavigate]);

  useEffect(() => {
    if (!open) return;
    function handleKey(e: KeyboardEvent) {
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        goPrev();
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        goNext();
      }
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [open, goPrev, goNext]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-6xl w-[95vw] h-[85vh] flex flex-col">
        <DialogHeader>
          <div className="flex items-center justify-between gap-2 pr-8">
            <DialogTitle className="text-base leading-snug line-clamp-2">
              {current?.document_title ?? "文書"}
            </DialogTitle>
            <div className="flex items-center gap-1 shrink-0">
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                disabled={!hasPrev}
                onClick={goPrev}
              >
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <span className="text-xs text-muted-foreground min-w-[3rem] text-center">
                {currentIndex + 1} / {results.length}
              </span>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                disabled={!hasNext}
                onClick={goNext}
              >
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
          </div>
          <DialogDescription className="sr-only">文書詳細</DialogDescription>
        </DialogHeader>

        {/* Metadata bar */}
        <div className="flex items-center gap-2 w-full">
          {doc && (
            <div className="flex gap-2 text-xs text-muted-foreground items-center w-full">
              <Badge variant="outline" className="text-xs font-normal">
                {doc.file_type}
              </Badge>
              {doc.source_path && <span>{doc.source_path}</span>}
              <span>チャンク: {doc.chunk_count}</span>
              <span>
                更新:{new Date(doc.updated_at).toLocaleString("ja-JP", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })}
              </span>
              <span className="flex-1" />
              {doc.source_path && (
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 px-2"
                  onClick={async () => {
                    try {
                      const API_BASE = import.meta.env.VITE_API_BASE ?? "/api";
                      const token = getToken();
                      const res = await fetch(`${API_BASE}/documents/${doc.id}/download`, {
                        headers: token ? { Authorization: `Bearer ${token}` } : {},
                      });
                      if (!res.ok) throw new Error("Download failed");
                      const blob = await res.blob();
                      const cd = res.headers.get("Content-Disposition") || "";
                      const match = cd.match(/filename\*?=(?:UTF-8''|"?)([^";]+)/i);
                      const filename = match ? decodeURIComponent(match[1]) : doc.title;
                      const url = URL.createObjectURL(blob);
                      const a = document.createElement("a");
                      a.href = url;
                      a.download = filename;
                      a.click();
                      URL.revokeObjectURL(url);
                    } catch {
                      toast.error("ダウンロード失敗");
                    }
                  }}
                >
                  <Download className="h-3.5 w-3.5 mr-1" />
                  ダウンロード
                </Button>
              )}
            </div>
          )}
        </div>

        {/* Top-level tabs */}
        <div className="flex gap-1 border-b">
          {(["preview", "raw"] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`px-3 py-1.5 text-sm border-b-2 transition-colors ${
                tab === t ? "border-primary text-primary font-medium" : "border-transparent text-muted-foreground hover:text-foreground"
              }`}
            >
              {{ preview: "プレビュー", raw: "Raw テキスト" }[t]}
            </button>
          ))}
        </div>

        {/* Content */}
        <div className="flex-1 min-h-0 overflow-y-auto">
          {loading && (
            <p className="text-muted-foreground text-sm p-4">読み込み中...</p>
          )}
          {error && <p className="text-destructive text-sm p-4">{error}</p>}
          {doc && (
            <DocumentPreview
              docId={doc.id}
              fileType={doc.file_type}
              content={doc.content}
              mode={tab}
            />
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
