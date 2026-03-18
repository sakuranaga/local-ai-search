import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from "@/components/ui/dialog";
import { Separator } from "@/components/ui/separator";
import { Upload } from "lucide-react";
import {
  bulkAction,
  getGroups,
  type Folder,
  type TagInfo,
  type Group,
  type DocumentListItem,
} from "@/lib/api";
import { formatBytes, formatPermString } from "@/lib/fileExplorerHelpers";

// ---------------------------------------------------------------------------
// Bulk Permissions Dialog
// ---------------------------------------------------------------------------

export function BulkPermissionsDialog({
  open,
  selectedIds,
  onClose,
  onDone,
}: {
  open: boolean;
  selectedIds: string[];
  onClose: () => void;
  onDone: () => void;
}) {
  const [groups, setGroups] = useState<Group[]>([]);
  const [groupId, setGroupId] = useState("");
  const [groupRead, setGroupRead] = useState(false);
  const [groupWrite, setGroupWrite] = useState(false);
  const [othersRead, setOthersRead] = useState(true);
  const [othersWrite, setOthersWrite] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) getGroups().then(setGroups).catch(() => {});
  }, [open]);

  async function handleSave() {
    setSaving(true);
    try {
      const res = await bulkAction(selectedIds, "set_permissions", {
        group_id: groupId || null,
        group_read: groupRead,
        group_write: groupWrite,
        others_read: othersRead,
        others_write: othersWrite,
      });
      toast.success(`${res.processed}件に権限を設定しました`);
      onDone();
    } catch { toast.error("保存失敗"); }
    finally { setSaving(false); }
  }

  return (
    <Dialog open={open} onOpenChange={() => onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>一括権限変更</DialogTitle>
          <DialogDescription>{selectedIds.length}件の文書に同じ権限を設定します。</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div>
            <label className="text-sm font-medium">グループ</label>
            <select
              value={groupId}
              onChange={(e) => setGroupId(e.target.value)}
              className="w-full h-9 rounded-md border bg-background px-3 text-sm mt-1"
            >
              <option value="">なし</option>
              {groups.map((g) => (
                <option key={g.id} value={g.id}>{g.name}</option>
              ))}
            </select>
            <div className="flex gap-4 mt-2">
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={groupRead} onChange={(e) => setGroupRead(e.target.checked)} />
                読み取り
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={groupWrite} onChange={(e) => setGroupWrite(e.target.checked)} />
                書き込み
              </label>
            </div>
          </div>
          <Separator />
          <div>
            <label className="text-sm font-medium">全員（others）</label>
            <div className="flex gap-4 mt-2">
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={othersRead} onChange={(e) => setOthersRead(e.target.checked)} />
                読み取り
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={othersWrite} onChange={(e) => setOthersWrite(e.target.checked)} />
                書き込み
              </label>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium">パーミッション:</span>
            <code className="text-sm font-mono bg-muted px-2 py-0.5 rounded">
              {formatPermString(groupRead, groupWrite, othersRead, othersWrite)}
            </code>
          </div>
        </div>
        <DialogFooter showCloseButton>
          <Button onClick={handleSave} disabled={saving}>適用</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Bulk Folder Move Dialog
// ---------------------------------------------------------------------------

export function BulkFolderDialog({
  open,
  folders,
  selectedIds,
  items,
  onClose,
  onMove,
}: {
  open: boolean;
  folders: Folder[];
  selectedIds: string[];
  items: DocumentListItem[];
  onClose: () => void;
  onMove: (folderId: string | null) => void;
}) {
  const initialFolder = useMemo(() => {
    const selectedItems = items.filter((i) => selectedIds.includes(i.id));
    if (selectedItems.length === 0) return "";
    const first = selectedItems[0].folder_id ?? "";
    return selectedItems.every((i) => (i.folder_id ?? "") === first) ? first : "";
  }, [items, selectedIds]);
  const [targetFolder, setTargetFolder] = useState("");

  useEffect(() => {
    if (open) setTargetFolder(initialFolder);
  }, [open, initialFolder]);

  return (
    <Dialog open={open} onOpenChange={() => onClose()}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>一括フォルダ移動</DialogTitle>
          <DialogDescription>{selectedIds.length}件の文書を移動します。</DialogDescription>
        </DialogHeader>
        <select
          value={targetFolder}
          onChange={(e) => setTargetFolder(e.target.value)}
          className="w-full h-9 rounded-md border bg-background px-3 text-sm"
        >
          <option value="">未整理（フォルダなし）</option>
          {folders.map((f) => (
            <option key={f.id} value={f.id}>{f.name}</option>
          ))}
        </select>
        <DialogFooter showCloseButton>
          <Button onClick={() => onMove(targetFolder || null)}>移動する</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Bulk Tag Dialog
// ---------------------------------------------------------------------------

export function BulkTagDialog({
  open,
  allTags,
  selectedIds,
  items,
  onClose,
  onDone,
}: {
  open: boolean;
  allTags: TagInfo[];
  selectedIds: string[];
  items: DocumentListItem[];
  onClose: () => void;
  onDone: () => void;
}) {
  const [selectedTags, setSelectedTags] = useState<Set<number>>(new Set());
  const [initialTags, setInitialTags] = useState<Set<number>>(new Set());
  const [saving, setSaving] = useState(false);

  // When dialog opens, compute common tags across all selected documents
  useEffect(() => {
    if (!open) return;
    const selectedItems = items.filter((i) => selectedIds.includes(i.id));
    if (selectedItems.length === 0) {
      setSelectedTags(new Set());
      setInitialTags(new Set());
      return;
    }
    // Tags that ALL selected documents have
    const first = new Set(selectedItems[0].tags?.map((t) => t.id) ?? []);
    for (const item of selectedItems.slice(1)) {
      const itemTagIds = new Set(item.tags?.map((t) => t.id) ?? []);
      for (const id of first) {
        if (!itemTagIds.has(id)) first.delete(id);
      }
    }
    setSelectedTags(new Set(first));
    setInitialTags(new Set(first));
  }, [open, selectedIds]);

  function toggleTag(id: number) {
    setSelectedTags((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  const hasChanges = (() => {
    if (selectedTags.size !== initialTags.size) return true;
    for (const id of selectedTags) if (!initialTags.has(id)) return true;
    return false;
  })();

  async function handleSave() {
    setSaving(true);
    try {
      const res = await bulkAction(selectedIds, "set_tags", { tag_ids: [...selectedTags] });
      toast.success(`${res.processed}件のタグを更新しました`);
      onDone();
    } catch { toast.error("タグ更新失敗"); }
    finally { setSaving(false); }
  }

  return (
    <Dialog open={open} onOpenChange={() => onClose()}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>タグ編集</DialogTitle>
          <DialogDescription>{selectedIds.length}件の文書のタグを設定します。</DialogDescription>
        </DialogHeader>
        <div className="flex flex-wrap gap-2">
          {allTags.map((t) => (
            <button
              key={t.id}
              onClick={() => toggleTag(t.id)}
              className={`inline-flex items-center gap-1 text-sm px-2.5 py-1 rounded-full border transition-colors ${
                selectedTags.has(t.id) ? "border-primary bg-primary/10" : "border-muted hover:border-foreground/30"
              }`}
            >
              <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: t.color || "#6b7280" }} />
              {t.name}
            </button>
          ))}
          {allTags.length === 0 && <p className="text-sm text-muted-foreground">タグがありません</p>}
        </div>
        <DialogFooter showCloseButton>
          <Button onClick={handleSave} disabled={saving || !hasChanges}>保存</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Upload Dialog
// ---------------------------------------------------------------------------

export function UploadDialog({
  open,
  onClose,
  onSubmit,
}: {
  open: boolean;
  onClose: () => void;
  onSubmit: (files: globalThis.File[]) => void;
}) {
  const [files, setFiles] = useState<globalThis.File[]>([]);

  function handleUpload() {
    if (files.length === 0) return;
    onSubmit(files);
    setFiles([]);
  }

  return (
    <Dialog open={open} onOpenChange={() => { onClose(); setFiles([]); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>ファイルアップロード</DialogTitle>
          <DialogDescription>すべてのファイル形式に対応しています</DialogDescription>
        </DialogHeader>
        <Input type="file" multiple onChange={(e) => setFiles(Array.from(e.target.files ?? []))} />
        {files.length > 0 && (
          <div className="text-sm text-muted-foreground space-y-0.5">
            {files.map((f, i) => (
              <p key={i}>{f.name} ({formatBytes(f.size)})</p>
            ))}
          </div>
        )}
        <DialogFooter showCloseButton>
          <Button onClick={handleUpload} disabled={files.length === 0}>
            <Upload className="h-4 w-4 mr-2" />アップロード{files.length > 1 ? ` (${files.length}件)` : ""}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
