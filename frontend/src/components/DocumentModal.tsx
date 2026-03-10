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
import { Separator } from "@/components/ui/separator";
import { ChevronLeft, ChevronRight, Download } from "lucide-react";
import { getDocument, getToken, type Document, type SearchResult } from "@/lib/api";
import { toast } from "sonner";
import ReactMarkdown from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";

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

  const current = results[currentIndex];
  const hasPrev = currentIndex > 0;
  const hasNext = currentIndex < results.length - 1;

  useEffect(() => {
    if (!open || !current) return;
    setLoading(true);
    setError("");
    setDoc(null);
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
            <span className="text-xs text-muted-foreground shrink-0">
              {currentIndex + 1} / {results.length}
            </span>
          </div>
          <DialogDescription className="sr-only">文書詳細</DialogDescription>
        </DialogHeader>

        {/* Navigation buttons */}
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={!hasPrev}
            onClick={goPrev}
          >
            <ChevronLeft className="h-4 w-4 mr-1" />
            前へ
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={!hasNext}
            onClick={goNext}
          >
            次へ
            <ChevronRight className="h-4 w-4 ml-1" />
          </Button>
          {doc && (
            <div className="flex gap-2 ml-auto text-xs text-muted-foreground items-center">
              <Badge variant="outline" className="text-xs font-normal">
                {doc.file_type}
              </Badge>
              {doc.source_path && <span>{doc.source_path}</span>}
              <span>チャンク: {doc.chunk_count}</span>
              <span>
                更新: {new Date(doc.updated_at).toLocaleDateString("ja-JP")}
              </span>
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

        <Separator />

        {/* Content */}
        <div className="flex-1 min-h-0 overflow-y-auto">
          {loading && (
            <p className="text-muted-foreground text-sm p-4">読み込み中...</p>
          )}
          {error && <p className="text-destructive text-sm p-4">{error}</p>}
          {doc && (
            <div className="prose prose-sm dark:prose-invert max-w-none prose-p:my-2 prose-ul:my-2 prose-ol:my-2 prose-li:my-0.5 prose-headings:my-3 prose-pre:my-2 prose-pre:overflow-x-auto prose-code:text-xs p-1">
              <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]}>{doc.content}</ReactMarkdown>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
