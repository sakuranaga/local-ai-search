import { useEffect, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { getDocument, type Document } from "@/lib/api";
import { ArrowLeft } from "lucide-react";

export function DocumentPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [doc, setDoc] = useState<Document | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!id) return;
    getDocument(Number(id))
      .then(setDoc)
      .catch(() => setError("文書の取得に失敗しました"));
  }, [id]);

  if (error) {
    return (
      <div className="max-w-3xl mx-auto p-4">
        <Button variant="ghost" onClick={() => navigate(-1)}>
          <ArrowLeft className="h-4 w-4 mr-2" /> 戻る
        </Button>
        <p className="text-destructive mt-4">{error}</p>
      </div>
    );
  }

  if (!doc) {
    return (
      <div className="max-w-3xl mx-auto p-4">
        <p className="text-muted-foreground">読み込み中...</p>
      </div>
    );
  }

  return (
    <div className="max-w-3xl mx-auto p-4">
      <Button variant="ghost" onClick={() => navigate(-1)} className="mb-4">
        <ArrowLeft className="h-4 w-4 mr-2" /> 戻る
      </Button>
      <Card>
        <CardHeader>
          <div className="flex items-start justify-between gap-2">
            <CardTitle className="text-lg">{doc.title}</CardTitle>
            <Badge variant="outline">{doc.file_type}</Badge>
          </div>
          <div className="flex gap-3 text-xs text-muted-foreground">
            <span>ソース: {doc.source}</span>
            <span>更新: {new Date(doc.updated_at).toLocaleDateString("ja-JP")}</span>
          </div>
        </CardHeader>
        <Separator />
        <CardContent className="pt-4">
          <div className="prose prose-sm dark:prose-invert max-w-none whitespace-pre-wrap">
            {doc.content}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
