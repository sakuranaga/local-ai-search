import { useState, useEffect } from "react";
import { toast } from "sonner";
import { t } from "@/i18n";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { OverTypeEditor } from "@/components/OverTypeEditor";
import { createTextDocument, type Folder } from "@/lib/api";

export function CreateTextDocumentDialog({
  open,
  onClose,
  folders,
  currentFolderId,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  folders: Folder[];
  currentFolderId?: string | null;
  onCreated: () => void;
}) {
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [folderId, setFolderId] = useState("");
  const [saving, setSaving] = useState(false);

  // Reset form when dialog opens
  useEffect(() => {
    if (open) {
      setFolderId(currentFolderId ?? "");
      setTitle("");
      setContent("");
    }
  }, [open, currentFolderId]);

  async function handleSave() {
    const trimmedTitle = title.trim();
    if (!trimmedTitle) {
      toast.error(t("fileExplorer:createText.titleRequired"));
      return;
    }
    if (!content.trim()) {
      toast.error(t("fileExplorer:createText.contentRequired"));
      return;
    }
    setSaving(true);
    try {
      await createTextDocument({
        title: trimmedTitle,
        content,
        folder_id: folderId || null,
      });
      toast.success(t("fileExplorer:createText.created"));
      setTitle("");
      setContent("");
      onCreated();
    } catch (e: any) {
      toast.error(e.message || t("common:createFailed"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className="sm:max-w-4xl w-[95vw] h-[85vh] !max-w-none !w-screen !h-[100dvh] !max-h-[100dvh] !rounded-none !top-0 !left-0 !translate-x-0 !translate-y-0 md:!max-w-4xl md:!w-[95vw] md:!h-[85vh] md:!max-h-[85vh] md:!rounded-lg md:!top-1/2 md:!left-1/2 md:!-translate-x-1/2 md:!-translate-y-1/2 flex flex-col pb-[env(safe-area-inset-bottom)] md:pb-0">
        <DialogHeader>
          <DialogTitle>{t("fileExplorer:createText.title")}</DialogTitle>
          <DialogDescription>{t("fileExplorer:createText.description")}</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col md:flex-row gap-3 shrink-0">
          <div className="flex-1">
            <Input
              placeholder={t("fileExplorer:createText.titleLabel")}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </div>
          <div className="w-full md:w-48">
            <select
              value={folderId}
              onChange={(e) => setFolderId(e.target.value)}
              className="w-full h-9 rounded-md border bg-background px-3 text-sm"
            >
              <option value="">{t("fileExplorer:createText.unfiled")}</option>
              {folders.map((f) => (
                <option key={f.id} value={f.id}>{f.name}</option>
              ))}
            </select>
          </div>
        </div>

        <div className="flex-1 min-h-0 border rounded-md overflow-hidden">
          {open && (
            <OverTypeEditor
              value=""
              onChange={(v) => setContent(v)}
            />
          )}
        </div>

        <div className="flex justify-end gap-2 shrink-0 mb-2">
          <Button variant="outline" onClick={onClose}>{t("common:cancel")}</Button>
          <Button onClick={handleSave} disabled={saving || !title.trim()}>
            {saving ? t("common:creating") : t("common:save")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
