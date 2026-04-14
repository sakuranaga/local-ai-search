import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { DocumentPreview, hasExtractedContent, isPreviewable, isVideoType } from "@/components/DocumentPreview";
import { OverTypeEditor } from "@/components/OverTypeEditor";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Separator } from "@/components/ui/separator";
import {
  FileText,
  FolderIcon,
  Download,
  RefreshCw,
  Trash2,
  X,
  Copy,
  Check,
  Link,
  Plus,
  ChevronLeft,
  ChevronRight,
  Star,
  History,
  RotateCcw,
  ExternalLink,
} from "lucide-react";
import {
  getDocument,
  updateDocument,
  deleteDocument,
  reindexDocument,
  pollJobsProgress,
  setDocumentPermissions,
  getGroups,
  getMe,
  getDocumentVersions,
  restoreDocumentVersion,
  type Document,
  type DocumentListItem,
  type DocumentVersion,
  type Folder,
  type TagInfo,
  type Group,
  createShareLink,
  getShareLinks,
  deleteShareLink,
  type ShareLinkInfo,
} from "@/lib/api";
import { formatDate, formatDateTime, formatBytes, formatPermString } from "@/lib/fileExplorerHelpers";
import { t } from "@/i18n";

// ---------------------------------------------------------------------------
// Document Detail Modal
// ---------------------------------------------------------------------------

