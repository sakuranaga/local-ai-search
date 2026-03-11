import { getToken } from "@/lib/api";
import ReactMarkdown from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";

const API_BASE = import.meta.env.VITE_API_BASE ?? "/api";

/** File types that can be previewed natively in the browser. */
const PDF_TYPES = new Set(["pdf"]);
const IMAGE_TYPES = new Set(["png", "jpg", "jpeg", "gif", "bmp", "tiff", "tif", "webp"]);

export function isPreviewable(fileType: string): boolean {
  const ft = fileType.toLowerCase();
  return PDF_TYPES.has(ft) || IMAGE_TYPES.has(ft);
}

function previewUrl(docId: string): string {
  const token = getToken();
  const params = new URLSearchParams({ inline: "true" });
  if (token) params.set("token", token);
  return `${API_BASE}/documents/${docId}/download?${params}`;
}

interface DocumentPreviewProps {
  docId: string;
  fileType: string;
  content: string;
  /** Which view to show: "preview" (native render) or "raw" (extracted text) */
  mode: "preview" | "raw";
}

export function DocumentPreview({ docId, fileType, content, mode }: DocumentPreviewProps) {
  const ft = fileType.toLowerCase();

  if (mode === "raw") {
    return (
      <pre className="whitespace-pre-wrap text-sm font-mono p-4 bg-muted rounded-md overflow-auto">
        {content || "(テキストなし)"}
      </pre>
    );
  }

  // Native preview for PDF
  if (PDF_TYPES.has(ft)) {
    return (
      <iframe
        src={previewUrl(docId)}
        className="w-full h-full min-h-[60vh] rounded border"
        title="PDF preview"
      />
    );
  }

  // Native preview for images
  if (IMAGE_TYPES.has(ft)) {
    return (
      <div className="flex items-center justify-center p-4">
        <img
          src={previewUrl(docId)}
          alt="Preview"
          className="max-w-full max-h-[65vh] object-contain rounded"
        />
      </div>
    );
  }

  // Default: Markdown render
  return (
    <div className="prose prose-sm dark:prose-invert max-w-none prose-p:my-2 prose-ul:my-2 prose-ol:my-2 prose-li:my-0.5 prose-headings:my-3 prose-pre:my-2 prose-pre:overflow-x-auto prose-code:text-xs p-1">
      <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]}>{content}</ReactMarkdown>
    </div>
  );
}
