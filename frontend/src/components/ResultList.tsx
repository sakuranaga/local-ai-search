import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import type { SearchResult } from "@/lib/api";
import { FileText, Globe, File } from "lucide-react";

interface ResultListProps {
  results: SearchResult[];
  onSelect: (result: SearchResult) => void;
}

function fileTypeIcon(fileType: string) {
  switch (fileType) {
    case "html":
    case "url":
      return <Globe className="h-4 w-4" />;
    case "pdf":
    case "doc":
    case "docx":
      return <FileText className="h-4 w-4" />;
    default:
      return <File className="h-4 w-4" />;
  }
}

function truncateContent(content: string, maxLen = 150): string {
  if (content.length <= maxLen) return content;
  return content.slice(0, maxLen) + "...";
}

export function ResultList({ results, onSelect }: ResultListProps) {
  if (results.length === 0) {
    return (
      <div className="flex items-center justify-center h-48 text-muted-foreground">
        検索結果がありません
      </div>
    );
  }

  return (
    <ScrollArea className="h-[calc(100vh-280px)]">
      <div className="space-y-3 px-3">
        {results.map((result, idx) => (
          <Card
            key={result.chunk_id ?? idx}
            className="cursor-pointer hover:bg-accent/50 transition-colors !py-0 !gap-0"
            onClick={() => onSelect(result)}
          >
            <CardContent className="p-4">
              <div className="flex items-start justify-between gap-2 mb-1">
                <h3 className="font-semibold text-sm leading-tight line-clamp-1">
                  {result.document_title}
                </h3>
                <div className="flex gap-1.5 shrink-0">
                  {result.distance != null && (
                    <Badge variant="secondary">
                      関連度 {Math.round((1 - result.distance) * 100)}%
                    </Badge>
                  )}
                  <Badge variant="outline" className="gap-1">
                    {fileTypeIcon(result.file_type)}
                    {result.file_type}
                  </Badge>
                </div>
              </div>
              <p className="text-sm text-muted-foreground line-clamp-3 mt-1">
                {result.document_summary || truncateContent(result.content)}
              </p>
            </CardContent>
          </Card>
        ))}
      </div>
    </ScrollArea>
  );
}
