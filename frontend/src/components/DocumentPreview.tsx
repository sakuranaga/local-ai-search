import { getToken } from "@/lib/api";
import { Download, FileIcon } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import { Button } from "@/components/ui/button";
import "@videojs/react/video/skin.css";
import { createPlayer, videoFeatures } from "@videojs/react";
import { VideoSkin, Video } from "@videojs/react/video";

const Player = createPlayer({ features: videoFeatures });

const API_BASE = import.meta.env.VITE_API_BASE ?? "/api";

/** File types that can be previewed natively in the browser. */
const PDF_TYPES = new Set(["pdf"]);
const IMAGE_TYPES = new Set(["png", "jpg", "jpeg", "gif", "bmp", "tiff", "tif", "webp"]);
/** File types rendered as HTML via the /preview endpoint. */
const OFFICE_TYPES = new Set(["xlsx", "xls", "csv", "tsv", "pptx", "docx", "doc"]);
/** Tier 1: text-extractable types (have content via processing pipeline). */
const TEXT_EXTRACTABLE = new Set([
  "md", "pdf", "docx", "xlsx", "csv", "html", "pptx",
  "png", "jpg", "gif", "bmp", "tiff", "webp",
]);
/** Tier 2: browser-native preview via <audio> / <video>. */
const AUDIO_TYPES = new Set(["mp3", "wav", "ogg", "m4a", "flac", "aac"]);
const VIDEO_TYPES = new Set([
  "mp4", "m4v", "webm", "ogv", "ogg", "mov",
  "avi", "wmv", "flv", "mkv", "ts", "m2ts", "mts",
  "3gp", "3g2", "f4v", "asf", "vob", "mpg", "mpeg",
]);
const SVG_TYPES = new Set(["svg"]);

export function isPreviewable(fileType: string): boolean {
  const ft = fileType.toLowerCase();
  return (
    PDF_TYPES.has(ft) ||
    IMAGE_TYPES.has(ft) ||
    OFFICE_TYPES.has(ft) ||
    AUDIO_TYPES.has(ft) ||
    VIDEO_TYPES.has(ft) ||
    SVG_TYPES.has(ft)
  );
}

/** Returns true if the file type has text content from the processing pipeline or is markdown. */
export function hasExtractedContent(fileType: string): boolean {
  return TEXT_EXTRACTABLE.has(fileType.toLowerCase());
}

export function isVideoType(fileType: string): boolean {
  return VIDEO_TYPES.has(fileType.toLowerCase());
}

function downloadUrl(docId: string): string {
  const token = getToken();
  const params = new URLSearchParams({ inline: "true" });
  if (token) params.set("token", token);
  return `${API_BASE}/documents/${docId}/download?${params}`;
}

function htmlPreviewUrl(docId: string): string {
  const token = getToken();
  const params = new URLSearchParams();
  if (token) params.set("token", token);
  return `${API_BASE}/documents/${docId}/preview?${params}`;
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
        src={downloadUrl(docId)}
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
          src={downloadUrl(docId)}
          alt="Preview"
          className="max-w-full max-h-[65vh] object-contain rounded"
        />
      </div>
    );
  }

  // HTML preview for office documents (Excel, PowerPoint, CSV, DOCX)
  if (OFFICE_TYPES.has(ft)) {
    return (
      <iframe
        src={htmlPreviewUrl(docId)}
        className="w-full h-full min-h-[60vh] rounded border bg-white"
        title="Document preview"
      />
    );
  }

  // Tier 2: Audio preview
  if (AUDIO_TYPES.has(ft)) {
    return (
      <div className="flex flex-col items-center justify-center py-12 gap-4">
        <audio src={downloadUrl(docId)} controls className="w-full max-w-md" />
      </div>
    );
  }

  // Tier 2: Video preview (video.js v10)
  if (VIDEO_TYPES.has(ft)) {
    return (
      <div className="w-full rounded overflow-hidden" style={{ aspectRatio: "16/9" }}>
        <Player.Provider>
          <VideoSkin className="rounded">
            <Video src={downloadUrl(docId)} playsInline />
          </VideoSkin>
        </Player.Provider>
      </div>
    );
  }

  // Tier 2: SVG preview
  if (SVG_TYPES.has(ft)) {
    return (
      <div className="flex items-center justify-center p-4">
        <img
          src={downloadUrl(docId)}
          alt="SVG Preview"
          className="max-w-full max-h-[65vh] object-contain rounded"
        />
      </div>
    );
  }

  // Tier 1 with content: Markdown render
  if (content) {
    return (
      <div className="prose prose-sm dark:prose-invert max-w-none prose-p:my-2 prose-ul:my-2 prose-ol:my-2 prose-li:my-0.5 prose-headings:my-3 prose-pre:my-2 prose-pre:overflow-x-auto prose-code:text-xs p-1">
        <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]}>{content}</ReactMarkdown>
      </div>
    );
  }

  // Tier 3: No preview available
  return (
    <div className="flex flex-col items-center justify-center py-12 text-muted-foreground gap-3">
      <FileIcon className="h-16 w-16" />
      <p className="text-sm">このファイルのプレビューは利用できません</p>
      <p className="text-xs">{ft.toUpperCase()} ファイル</p>
      <a href={downloadUrl(docId)} download>
        <Button variant="outline">
          <Download className="h-4 w-4 mr-2" />ダウンロード
        </Button>
      </a>
    </div>
  );
}
