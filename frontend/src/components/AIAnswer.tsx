import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Sparkles } from "lucide-react";
import { useNavigate } from "react-router-dom";

interface Source {
  document_id: number;
  title: string;
}

interface AIAnswerProps {
  text: string;
  sources: Source[];
  isLoading: boolean;
  hasQuery: boolean;
}

function LoadingDots() {
  return (
    <span className="inline-flex gap-1 items-center">
      <span className="h-1.5 w-1.5 rounded-full bg-primary animate-bounce [animation-delay:0ms]" />
      <span className="h-1.5 w-1.5 rounded-full bg-primary animate-bounce [animation-delay:150ms]" />
      <span className="h-1.5 w-1.5 rounded-full bg-primary animate-bounce [animation-delay:300ms]" />
    </span>
  );
}

export function AIAnswer({ text, sources, isLoading, hasQuery }: AIAnswerProps) {
  const navigate = useNavigate();

  if (!hasQuery) {
    return (
      <Card className="h-full border-dashed">
        <CardContent className="flex flex-col items-center justify-center h-full min-h-48 text-muted-foreground gap-2">
          <Sparkles className="h-8 w-8" />
          <p className="text-sm">検索するとAIが要約を生成します</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="h-full">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-medium flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-primary" />
          AI 回答
        </CardTitle>
      </CardHeader>
      <CardContent className="pt-0">
        <div className="prose prose-sm dark:prose-invert max-w-none">
          {text ? (
            <p className="whitespace-pre-wrap leading-relaxed text-sm">
              {text}
              {isLoading && <LoadingDots />}
            </p>
          ) : isLoading ? (
            <div className="flex items-center gap-2 text-muted-foreground text-sm">
              回答を生成中 <LoadingDots />
            </div>
          ) : null}
        </div>

        {sources.length > 0 && (
          <div className="mt-4 pt-3 border-t">
            <p className="text-xs text-muted-foreground mb-2">参照元:</p>
            <div className="flex flex-wrap gap-1.5">
              {sources.map((s) => (
                <Badge
                  key={s.document_id}
                  variant="secondary"
                  className="cursor-pointer hover:bg-accent text-xs"
                  onClick={() => navigate(`/documents/${s.document_id}`)}
                >
                  {s.title}
                </Badge>
              ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
