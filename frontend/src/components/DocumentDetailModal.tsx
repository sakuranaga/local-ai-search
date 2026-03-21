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
} from "lucide-react";
import {
  getDocument,
  updateDocument,
  deleteDocument,
  reindexDocument,
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
  const contentDirty = editedContent !== null && editedContent !== doc?.content;

  const showViewTab = item ? (isPreviewable(item.file_type) || hasExtractedContent(item.file_type)) : true;
  const showRawTab = item ? (hasExtractedContent(item.file_type) && !item.is_note) : true;

  useEffect(() => {
    if (!item) { setDoc(null); setTab("view"); setEditedContent(null); return; }
    const canPreview = isPreviewable(item.file_type) || hasExtractedContent(item.file_type);
    setTab(canPreview ? "view" : "edit");
    setLoading(true);
    setEditedContent(null);
    getDocument(item.id).then(setDoc).catch(() => toast.error("文書取得失敗")).finally(() => setLoading(false));
  }, [item?.id]);

  function handleClose() {
    if (contentDirty) {
      if (!confirm("編集内容が保存されていません。閉じますか？")) return;
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
      toast.success("テキストを保存しました（再チャンク・再ベクトル化完了）");
    } catch { toast.error("保存に失敗しました"); }
    finally { setSavingContent(false); }
  }

  if (!item) return null;

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
            <Button variant="ghost" size="icon-sm" onClick={onToggleFavorite} title={isFavorited ? "お気に入り解除" : "お気に入り追加"} tabIndex={-1} className="!ring-0 !outline-none">
              <Star className={`h-4 w-4 ${isFavorited ? "fill-yellow-400 text-yellow-400" : ""}`} />
            </Button>
          )}
          <Button variant="ghost" size="icon-sm" disabled={!onPrev} onClick={onPrev} title="前のファイル (←)" tabIndex={-1} className="!ring-0 !outline-none">
            <ChevronLeft />
          </Button>
          <Button variant="ghost" size="icon-sm" disabled={!onNext} onClick={onNext} title="次のファイル (→)" tabIndex={-1} className="!ring-0 !outline-none">
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
            {item.file_size != null && <span>サイズ: {formatBytes(item.file_size)}</span>}
            <span>チャンク: {item.chunk_count}</span>
            {item.folder_name && (
              <span className="flex items-center gap-0.5"><FolderIcon className="h-3 w-3" />{item.folder_name}</span>
            )}
            {item.tags?.map((t) => (
              <span key={t.id} className="inline-flex items-center text-xs px-1.5 rounded-full text-white" style={{ backgroundColor: t.color || "#6b7280" }}>
                {t.name}
              </span>
            ))}
            {item.created_by_name && <span>登録者: {item.created_by_name}</span>}
            <span>登録日: {formatDateTime(item.created_at)}</span>
            <span>更新日: {formatDateTime(item.updated_at)}</span>
          </DialogDescription>
        </DialogHeader>

        {/* Tabs — hidden on mobile */}
        <div className="hidden md:flex gap-1 border-b">
          {([...(showViewTab ? ["view" as const] : []), "edit" as const, "permissions" as const, ...(showRawTab ? ["raw" as const] : []), "versions" as const, ...(shareEnabled && !item.share_prohibited ? ["share" as const] : [])] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`px-3 py-1.5 text-sm border-b-2 transition-colors ${
                tab === t ? "border-primary text-primary font-medium" : "border-transparent text-muted-foreground hover:text-foreground"
              }`}
            >
              {{ view: "表示", edit: "編集", permissions: "権限", raw: "検索テキスト", versions: "バージョン", share: "共有" }[t]}
            </button>
          ))}
          <div className="ml-auto flex items-center gap-1 pb-1">
            {item.source_path && !item.download_prohibited && (
              <Button
                variant="outline" size="sm"
                onClick={async () => {
                  try {
                    const token = localStorage.getItem("las_token");
                    const res = await fetch(`/api/documents/${item.id}/download`, {
                      headers: token ? { Authorization: `Bearer ${token}` } : {},
                    });
                    if (!res.ok) throw new Error("Download failed");
                    const blob = await res.blob();
                    const disposition = res.headers.get("content-disposition");
                    const filenameMatch = disposition?.match(/filename\*?=(?:UTF-8''|"?)([^";]+)/i);
                    const filename = filenameMatch ? decodeURIComponent(filenameMatch[1]) : item.title;
                    const a = document.createElement("a");
                    a.href = URL.createObjectURL(blob);
                    a.download = filename;
                    a.click();
                    URL.revokeObjectURL(a.href);
                  } catch { toast.error("ダウンロード失敗"); }
                }}
              >
                <Download className="h-3.5 w-3.5 mr-1" />ダウンロード
              </Button>
            )}
            <Button
              variant="outline" size="sm"
              onClick={async () => {
                try {
                  const res = await reindexDocument(item.id);
                  toast.success(`再構築完了: ${res.chunk_count}チャンク`);
                  onUpdated();
                } catch { toast.error("再構築失敗"); }
              }}
            >
              <RefreshCw className="h-3.5 w-3.5 mr-1" />再構築
            </Button>
            <Button
              variant="destructive" size="sm"
              onClick={async () => {
                if (!confirm("この文書をゴミ箱に移動しますか？")) return;
                try {
                  await deleteDocument(item.id);
                  toast.success("ゴミ箱に移動しました");
                  onUpdated();
                  onClose();
                } catch { toast.error("削除失敗"); }
              }}
            >
              <Trash2 className="h-3.5 w-3.5 mr-1" />削除
            </Button>
          </div>
        </div>

        {/* Tab content — double-tap to close on mobile */}
        <div
          className="flex-1 min-h-0 overflow-y-auto"
          onDoubleClick={() => { if (window.innerWidth < 768) handleClose(); }}
        >
          {loading && <p className="text-sm text-muted-foreground p-4">読み込み中...</p>}

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
                  {contentDirty ? "変更あり（未保存）" : "検索・AIが参照するテキストです — 元ファイルは変更されません"}
                </span>
                <div className="ml-auto flex items-center gap-2">
                  {contentDirty && (
                    <Button variant="ghost" size="sm" onClick={() => setEditedContent(null)}>
                      元に戻す
                    </Button>
                  )}
                  <Button size="sm" disabled={!contentDirty || savingContent} onClick={handleSaveContent}>
                    {savingContent ? "保存中..." : "保存"}
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
            <EditTab doc={doc} item={item} folders={folders} allTags={allTags} onSaved={onUpdated} onTagsChanged={onTagsChanged} />
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
}: {
  doc: Document;
  item: DocumentListItem;
  folders: Folder[];
  allTags: TagInfo[];
  onSaved: (updated: DocumentListItem) => void;
  onTagsChanged: () => void;
}) {
  const [title, setTitle] = useState(doc.title);
  const [summary, setSummary] = useState(doc.summary ?? "");
  const [memo, setMemo] = useState(doc.memo ?? "");
  const [searchable, setSearchable] = useState(doc.searchable);
  const [aiKnowledge, setAiKnowledge] = useState(doc.ai_knowledge);
  const [folderId, setFolderId] = useState(doc.folder_id ?? "");
  const [docTags, setDocTags] = useState<TagInfo[]>(doc.tags ?? []);
  const [addTagId, setAddTagId] = useState("");
  const [saving, setSaving] = useState(false);

  const availableTags = allTags.filter((t) => !docTags.find((dt) => dt.id === t.id));

  async function saveTagsNow(newTags: TagInfo[]) {
    try {
      await updateDocument(item.id, { tag_ids: newTags.map((t) => t.id) });
      onTagsChanged();
    } catch { toast.error("タグ更新失敗"); }
  }

  function handleAddTag() {
    const tid = Number(addTagId);
    if (!tid) return;
    const tag = allTags.find((t) => t.id === tid);
    if (tag) {
      const newTags = [...docTags, tag];
      setDocTags(newTags);
      saveTagsNow(newTags);
    }
    setAddTagId("");
  }

  function handleRemoveTag(id: number) {
    const newTags = docTags.filter((t) => t.id !== id);
    setDocTags(newTags);
    saveTagsNow(newTags);
  }

  async function handleSave() {
    setSaving(true);
    try {
      const updated = await updateDocument(item.id, {
        title,
        summary,
        memo,
        searchable,
        ai_knowledge: aiKnowledge,
        folder_id: folderId || null,
        tag_ids: docTags.map((t) => t.id),
      });
      toast.success("保存しました");
      onSaved({ ...item, title: updated.title, summary: updated.summary ?? "", folder_id: updated.folder_id ?? null, is_note: updated.is_note });
      onTagsChanged();
    } catch { toast.error("保存失敗"); }
    finally { setSaving(false); }
  }

  return (
    <div className="space-y-4 p-1">
      <div>
        <label className="text-sm font-medium">タイトル</label>
        <Input value={title} onChange={(e) => setTitle(e.target.value)} />
      </div>
      <div>
        <label className="text-sm font-medium">要約</label>
        <Textarea value={summary} onChange={(e) => setSummary(e.target.value)} placeholder="文書の要約..." rows={3} />
      </div>
      <div>
        <label className="text-sm font-medium">メモ</label>
        <Textarea value={memo} onChange={(e) => setMemo(e.target.value)} placeholder="メモ..." rows={3} />
      </div>
      <div>
        <label className="text-sm font-medium">フォルダ</label>
        <select
          value={folderId}
          onChange={(e) => setFolderId(e.target.value)}
          className="w-full h-9 rounded-md border bg-background px-3 text-sm"
        >
          <option value="">なし（未整理）</option>
          {folders.map((f) => (
            <option key={f.id} value={f.id}>{f.name}</option>
          ))}
        </select>
      </div>
      <div>
        <label className="text-sm font-medium">タグ</label>
        <div className="flex flex-wrap gap-1 mt-1 mb-2">
          {docTags.map((t) => (
            <span
              key={t.id}
              className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full text-white"
              style={{ backgroundColor: t.color || "#6b7280" }}
            >
              {t.name}
              <button onClick={() => handleRemoveTag(t.id)} className="hover:opacity-70">
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
              <option value="">タグを追加...</option>
              {availableTags.map((t) => (
                <option key={t.id} value={t.id}>{t.name}</option>
              ))}
            </select>
            <Button size="sm" variant="outline" onClick={handleAddTag} disabled={!addTagId}>追加</Button>
          </div>
        )}
      </div>
      <div className="flex flex-col gap-2">
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={searchable} onChange={(e) => setSearchable(e.target.checked)} />
          検索対象に含める
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={aiKnowledge} onChange={(e) => setAiKnowledge(e.target.checked)} />
          AIナレッジに含める
        </label>
      </div>
      <Button onClick={handleSave} disabled={saving || !title.trim()}>保存</Button>
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
      toast.success("権限を保存しました");
    } catch { toast.error("保存失敗"); }
    finally { setSaving(false); }
  }

  return (
    <div className="space-y-4 p-1">
      <div className="text-sm">
        <span className="font-medium">オーナー:</span>{" "}
        <span>{doc.owner_name ?? "不明"}</span>{" "}
        <Badge variant="outline" className="text-xs ml-1">rw（固定）</Badge>
      </div>

      <Separator />

      <div>
        <label className="text-sm font-medium">グループ</label>
        <select
          value={groupId}
          onChange={(e) => setGroupId(e.target.value)}
          disabled={!canEdit}
          className="w-full h-9 rounded-md border bg-background px-3 text-sm mt-1 disabled:opacity-50"
        >
          <option value="">なし</option>
          {groups.map((g) => (
            <option key={g.id} value={g.id}>{g.name}</option>
          ))}
        </select>
        <div className="flex gap-4 mt-2">
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={groupRead} onChange={(e) => setGroupRead(e.target.checked)} disabled={!canEdit} />
            読み取り
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={groupWrite} onChange={(e) => setGroupWrite(e.target.checked)} disabled={!canEdit} />
            書き込み
          </label>
        </div>
      </div>

      <Separator />

      <div>
        <label className="text-sm font-medium">全員（others）</label>
        <div className="flex gap-4 mt-2">
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={othersRead} onChange={(e) => setOthersRead(e.target.checked)} disabled={!canEdit} />
            読み取り
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={othersWrite} onChange={(e) => setOthersWrite(e.target.checked)} disabled={!canEdit} />
            書き込み
          </label>
        </div>
      </div>

      <Separator />

      <div className="flex items-center gap-2">
        <span className="text-sm font-medium">パーミッション:</span>
        <code className="text-sm font-mono bg-muted px-2 py-0.5 rounded">
          {formatPermString(groupRead, groupWrite, othersRead, othersWrite)}
        </code>
      </div>

      <p className="text-xs text-muted-foreground">
        {canEdit
          ? "adminロールのユーザーは全文書にアクセス可能です"
          : "権限の変更はオーナーまたは管理者のみ可能です"}
      </p>

      <Button onClick={handleSave} disabled={saving || !canEdit}>権限を保存</Button>
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
      .catch(() => toast.error("バージョン一覧の取得に失敗"))
      .finally(() => setLoading(false));
  }, [documentId]);

  async function handleRestore(versionNumber: number) {
    if (!confirm(`バージョン ${versionNumber} に復元しますか？`)) return;
    setRestoring(versionNumber);
    try {
      await restoreDocumentVersion(documentId, versionNumber);
      toast.success(`バージョン ${versionNumber} に復元しました`);
      // Reload versions
      const updated = await getDocumentVersions(documentId);
      setVersions(updated);
      onRestored();
    } catch {
      toast.error("復元に失敗しました");
    } finally {
      setRestoring(null);
    }
  }

  if (loading) return <p className="text-sm text-muted-foreground p-4">読み込み中...</p>;

  if (versions.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 p-8 text-muted-foreground">
        <History className="h-8 w-8" />
        <p className="text-sm">バージョン履歴はありません</p>
        <p className="text-xs">ファイルの上書きやテキスト編集で自動的に作成されます</p>
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
                <Badge variant="outline" className="text-xs px-1.5 py-0">現在</Badge>
              )}
              {v.change_type && (
                <Badge variant="secondary" className="text-xs px-1.5 py-0">
                  {{ upload: "アップロード", text_edit: "テキスト編集", overwrite: "ファイル上書き" }[v.change_type] ?? v.change_type}
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
              {restoring === v.version_number ? "" : "復元"}
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
      toast.success("共有リンクを作成しました");
    } catch (e: any) {
      toast.error(e.message || "作成に失敗しました");
    } finally {
      setCreating(false);
    }
  }

  async function handleDelete(id: string) {
    if (!confirm("この共有リンクを無効化しますか？")) return;
    try {
      await deleteShareLink(id);
      load();
      toast.success("共有リンクを無効化しました");
    } catch { toast.error("失敗しました"); }
  }

  function handleCopy(url: string, id: string) {
    navigator.clipboard.writeText(url);
    setCopiedId(id);
    toast.success("URLをコピーしました");
    setTimeout(() => setCopiedId(null), 2000);
  }

  if (loading) return <p className="text-sm text-muted-foreground p-4">読み込み中...</p>;

  return (
    <div className="space-y-4 p-1">
      {links.length === 0 && !showCreate && (
        <p className="text-sm text-muted-foreground py-4 text-center">共有リンクはありません</p>
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
            {link.has_password && <span>🔒 パスワード</span>}
            <span>期限: {link.expires_at ? formatDate(link.expires_at) : "無期限"}</span>
            {!link.is_active && <span className="text-destructive font-medium">無効</span>}
          </div>
        </div>
      ))}

      {showCreate ? (
        <div className="border rounded-lg p-3 space-y-3">
          <h4 className="text-sm font-medium">新しい共有リンク</h4>
          <select value={expiresIn} onChange={(e) => setExpiresIn(e.target.value)} className="h-8 rounded-md border bg-background px-2 text-sm w-full">
            <option value="1h">1時間</option>
            <option value="1d">1日</option>
            <option value="7d">7日間</option>
            <option value="30d">30日間</option>
          </select>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={usePassword} onChange={(e) => setUsePassword(e.target.checked)} />パスワード保護
          </label>
          {usePassword && <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="パスワード" />}
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => setShowCreate(false)}>キャンセル</Button>
            <Button size="sm" onClick={handleCreate} disabled={creating}>{creating ? "作成中..." : "作成"}</Button>
          </div>
        </div>
      ) : (
        <Button variant="outline" size="sm" onClick={() => setShowCreate(true)}>
          <Plus className="h-3.5 w-3.5 mr-1" />新しい共有リンク
        </Button>
      )}
    </div>
  );
}
