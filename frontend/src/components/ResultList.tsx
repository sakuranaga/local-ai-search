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

function scoreColor(score: number): string {
  if (score >= 0.8) return "default";
  if (score >= 0.5) return "secondary";
  return "outline";
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
      <div className="space-y-3 pr-3">
        {results.map((result) => (
          <Card
            key={result.document_id}
            className="cursor-pointer hover:bg-accent/50 transition-colors"
            onClick={() => onSelect(result)}
          >
            <CardContent className="p-4">
              <div className="flex items-start justify-between gap-2 mb-1">
                <h3 className="font-semibold text-sm leading-tight line-clamp-1">
                  {result.title}
                </h3>
                <div className="flex gap-1.5 shrink-0">
                  <Badge variant={scoreColor(result.score) as "default" | "secondary" | "outline"}>
                    {(result.score * 100).toFixed(0)}%
                  </Badge>
                  <Badge variant="outline" className="gap-1">
                    {fileTypeIcon(result.file_type)}
                    {result.file_type}
                  </Badge>
                </div>
              </div>
              <p
                className="text-sm text-muted-foreground line-clamp-2 mt-1"
                dangerouslySetInnerHTML={{ __html: result.snippet }}
              />
              <p className="text-xs text-muted-foreground/60 mt-2 truncate">
                {result.source}
              </p>
            </CardContent>
          </Card>
        ))}
      </div>
    </ScrollArea>
  );
}
