import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { FileText, Download, Lock, AlertCircle, Sparkles } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  getSharePublic,
  verifySharePassword,
  getSharePreview,
  getShareDownloadUrl,
  type SharePublicInfo,
} from "@/lib/api";

export function SharePage() {
  const { token } = useParams<{ token: string }>();
  const [info, setInfo] = useState<SharePublicInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // Password
  const [password, setPassword] = useState("");
  const [shareToken, setShareToken] = useState<string | null>(null);
  const [passwordError, setPasswordError] = useState("");

  // Preview
  const [preview, setPreview] = useState<{ title: string; content: string; file_type: string } | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  useEffect(() => {
    if (!token) return;
    setLoading(true);
    getSharePublic(token)
      .then(setInfo)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [token]);

  useEffect(() => {
    if (!token || !info) return;
    if (info.requires_password && !shareToken) return;
    setPreviewLoading(true);
    getSharePreview(token, shareToken || undefined)
      .then(setPreview)
      .catch(() => {})
      .finally(() => setPreviewLoading(false));
  }, [token, info, shareToken]);

  async function handlePasswordSubmit() {
    if (!token) return;
    setPasswordError("");
    try {
      const result = await verifySharePassword(token, password);
      setShareToken(result.share_token);
    } catch (e: any) {
      setPasswordError(e.message || "パスワードが正しくありません");
    }
  }

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <p className="text-muted-foreground">読み込み中...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <Card className="max-w-md w-full mx-4">
          <CardContent className="flex flex-col items-center gap-3 py-12">
            <AlertCircle className="h-12 w-12 text-destructive" />
            <p className="text-lg font-medium">{error}</p>
          </CardContent>
        </Card>
        <Footer />
      </div>
    );
  }

  if (!info || !token) return null;

  // Password required but not yet verified
  if (info.requires_password && !shareToken) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <Card className="max-w-sm w-full mx-4">
          <CardContent className="flex flex-col items-center gap-4 py-12">
            <Lock className="h-12 w-12 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">この共有リンクはパスワードで保護されています</p>
            <div className="flex gap-2 w-full">
              <Input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") handlePasswordSubmit(); }}
                placeholder="パスワード"
                autoFocus
              />
              <Button onClick={handlePasswordSubmit} disabled={!password}>開く</Button>
            </div>
            {passwordError && <p className="text-xs text-destructive">{passwordError}</p>}
          </CardContent>
        </Card>
        <Footer />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-4xl mx-auto px-4 py-8">
        {/* Header */}
        <div className="flex items-center gap-3 mb-6">
          <FileText className="h-8 w-8 text-primary" />
          <div>
            <h1 className="text-xl font-bold">{info.document_title}</h1>
            <p className="text-sm text-muted-foreground">
              共有者: {info.created_by_name}
              {info.expires_at && (
                <span className="ml-2">
                  有効期限: {new Date(info.expires_at).toLocaleDateString("ja-JP")}
                </span>
              )}
            </p>
          </div>
          <Badge variant="outline" className="ml-auto">{info.file_type.toUpperCase()}</Badge>
        </div>

        {/* Preview */}
        <Card className="mb-6">
          <CardContent className="py-6">
            {previewLoading ? (
              <p className="text-sm text-muted-foreground text-center py-8">読み込み中...</p>
            ) : preview ? (
              <div className="prose prose-sm dark:prose-invert max-w-none max-h-[60vh] overflow-y-auto">
                {preview.file_type === "md" ? (
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{preview.content}</ReactMarkdown>
                ) : (
                  <pre className="whitespace-pre-wrap text-sm">{preview.content}</pre>
                )}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground text-center py-8">プレビューは利用できません</p>
            )}
          </CardContent>
        </Card>

        {/* Download button */}
        {info.permission === "download" && (
          <div className="flex justify-center">
            <Button
              size="lg"
              onClick={() => {
                const url = getShareDownloadUrl(token, shareToken || undefined);
                const a = document.createElement("a");
                a.href = url;
                a.download = info.document_title;
                a.click();
              }}
            >
              <Download className="h-5 w-5 mr-2" />ダウンロード
            </Button>
          </div>
        )}

        <Footer />
      </div>
    </div>
  );
}

function Footer() {
  return (
    <div className="text-center text-xs text-muted-foreground mt-12 pb-4">
      <span className="flex items-center justify-center gap-1">
        <Sparkles className="h-3 w-3" />
        Powered by LAS
      </span>
    </div>
  );
}
