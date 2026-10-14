import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { t } from "@/i18n";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from "@/components/ui/dialog";
import { Separator } from "@/components/ui/separator";
import { Upload, FolderUp, Loader2 } from "lucide-react";
import {
  bulkAction,
  getGroups,
  type Folder,
  type TagInfo,
  type Group,
  type DocumentListItem,
} from "@/lib/api";
import { MIXED, currentPermissions, nextBit, permissionChanges, type Mixed, type PermissionChoice } from "@/lib/bulkPermissions";
import {
  formatBytes,
  hasDirectoryEntries,
  traverseDataTransferItems,
  type FileWithPath,
} from "@/lib/fileExplorerHelpers";

// ---------------------------------------------------------------------------
// Bulk Permissions Dialog
// ---------------------------------------------------------------------------

export function BulkPermissionsDialog({
  open,
  selectedIds,
  items,
  onClose,
  onDone,
}: {
  open: boolean;
  selectedIds: string[];
  items: DocumentListItem[];
  onClose: () => void;
  onDone: () => void;
}) {
  const [groups, setGroups] = useState<Group[]>([]);
  // Start from the selected files' own permissions; fields that differ between them stay unchanged
  const [start, setStart] = useState<PermissionChoice>(() => currentPermissions([]));
  const [perm, setPerm] = useState<PermissionChoice>(start);
  const [saving, setSaving] = useState(false);
  const [fileGroups, setFileGroups] = useState<{ id: string; name: string }[]>([]);
  const source = useRef({ items, selectedIds });
  source.current = { items, selectedIds };

  useEffect(() => {
    if (!open) return;
    // Read once on open: the parent passes a new selectedIds array on every render
    const { items: all, selectedIds: ids } = source.current;
    const chosen = all.filter((i) => ids.includes(i.id));
    const p = currentPermissions(chosen);
    setStart(p);
    const seen = new Map<string, string>();
    for (const i of chosen) if (i.group_id) seen.set(i.group_id, i.group_name ?? i.group_id);
    setFileGroups([...seen].map(([id, name]) => ({ id, name })));
    setPerm(p);
    getGroups().then(setGroups).catch(() => {});
  }, [open]);

  async function handleSave() {
    const changes = permissionChanges(start, perm);
    if (!Object.keys(changes).length) { onClose(); return; }
    setSaving(true);
    try {
      const res = await bulkAction(selectedIds, "set_permissions", changes);
      toast.success(t("fileExplorer:bulkPermissions.applied", { count: res.processed }));
      onDone();
    } catch { toast.error(t("common:saveFailed")); }
    finally { setSaving(false); }
  }

  const bit = (v: boolean | Mixed, c: string) => (v === MIXED ? "?" : v ? c : "-");
  const box = (field: "group_read" | "group_write" | "others_read" | "others_write", label: string) => (
    <label className="flex items-center gap-2 text-sm">
      <input
        type="checkbox"
        checked={perm[field] === true}
        ref={(el) => { if (el) el.indeterminate = perm[field] === MIXED; }}
        onChange={() => setPerm({ ...perm, [field]: nextBit(start[field], perm[field]) })}
      />
      {label}
      {perm[field] === MIXED && <span className="text-xs text-muted-foreground">{t("fileExplorer:bulkPermissions.mixed")}</span>}
    </label>
  );

  return (
    <Dialog open={open} onOpenChange={() => onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("fileExplorer:bulkPermissions.title")}</DialogTitle>
          <DialogDescription>{t("fileExplorer:bulkPermissions.description", { count: selectedIds.length })}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div>
            <label className="text-sm font-medium">{t("common:group")}</label>
            <select
              value={perm.group_id}
              onChange={(e) => setPerm({ ...perm, group_id: e.target.value })}
              className="w-full h-9 rounded-md border bg-background px-3 text-sm mt-1"
            >
              {start.group_id === MIXED && <option value={MIXED}>{t("fileExplorer:bulkPermissions.keepGroup")}</option>}
              <option value="">{t("common:none")}</option>
              {/* getGroups lists only the user's own groups for non-admins: keep the files' current ones choosable */}
              {fileGroups.filter((f) => !groups.some((g) => g.id === f.id)).map((f) => (
                <option key={f.id} value={f.id}>{f.name}</option>
              ))}
              {groups.map((g) => (
                <option key={g.id} value={g.id}>{g.name}</option>
              ))}
            </select>
            <div className="flex gap-4 mt-2">
              {box("group_read", t("common:read"))}
              {box("group_write", t("common:write"))}
            </div>
          </div>
          <Separator />
          <div>
            <label className="text-sm font-medium">{t("common:othersLabel")}</label>
            <div className="flex gap-4 mt-2">
              {box("others_read", t("common:read"))}
              {box("others_write", t("common:write"))}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium">{t("common:permissionString")}</span>
            <code className="text-sm font-mono bg-muted px-2 py-0.5 rounded">
              {"rw" + bit(perm.group_read, "r") + bit(perm.group_write, "w") + bit(perm.others_read, "r") + bit(perm.others_write, "w")}
            </code>
          </div>
        </div>
        <DialogFooter showCloseButton>
          <Button onClick={handleSave} disabled={saving}>{t("common:apply")}</Button>
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
          <DialogTitle>{t("fileExplorer:bulkFolder.title")}</DialogTitle>
          <DialogDescription>{t("fileExplorer:bulkFolder.description", { count: selectedIds.length })}</DialogDescription>
        </DialogHeader>
        <select
          value={targetFolder}
          onChange={(e) => setTargetFolder(e.target.value)}
          className="w-full h-9 rounded-md border bg-background px-3 text-sm"
        >
          <option value="">{t("fileExplorer:bulkFolder.unfiled")}</option>
          {folders.map((f) => (
            <option key={f.id} value={f.id}>{f.name}</option>
          ))}
        </select>
        <DialogFooter showCloseButton>
          <Button onClick={() => onMove(targetFolder || null)}>{t("fileExplorer:bulkFolder.move")}</Button>
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
      toast.success(t("fileExplorer:bulkTag.updated", { count: res.processed }));
      onDone();
    } catch { toast.error(t("fileExplorer:tagUpdateFailed")); }
    finally { setSaving(false); }
  }

  return (
    <Dialog open={open} onOpenChange={() => onClose()}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{t("fileExplorer:bulkTag.title")}</DialogTitle>
          <DialogDescription>{t("fileExplorer:bulkTag.description", { count: selectedIds.length })}</DialogDescription>
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
          {allTags.length === 0 && <p className="text-sm text-muted-foreground">{t("fileExplorer:bulkTag.noTags")}</p>}
        </div>
        <DialogFooter showCloseButton>
          <Button onClick={handleSave} disabled={saving || !hasChanges}>{t("common:save")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Upload Dialog
// ---------------------------------------------------------------------------

const MAX_UPLOAD_FILES = 1000;
const MAX_SHOW_FILES = 5;

export function UploadDialog({
  open,
  onClose,
  onSubmit,
}: {
  open: boolean;
  onClose: () => void;
  onSubmit: (items: FileWithPath[]) => void;
}) {
  const [items, setItems] = useState<FileWithPath[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [scanning, setScanning] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const overLimit = items.length > MAX_UPLOAD_FILES;
  const hasFolders = items.some((i) => i.folderPath !== "");
  // Unique top-level folder names for display
  const folderNames = useMemo(() => {
    const set = new Set<string>();
    for (const i of items) {
      if (i.folderPath) set.add(i.folderPath.split("/")[0]);
    }
    return [...set];
  }, [items]);

  const reset = useCallback(() => {
    setItems([]);
    setDragOver(false);
    setScanning(false);
  }, []);

  function handleUpload() {
    if (items.length === 0) return;
    onSubmit(items);
    reset();
  }

  function handleFileInput(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    setItems(files.map((f) => ({ file: f, folderPath: "" })));
    // Reset input value so same file can be re-selected
    e.target.value = "";
  }

  function handleDragOver(e: React.DragEvent) {
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    setDragOver(true);
  }

  function handleDragLeave(e: React.DragEvent) {
    // Only trigger when leaving the drop zone itself
    if (e.currentTarget.contains(e.relatedTarget as Node)) return;
    setDragOver(false);
  }

  async function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragOver(false);

    if (hasDirectoryEntries(e.dataTransfer)) {
      setScanning(true);
      try {
        const result = await traverseDataTransferItems(e.dataTransfer, MAX_UPLOAD_FILES);
        if (result.truncated) {
          toast.error(t("fileExplorer:maxFilesError", { max: MAX_UPLOAD_FILES }));
        } else {
          setItems(result.files);
        }
      } finally {
        setScanning(false);
      }
    } else {
      const files = Array.from(e.dataTransfer.files);
      setItems(files.map((f) => ({ file: f, folderPath: "" })));
    }
  }

  return (
    <Dialog open={open} onOpenChange={() => { onClose(); reset(); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("fileExplorer:uploadDialog.title")}</DialogTitle>
          <DialogDescription>{t("fileExplorer:uploadDialog.description")}</DialogDescription>
        </DialogHeader>

        {/* Drop zone */}
        <div
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          onClick={() => !scanning && fileInputRef.current?.click()}
          className={`
            relative flex flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed
            p-8 cursor-pointer transition-colors
            ${dragOver
              ? "border-primary bg-primary/5"
              : "border-muted-foreground/25 hover:border-muted-foreground/50"
            }
          `}
        >
          {scanning ? (
            <>
              <Loader2 className="h-10 w-10 text-muted-foreground animate-spin" />
              <p className="text-sm text-muted-foreground">{t("fileExplorer:readingFolder")}</p>
            </>
          ) : items.length === 0 ? (
            <>
              <Upload className="h-10 w-10 text-muted-foreground" />
              <p className="text-sm text-muted-foreground">
                {t("fileExplorer:uploadDialog.clickToSelect")}
              </p>
              <p className="text-xs text-muted-foreground/70">
                {t("fileExplorer:uploadDialog.folderByDrop")}
              </p>
            </>
          ) : hasFolders ? (
            <>
              <FolderUp className="h-10 w-10 text-primary" />
              <p className="text-sm font-medium">
                {folderNames.length === 1 ? `${folderNames[0]}/` : t("fileExplorer:uploadDialog.foldersCount", { count: folderNames.length })}
              </p>
              <p className="text-sm text-muted-foreground">{t("fileExplorer:uploadDialog.filesCount", { count: items.length })}</p>
            </>
          ) : (
            <>
              <Upload className="h-10 w-10 text-primary" />
              <div className="text-sm text-muted-foreground space-y-0.5 text-center">
                {items.slice(0, MAX_SHOW_FILES).map((item, i) => (
                  <p key={i}>{item.file.name} ({formatBytes(item.file.size)})</p>
                ))}
                {items.length > MAX_SHOW_FILES && (
                  <p>{t("fileExplorer:uploadDialog.moreFiles", { count: items.length - MAX_SHOW_FILES })}</p>
                )}
              </div>
            </>
          )}
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={handleFileInput}
          />
        </div>

        {overLimit && (
          <p className="text-sm text-destructive font-medium">
            {t("fileExplorer:maxFilesError", { max: MAX_UPLOAD_FILES })}
          </p>
        )}

        {items.length > 0 && !overLimit && (
          <div className="flex justify-between items-center">
            <button
              onClick={(e) => { e.stopPropagation(); reset(); }}
              className="text-sm text-muted-foreground hover:text-foreground"
            >
              {t("common:clear")}
            </button>
            <Button onClick={handleUpload}>
              <Upload className="h-4 w-4 mr-2" />
              {items.length > 1 ? t("fileExplorer:uploadDialog.uploadButtonMulti", { count: items.length }) : t("fileExplorer:uploadDialog.uploadButton")}
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
