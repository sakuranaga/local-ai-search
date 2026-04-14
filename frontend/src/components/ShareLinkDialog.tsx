import { useState } from "react";
import { toast } from "sonner";
import { t } from "@/i18n";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Copy, Check, Link } from "lucide-react";
import { createShareLink, type ShareLinkInfo } from "@/lib/api";

export function ShareLinkDialog({
  open,
  documentId,
  documentTitle,
  onClose,
}: {
  open: boolean;
  documentId: string;
  documentTitle: string;
  onClose: () => void;
}) {
  const [expiresIn, setExpiresIn] = useState("7d");
  const [usePassword, setUsePassword] = useState(false);
  const [password, setPassword] = useState("");
  const [saving, setSaving] = useState(false);
  const [created, setCreated] = useState<ShareLinkInfo | null>(null);
  const [copied, setCopied] = useState(false);

  function reset() {
    setExpiresIn("7d");
    setUsePassword(false);
    setPassword("");
    setCreated(null);
    setCopied(false);
  }

  async function handleCreate() {
    setSaving(true);
    try {
      const link = await createShareLink({
        document_id: documentId,
        password: usePassword && password ? password : null,
        expires_in: expiresIn,
      });
      setCreated(link);
    } catch (e: any) {
      toast.error(e.message || t("fileExplorer:shareLink.createFailed"));
    } finally {
      setSaving(false);
    }
  }

  function handleCopy() {
    if (created) {
      navigator.clipboard.writeText(created.url);
      setCopied(true);
      toast.success(t("fileExplorer:shareLink.copied"));
      setTimeout(() => setCopied(false), 2000);
    }
  }

  return (
    <Dialog open={open} onOpenChange={() => { reset(); onClose(); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Link className="h-4 w-4" />
            {created ? t("fileExplorer:shareLink.created") : t("fileExplorer:shareLink.title")}
          </DialogTitle>
        </DialogHeader>

        {created ? (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">{documentTitle}</p>
            <div className="flex gap-2">
              <Input value={created.url} readOnly className="text-xs" />
              <Button variant="outline" size="sm" onClick={handleCopy} className="shrink-0">
                {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
              </Button>
            </div>
            <div className="text-xs text-muted-foreground space-y-1">
              <p>{t("fileExplorer:shareLink.expiry")} {new Date(created.expires_at).toLocaleDateString("ja-JP")}</p>
              {created.has_password && <p>{t("fileExplorer:shareLink.hasPassword")}</p>}
            </div>
            <DialogFooter>
              <Button onClick={() => { reset(); onClose(); }}>{t("common:close")}</Button>
            </DialogFooter>
          </div>
        ) : (
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">{documentTitle}</p>

            <div>
              <label className="text-sm font-medium">{t("fileExplorer:shareLink.expiryLabel")}</label>
              <select
                value={expiresIn}
                onChange={(e) => setExpiresIn(e.target.value)}
                className="w-full h-9 rounded-md border bg-background px-3 text-sm mt-1"
              >
                <option value="1h">{t("fileExplorer:shareLink.hour1")}</option>
                <option value="1d">{t("fileExplorer:shareLink.day1")}</option>
                <option value="7d">{t("fileExplorer:shareLink.days7")}</option>
                <option value="30d">{t("fileExplorer:shareLink.days30")}</option>
              </select>
            </div>

            <div>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={usePassword} onChange={(e) => setUsePassword(e.target.checked)} />
                {t("fileExplorer:shareLink.passwordProtection")}
              </label>
              {usePassword && (
                <Input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder={t("fileExplorer:shareLink.passwordPlaceholder")}
                  className="mt-2"
                />
              )}
            </div>

            <DialogFooter showCloseButton>
              <Button onClick={handleCreate} disabled={saving}>
                {saving ? t("common:creating") : t("fileExplorer:shareLink.createButton")}
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