export function DocumentDetailModal({
  item,
  folders,
  allTags,
  shareEnabled = false,
  onClose,
  onUpdated,
  onTagsChanged,
  onPrev,
  onNext,
  isFavorited,
  onToggleFavorite,
}: {
  item: DocumentListItem | null;
  folders: Folder[];
  allTags: TagInfo[];
  shareEnabled?: boolean;
  onClose: () => void;
  onUpdated: (updated?: DocumentListItem) => void;
  onTagsChanged: () => void;
  onPrev?: () => void;
  onNext?: () => void;
  isFavorited?: boolean;
  onToggleFavorite?: () => void;
}) {
  const popupRef = useRef<HTMLDivElement>(null);
  const [doc, setDoc] = useState<Document | null>(null);
  const [tab, setTab] = useState<"view" | "edit" | "permissions" | "raw" | "share" | "versions">("view");
  const [loading, setLoading] = useState(false);
  const [editedContent, setEditedContent] = useState<string | null>(null);
  const [savingContent, setSavingContent] = useState(false);
  const [reindexing, setReindexing] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);
  // Preview overrides from EditTab (before save)
  const [previewShareProhibited, setPreviewShareProhibited] = useState<boolean | null>(null);
  const [previewDownloadProhibited, setPreviewDownloadProhibited] = useState<boolean | null>(null);
  const contentDirty = editedContent !== null && editedContent !== doc?.content;

  const showViewTab = item ? (isPreviewable(item.file_type) || hasExtractedContent(item.file_type)) : true;
  const showRawTab = item ? (hasExtractedContent(item.file_type) && !item.is_note) : true;

  useEffect(() => {
    if (!item) { setDoc(null); setTab("view"); setEditedContent(null); setPreviewShareProhibited(null); setPreviewDownloadProhibited(null); return; }
    const canPreview = isPreviewable(item.file_type) || hasExtractedContent(item.file_type);
    setTab(canPreview ? "view" : "edit");
    setLoading(true);
    setEditedContent(null);
    getDocument(item.id).then(setDoc).catch(() => toast.error(t("documents:fetchFailed"))).finally(() => setLoading(false));
    getMe().then((me) => setIsAdmin(me.roles.includes("admin"))).catch(() => {});
  }, [item?.id]);

  function handleClose() {
    if (contentDirty) {
      if (!confirm(t("documents:unsavedConfirm"))) return;
    }
    setEditedContent(null);
    onClose();
  }

  const handleDialogKeyDown = useCallback((e: React.KeyboardEvent) => {
    const tag = (e.target as HTMLElement).tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || (e.target as HTMLElement).isContentEditable) return;
    if (tag === "BUTTON") return;
    if ((e.key === "ArrowLeft" || e.key === "ArrowUp") && onPrev) { e.preventDefault(); onPrev(); }
    if ((e.key === "ArrowRight" || e.key === "ArrowDown") && onNext) { e.preventDefault(); onNext(); }
    if (e.key === " ") { e.preventDefault(); e.stopPropagation(); e.nativeEvent.stopImmediatePropagation(); onClose(); }
  }, [onPrev, onNext, onClose]);

  async function handleSaveContent() {
    if (!doc || editedContent === null) return;
    setSavingContent(true);
    try {
      const updated = await updateDocument(doc.id, { content: editedContent });
      setDoc({ ...doc, ...updated, content: editedContent });
      setEditedContent(null);
      onUpdated();
      toast.success(t("documents:textSaved"));
    } catch { toast.error(t("documents:textSaveFailed")); }
    finally { setSavingContent(false); }
  }

  if (!item) return null;

  const effectiveShareProhibited = previewShareProhibited ?? item.share_prohibited;
  const effectiveDownloadProhibited = previewDownloadProhibited ?? item.download_prohibited;

  return (
    <Dialog open={!!item} onOpenChange={() => handleClose()}>
      <DialogContent ref={popupRef} initialFocus={popupRef} onKeyDown={handleDialogKeyDown} className={`!max-w-none !w-screen !h-screen !max-h-screen !rounded-none !top-0 !left-0 !translate-x-0 !translate-y-0 md:!rounded-lg md:!top-1/2 md:!left-1/2 md:!-translate-x-1/2 md:!-translate-y-1/2 flex flex-col ${
        isVideoType(item.file_type)
          ? "md:!max-w-6xl md:!w-[95vw] md:!h-auto md:!max-h-[95vh]"
          : "md:!max-w-5xl md:!w-[95vw] md:!h-[85vh] md:!max-h-[85vh]"
      }`}>
        {/* Favorite + Prev / Next navigation */}
        <div className="absolute top-2 right-10 flex items-center gap-0.5">
          {onToggleFavorite && (
            <Button variant="ghost" size="icon-sm" onClick={onToggleFavorite} title={isFavorited ? t("documents:removeFavorite") : t("documents:addFavorite")} tabIndex={-1} className="!ring-0 !outline-none">
              <Star className={`h-4 w-4 ${isFavorited ? "fill-yellow-400 text-yellow-400" : ""}`} />
            </Button>
          )}
          <Button variant="ghost" size="icon-sm" disabled={!onPrev} onClick={onPrev} title={t("documents:prevFile")} tabIndex={-1} className="!ring-0 !outline-none">
            <ChevronLeft />
          </Button>
          <Button variant="ghost" size="icon-sm" disabled={!onNext} onClick={onNext} title={t("documents:nextFile")} tabIndex={-1} className="!ring-0 !outline-none">
            <ChevronRight />
          </Button>
        </div>

        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 pr-20">
            <FileText className="h-4 w-4 shrink-0" />
            <span className="truncate">{item.title}</span>
          </DialogTitle>
          <DialogDescription className="flex items-center gap-3 text-xs">
            <Badge variant="outline">{item.file_type}</Badge>
            {item.file_size != null && <span>{t("documents:sizeLabel")} {formatBytes(item.file_size)}</span>}
            <span>{t("documents:textLabel")} {item.chunk_count}</span>
            {item.folder_name && (
              <span className="flex items-center gap-0.5"><FolderIcon className="h-3 w-3" />{item.folder_name}</span>
            )}
            {item.tags?.map((tag) => (
              <span key={tag.id} className="inline-flex items-center text-xs px-1.5 rounded-full text-white" style={{ backgroundColor: tag.color || "#6b7280" }}>
                {tag.name}
              </span>
            ))}
            {item.created_by_name && <span>{t("documents:creatorLabel")} {item.created_by_name}</span>}
            <span>{t("documents:createdAtLabel")} {formatDateTime(item.created_at)}</span>
            <span>{t("documents:updatedAtLabel")} {formatDateTime(item.updated_at)}</span>
          </DialogDescription>
        </DialogHeader>

        {/* Tabs — hidden on mobile */}
        <div className="hidden md:flex gap-1 border-b">
          {([...(showViewTab ? ["view" as const] : []), "edit" as const, "permissions" as const, ...(showRawTab ? ["raw" as const] : []), "versions" as const, ...(shareEnabled && !effectiveShareProhibited ? ["share" as const] : [])] as const).map((tabKey) => (
            <button
              key={tabKey}
              onClick={() => setTab(tabKey)}
              className={`px-3 py-1.5 text-sm border-b-2 transition-colors ${
                tab === tabKey ? "border-primary text-primary font-medium" : "border-transparent text-muted-foreground hover:text-foreground"
              }`}
            >
              {{ view: t("documents:tabView"), edit: t("documents:tabEdit"), permissions: t("documents:tabPermissions"), raw: t("documents:tabSearchText"), versions: t("documents:tabVersions"), share: t("documents:tabShare") }[tabKey]}
            </button>
          ))}
          <div className="ml-auto flex items-center gap-1 pb-1">
            {effectiveShareProhibited && (
              <span className="text-xs text-destructive/70 px-1">{t("documents:shareProhibited")}</span>
            )}
            {["xlsx", "xls", "docx", "doc", "pptx", "ppt", "odt", "ods", "odp", "csv"].includes(item.file_type?.toLowerCase() ?? "") && (
              <Button
                size="sm"
                className="bg-black text-white hover:bg-black/80"
                onClick={() => window.open(`/editor?id=${item.id}`, "_blank")}
              >
                <ExternalLink className="h-3.5 w-3.5 mr-1" />{t("documents:editMode")}
              </Button>
            )}
            {item.source_path && (effectiveDownloadProhibited ? (
              <span className="text-xs text-destructive/70 px-1">{t("documents:downloadProhibited")}</span>
            ) : (
              <Button
                variant="outline" size="sm"
                onClick={() => {
                  const token = localStorage.getItem("las_token");
                  const params = token ? `?token=${encodeURIComponent(token)}` : "";
                  const a = document.createElement("a");
                  a.href = `/api/documents/${item.id}/download${params}`;
                  a.click();
                }}
              >
                <Download className="h-3.5 w-3.5 mr-1" />{t("documents:download")}
              </Button>
            ))}
            <Button
              variant="outline" size="sm"
              disabled={reindexing}
              onClick={async () => {
                setReindexing(true);
                try {
                  const res = await reindexDocument(item.id);
                  const jobId = (res as { job_id?: string }).job_id;
                  if (jobId) {
                    await pollJobsProgress([jobId], () => {});
                  }
                  toast.success(t("documents:reindexDone"));
                  // Refresh modal content and parent list
                  getDocument(item.id).then(setDoc).catch(() => {});
                  onUpdated();
                } catch { toast.error(t("documents:reindexFailed")); } finally { setReindexing(false); }
              }}
            >
              <RefreshCw className={`h-3.5 w-3.5 mr-1${reindexing ? " animate-spin" : ""}`} />
              {reindexing ? t("documents:reindexing") : t("documents:reindex")}
            </Button>
            <Button
              variant="destructive" size="sm"
              onClick={async () => {
                if (!confirm(t("documents:deleteConfirm"))) return;
                try {
                  await deleteDocument(item.id);
                  toast.success(t("documents:movedToTrash"));
                  onUpdated();
                  onClose();
                } catch { toast.error(t("documents:deleteFailed")); }
              }}
            >
              <Trash2 className="h-3.5 w-3.5 mr-1" />{t("common:delete")}
            </Button>
          </div>
        </div>

        {/* Tab content — double-tap to close on mobile */}
        <div
          className="flex-1 min-h-0 overflow-y-auto"
          onDoubleClick={() => { if (window.innerWidth < 768) handleClose(); }}
        >
          {loading && <p className="text-sm text-muted-foreground p-4">{t("common:loading")}</p>}

          {tab === "view" && doc && (
            <div className="space-y-3 h-full flex flex-col">
              {doc.memo && (
                <div className="text-sm text-muted-foreground bg-muted rounded-md px-3 py-2">{doc.memo}</div>
              )}
              <div className="flex-1 min-h-0">
                <DocumentPreview docId={doc.id} fileType={doc.file_type} content={doc.content} mode="preview" />
              </div>
            </div>
          )}

          {tab === "raw" && doc && (
            <div className="h-full flex flex-col">
              <div className="flex items-center gap-2 px-1 py-1.5">
                <span className="text-xs text-muted-foreground">
                  {contentDirty ? t("documents:unsavedChanges") : t("documents:searchTextHint")}
                </span>
                <div className="ml-auto flex items-center gap-2">
                  {contentDirty && (
                    <Button variant="ghost" size="sm" onClick={() => setEditedContent(null)}>
                      {t("documents:revert")}
                    </Button>
                  )}
                  <Button size="sm" disabled={!contentDirty || savingContent} onClick={handleSaveContent}>
                    {savingContent ? t("common:saving") : t("common:save")}
                  </Button>
                </div>
              </div>
              <div className="flex-1 min-h-0">
                <OverTypeEditor
                  value={doc.content}
                  onChange={(v) => setEditedContent(v)}
                />
              </div>
            </div>
          )}

          {tab === "edit" && doc && (
            <EditTab doc={doc} item={item} folders={folders} allTags={allTags} onSaved={onUpdated} onTagsChanged={onTagsChanged} isAdmin={isAdmin} onPreviewShareProhibited={setPreviewShareProhibited} onPreviewDownloadProhibited={setPreviewDownloadProhibited} />
          )}

          {tab === "permissions" && doc && (
            <PermissionsTab docId={item.id} doc={doc} />
          )}

          {tab === "versions" && doc && (
            <VersionsTab
              documentId={item.id}
              onRestored={() => {
                getDocument(item.id).then(setDoc).catch(() => {});
                onUpdated();
              }}
            />
          )}

          {tab === "share" && (
            <ShareTab documentId={item.id} documentTitle={item.title} />
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Edit Tab
// ---------------------------------------------------------------------------

function EditTab({
  doc,
  item,
  folders,
  allTags,
  onSaved,
  onTagsChanged,
  isAdmin,
  onPreviewShareProhibited,
  onPreviewDownloadProhibited,
}: {
  doc: Document;
  item: DocumentListItem;
  folders: Folder[];
  allTags: TagInfo[];
  onSaved: (updated: DocumentListItem) => void;
  onTagsChanged: () => void;
  isAdmin: boolean;
  onPreviewShareProhibited: (v: boolean | null) => void;
  onPreviewDownloadProhibited: (v: boolean | null) => void;
}) {
  const [title, setTitle] = useState(doc.title);
  const [summary, setSummary] = useState(doc.summary ?? "");
  const [memo, setMemo] = useState(doc.memo ?? "");
  const [searchable, setSearchable] = useState(doc.searchable);
  const [aiKnowledge, setAiKnowledge] = useState(doc.ai_knowledge);
  const [shareProhibited, setShareProhibited] = useState(doc.share_prohibited);
  const [downloadProhibited, setDownloadProhibited] = useState(doc.download_prohibited);
  const [folderId, setFolderId] = useState(doc.folder_id ?? "");
  const [docTags, setDocTags] = useState<TagInfo[]>(doc.tags ?? []);
  const [addTagId, setAddTagId] = useState("");
  const [saving, setSaving] = useState(false);

  const availableTags = allTags.filter((tag) => !docTags.find((dt) => dt.id === tag.id));

  async function saveTagsNow(newTags: TagInfo[]) {
    try {
      await updateDocument(item.id, { tag_ids: newTags.map((tag) => tag.id) });
      onTagsChanged();
    } catch { toast.error(t("documents:tagUpdateFailed")); }
  }

  function handleAddTag() {
    const tid = Number(addTagId);
    if (!tid) return;
    const tag = allTags.find((tag) => tag.id === tid);
    if (tag) {
      const newTags = [...docTags, tag];
      setDocTags(newTags);
      saveTagsNow(newTags);
    }
    setAddTagId("");
  }

  function handleRemoveTag(id: number) {
    const newTags = docTags.filter((tag) => tag.id !== id);
    setDocTags(newTags);
    saveTagsNow(newTags);
  }

  async function handleToggleFlag(field: "searchable" | "ai_knowledge" | "share_prohibited" | "download_prohibited", value: boolean) {
    // Update local state immediately
    if (field === "searchable") setSearchable(value);
    else if (field === "ai_knowledge") setAiKnowledge(value);
    else if (field === "share_prohibited") { setShareProhibited(value); onPreviewShareProhibited(value); }
    else if (field === "download_prohibited") { setDownloadProhibited(value); onPreviewDownloadProhibited(value); }
    // Save to server
    try {
      const updated = await updateDocument(item.id, { [field]: value });
      onPreviewShareProhibited(null);
      onPreviewDownloadProhibited(null);
      onSaved({ ...item, ...updated });
    } catch {
      toast.error(t("common:updateFailed"));
      // Revert
      if (field === "searchable") setSearchable(!value);
      else if (field === "ai_knowledge") setAiKnowledge(!value);
      else if (field === "share_prohibited") { setShareProhibited(!value); onPreviewShareProhibited(!value); }
      else if (field === "download_prohibited") { setDownloadProhibited(!value); onPreviewDownloadProhibited(!value); }
    }
  }

  async function handleSave() {
    setSaving(true);
    try {
      const updated = await updateDocument(item.id, {
        title,
        summary,
        memo,
        folder_id: folderId || null,
        tag_ids: docTags.map((tag) => tag.id),
      });
      toast.success(t("common:saved"));
      onPreviewShareProhibited(null);
      onPreviewDownloadProhibited(null);
      onSaved({ ...item, title: updated.title, summary: updated.summary ?? "", folder_id: updated.folder_id ?? null, is_note: updated.is_note, share_prohibited: updated.share_prohibited, download_prohibited: updated.download_prohibited });
      onTagsChanged();
    } catch { toast.error(t("documents:editSaveFailed")); }
    finally { setSaving(false); }
  }

  return (
    <div className="space-y-4 p-1">
      <div>
        <label className="text-sm font-medium">{t("documents:titleLabel")}</label>
        <Input value={title} onChange={(e) => setTitle(e.target.value)} />
      </div>
      <div>
        <label className="text-sm font-medium">{t("documents:summaryLabel")}</label>
        <Textarea value={summary} onChange={(e) => setSummary(e.target.value)} placeholder={t("documents:summaryPlaceholder")} rows={3} />
      </div>
      <div>
        <label className="text-sm font-medium">{t("documents:memoLabel")}</label>
        <Textarea value={memo} onChange={(e) => setMemo(e.target.value)} placeholder={t("documents:memoPlaceholder")} rows={3} />
      </div>
      <div>
        <label className="text-sm font-medium">{t("documents:folderLabel")}</label>
        <select
          value={folderId}
          onChange={(e) => setFolderId(e.target.value)}
          className="w-full h-9 rounded-md border bg-background px-3 text-sm"
        >
          <option value="">{t("documents:unfiled")}</option>
          {folders.map((f) => (
            <option key={f.id} value={f.id}>{f.name}</option>
          ))}
        </select>
      </div>
      <div>
        <label className="text-sm font-medium">{t("documents:tagsLabel")}</label>
        <div className="flex flex-wrap gap-1 mt-1 mb-2">
          {docTags.map((tag) => (
            <span
              key={tag.id}
              className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full text-white"
              style={{ backgroundColor: tag.color || "#6b7280" }}
            >
              {tag.name}
              <button onClick={() => handleRemoveTag(tag.id)} className="hover:opacity-70">
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
        </div>
        {availableTags.length > 0 && (
          <div className="flex items-center gap-2">
            <select
              value={addTagId}
              onChange={(e) => setAddTagId(e.target.value)}
              className="h-8 flex-1 rounded-md border bg-background px-3 text-sm"
            >
              <option value="">{t("documents:addTag")}</option>
              {availableTags.map((tag) => (
                <option key={tag.id} value={tag.id}>{tag.name}</option>
              ))}
            </select>
            <Button size="sm" variant="outline" onClick={handleAddTag} disabled={!addTagId}>{t("common:add")}</Button>
          </div>
        )}
      </div>
      <div className="flex justify-end">
        <Button onClick={handleSave} disabled={saving || !title.trim()}>{t("common:save")}</Button>
      </div>
      <Separator />
      <div className="flex flex-col gap-2">
        <span className="text-xs font-medium text-muted-foreground">{t("documents:searchSettings")}</span>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={searchable} onChange={(e) => handleToggleFlag("searchable", e.target.checked)} />
          {t("documents:includeInSearch")}
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={aiKnowledge} onChange={(e) => handleToggleFlag("ai_knowledge", e.target.checked)} />
          {t("documents:includeInAi")}
        </label>
        {isAdmin && (
          <>
            <span className="text-xs font-medium text-muted-foreground mt-1">{t("documents:adminSettings")}</span>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={shareProhibited} onChange={(e) => handleToggleFlag("share_prohibited", e.target.checked)} />
              {t("documents:prohibitShare")}
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={downloadProhibited} onChange={(e) => handleToggleFlag("download_prohibited", e.target.checked)} />
              {t("documents:prohibitDownload")}
            </label>
          </>
        )}
        {!isAdmin && (item.share_prohibited || item.download_prohibited) && (
          <div className="flex flex-col gap-1 text-xs text-muted-foreground mt-1">
            {item.share_prohibited && <span>{t("documents:shareProhibitedBadge")}</span>}
            {item.download_prohibited && <span>{t("documents:downloadProhibitedBadge")}</span>}
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Permissions Tab
// ---------------------------------------------------------------------------

function PermissionsTab({ docId, doc }: { docId: string; doc: Document }) {
  const [groups, setGroups] = useState<Group[]>([]);
  const [groupId, setGroupId] = useState(doc.group_id ?? "");
  const [groupRead, setGroupRead] = useState(doc.group_read);
  const [groupWrite, setGroupWrite] = useState(doc.group_write);
  const [othersRead, setOthersRead] = useState(doc.others_read);
  const [othersWrite, setOthersWrite] = useState(doc.others_write);
  const [saving, setSaving] = useState(false);
  const [canEdit, setCanEdit] = useState(false);

  useEffect(() => {
    getGroups().then(setGroups).catch(() => {});
    getMe().then((me) => {
      const isOwner = doc.owner_id === me.id;
      const isAdmin = me.roles.includes("admin");
      setCanEdit(isOwner || isAdmin);
    }).catch(() => {});
  }, [docId]);

  async function handleSave() {
    setSaving(true);
    try {
      await setDocumentPermissions(docId, {
        group_id: groupId || null,
        group_read: groupRead,
        group_write: groupWrite,
        others_read: othersRead,
        others_write: othersWrite,
      });
      toast.success(t("documents:permissionsSaved"));
    } catch { toast.error(t("documents:permissionsSaveFailed")); }
    finally { setSaving(false); }
  }

  return (
    <div className="space-y-4 p-1">
      <div className="text-sm">
        <span className="font-medium">{t("documents:ownerLabel")}</span>{" "}
        <span>{doc.owner_name ?? t("common:unknown")}</span>{" "}
        <Badge variant="outline" className="text-xs ml-1">{t("common:rwFixed")}</Badge>
      </div>

      <Separator />

      <div>
        <label className="text-sm font-medium">{t("common:group")}</label>
        <select
          value={groupId}
          onChange={(e) => setGroupId(e.target.value)}
          disabled={!canEdit}
          className="w-full h-9 rounded-md border bg-background px-3 text-sm mt-1 disabled:opacity-50"
        >
          <option value="">{t("common:none")}</option>
          {groups.map((g) => (
            <option key={g.id} value={g.id}>{g.name}</option>
          ))}
        </select>
        <div className="flex gap-4 mt-2">
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={groupRead} onChange={(e) => setGroupRead(e.target.checked)} disabled={!canEdit} />
            {t("common:read")}
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={groupWrite} onChange={(e) => setGroupWrite(e.target.checked)} disabled={!canEdit} />
            {t("common:write")}
          </label>
        </div>
      </div>

      <Separator />

      <div>
        <label className="text-sm font-medium">{t("common:othersLabel")}</label>
        <div className="flex gap-4 mt-2">
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={othersRead} onChange={(e) => setOthersRead(e.target.checked)} disabled={!canEdit} />
            {t("common:read")}
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={othersWrite} onChange={(e) => setOthersWrite(e.target.checked)} disabled={!canEdit} />
            {t("common:write")}
          </label>
        </div>
      </div>

      <Separator />

      <div className="flex items-center gap-2">
        <span className="text-sm font-medium">{t("common:permissionString")}</span>
        <code className="text-sm font-mono bg-muted px-2 py-0.5 rounded">
          {formatPermString(groupRead, groupWrite, othersRead, othersWrite)}
        </code>
      </div>

      <p className="text-xs text-muted-foreground">
        {canEdit
          ? t("documents:adminNote")
          : t("documents:permissionsNote")}
      </p>

      <div className="flex justify-end"><Button onClick={handleSave} disabled={saving || !canEdit}>{t("documents:savePermissions")}</Button></div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Versions Tab
// ---------------------------------------------------------------------------

function VersionsTab({ documentId, onRestored }: { documentId: string; onRestored: () => void }) {
  const [versions, setVersions] = useState<DocumentVersion[]>([]);
  const [loading, setLoading] = useState(true);
  const [restoring, setRestoring] = useState<number | null>(null);

  useEffect(() => {
    setLoading(true);
    getDocumentVersions(documentId)
      .then(setVersions)
      .catch(() => toast.error(t("documents:versionsFetchFailed")))
      .finally(() => setLoading(false));
  }, [documentId]);

  async function handleRestore(versionNumber: number) {
    if (!confirm(t("documents:versionRestoreConfirm", { version: versionNumber }))) return;
    setRestoring(versionNumber);
    try {
      await restoreDocumentVersion(documentId, versionNumber);
      toast.success(t("documents:versionRestored", { version: versionNumber }));
      // Reload versions
      const updated = await getDocumentVersions(documentId);
      setVersions(updated);
      onRestored();
    } catch {
      toast.error(t("documents:versionRestoreFailed"));
    } finally {
      setRestoring(null);
    }
  }

  if (loading) return <p className="text-sm text-muted-foreground p-4">{t("common:loading")}</p>;

  if (versions.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 p-8 text-muted-foreground">
        <History className="h-8 w-8" />
        <p className="text-sm">{t("documents:noVersionHistory")}</p>
        <p className="text-xs">{t("documents:versionHistoryHint")}</p>
      </div>
    );
  }

  return (
    <div className="space-y-1 p-2">
      {versions.map((v) => (
        <div
          key={v.version_number}
          className={`flex items-center gap-3 rounded-md px-3 py-2 text-sm ${
            v.is_current ? "bg-primary/5 border border-primary/20" : "hover:bg-muted"
          }`}
        >
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <span className="font-medium">v{v.version_number}</span>
              {v.is_current && (
                <Badge variant="outline" className="text-xs px-1.5 py-0">{t("documents:current")}</Badge>
              )}
              {v.change_type && (
                <Badge variant="secondary" className="text-xs px-1.5 py-0">
                  {t("documents:changeType." + v.change_type) ?? v.change_type}
                </Badge>
              )}
            </div>
            <div className="text-xs text-muted-foreground mt-0.5">
              {v.created_at && formatDateTime(v.created_at)}
              {v.created_by_name && ` — ${v.created_by_name}`}
              {v.file_size != null && ` — ${formatBytes(v.file_size)}`}
            </div>
          </div>
          {!v.is_current && (
            <Button
              variant="outline"
              size="sm"
              disabled={restoring !== null}
              onClick={() => handleRestore(v.version_number)}
            >
              {restoring === v.version_number ? (
                <RefreshCw className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <RotateCcw className="h-3.5 w-3.5 mr-1" />
              )}
              {restoring === v.version_number ? "" : t("documents:restoreButton")}
            </Button>
          )}
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Share Tab
// ---------------------------------------------------------------------------

function ShareTab({ documentId }: { documentId: string; documentTitle: string }) {
  const [links, setLinks] = useState<ShareLinkInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  // Create form
  const [showCreate, setShowCreate] = useState(false);

  const [expiresIn, setExpiresIn] = useState("7d");
  const [usePassword, setUsePassword] = useState(false);
  const [password, setPassword] = useState("");
  const [creating, setCreating] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    getShareLinks()
      .then((all) => setLinks(all.filter((l) => l.document_id === documentId)))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [documentId]);

  useEffect(load, [load]);

  async function handleCreate() {
    setCreating(true);
    try {
      await createShareLink({
        document_id: documentId,
        password: usePassword && password ? password : null,
        expires_in: expiresIn,
      });
      setShowCreate(false);
      setPassword("");
      load();
      toast.success(t("documents:shareLinkCreated"));
    } catch (e: any) {
      toast.error(e.message || t("common:createFailed"));
    } finally {
      setCreating(false);
    }
  }

  async function handleDelete(id: string) {
    if (!confirm(t("documents:shareLinkDisableConfirm"))) return;
    try {
      await deleteShareLink(id);
      load();
      toast.success(t("documents:shareLinkDisabled"));
    } catch { toast.error(t("common:failed")); }
  }

  function handleCopy(url: string, id: string) {
    navigator.clipboard.writeText(url);
    setCopiedId(id);
    toast.success(t("documents:urlCopied"));
    setTimeout(() => setCopiedId(null), 2000);
  }

  if (loading) return <p className="text-sm text-muted-foreground p-4">{t("common:loading")}</p>;

  return (
    <div className="space-y-4 p-1">
      {links.length === 0 && !showCreate && (
        <p className="text-sm text-muted-foreground py-4 text-center">{t("documents:noShareLinks")}</p>
      )}

      {links.map((link) => (
        <div key={link.id} className="border rounded-lg p-3 space-y-2">
          <div className="flex items-center gap-2">
            <Link className="h-4 w-4 text-primary shrink-0" />
            <span className="text-sm font-mono truncate flex-1">{link.url}</span>
            <Button variant="ghost" size="sm" className="h-7 px-2" onClick={() => handleCopy(link.url, link.id)}>
              {copiedId === link.id ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
            </Button>
            {link.is_active && (
              <Button variant="ghost" size="sm" className="h-7 px-2 text-destructive" onClick={() => handleDelete(link.id)}>
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            )}
          </div>
          <div className="flex items-center gap-3 text-xs text-muted-foreground">
            {link.has_password && <span>🔒 {t("documents:passwordLabel")}</span>}
            <span>{t("documents:expiryLabel")} {link.expires_at ? formatDate(link.expires_at) : t("documents:noExpiry")}</span>
            {!link.is_active && <span className="text-destructive font-medium">{t("documents:inactive")}</span>}
          </div>
        </div>
      ))}

      {showCreate ? (
        <div className="border rounded-lg p-3 space-y-3">
          <h4 className="text-sm font-medium">{t("documents:newShareLink")}</h4>
          <select value={expiresIn} onChange={(e) => setExpiresIn(e.target.value)} className="h-8 rounded-md border bg-background px-2 text-sm w-full">
            <option value="1h">{t("documents:hour1")}</option>
            <option value="1d">{t("documents:day1")}</option>
            <option value="7d">{t("documents:days7")}</option>
            <option value="30d">{t("documents:days30")}</option>
          </select>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={usePassword} onChange={(e) => setUsePassword(e.target.checked)} />{t("documents:passwordProtection")}
          </label>
          {usePassword && <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder={t("documents:passwordLabel")} />}
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => setShowCreate(false)}>{t("common:cancel")}</Button>
            <Button size="sm" onClick={handleCreate} disabled={creating}>{creating ? t("common:creating") : t("common:create")}</Button>
          </div>
        </div>
      ) : (
        <Button variant="outline" size="sm" onClick={() => setShowCreate(true)}>
          <Plus className="h-3.5 w-3.5 mr-1" />{t("documents:newShareLink")}
        </Button>
      )}
    </div>
  );
}
