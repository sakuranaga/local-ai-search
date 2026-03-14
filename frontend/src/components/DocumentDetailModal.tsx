import { useEffect, useState } from "react";
import { toast } from "sonner";
import { DocumentPreview } from "@/components/DocumentPreview";
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
} from "lucide-react";
import {
  getDocument,
  updateDocument,
  deleteDocument,
  reindexDocument,
  setDocumentPermissions,
  getGroups,
  getMe,
  type Document,
  type DocumentListItem,
  type Folder,
  type TagInfo,
  type Group,
} from "@/lib/api";
import { formatDate, formatPermString } from "@/lib/fileExplorerHelpers";

// ---------------------------------------------------------------------------
// Document Detail Modal
// ---------------------------------------------------------------------------

export function DocumentDetailModal({
  item,
  folders,
  allTags,
  onClose,
  onUpdated,
  onTagsChanged,
}: {
  item: DocumentListItem | null;
  folders: Folder[];
  allTags: TagInfo[];
  onClose: () => void;
  onUpdated: () => void;
  onTagsChanged: () => void;
}) {
  const [doc, setDoc] = useState<Document | null>(null);
  const [tab, setTab] = useState<"view" | "edit" | "permissions" | "raw">("view");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!item) { setDoc(null); setTab("view"); return; }
    setLoading(true);
    getDocument(item.id).then(setDoc).catch(() => toast.error("文書取得失敗")).finally(() => setLoading(false));
  }, [item?.id]);

  if (!item) return null;

  return (
    <Dialog open={!!item} onOpenChange={() => onClose()}>
      <DialogContent className="sm:max-w-5xl w-[95vw] h-[85vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileText className="h-4 w-4" />
            {item.title}
          </DialogTitle>
          <DialogDescription className="flex items-center gap-3 text-xs">
            <Badge variant="outline">{item.file_type}</Badge>
            <span>チャンク: {item.chunk_count}</span>
            {item.folder_name && (
              <span className="flex items-center gap-0.5"><FolderIcon className="h-3 w-3" />{item.folder_name}</span>
            )}
            {item.tags?.map((t) => (
              <span key={t.id} className="inline-flex items-center text-xs px-1.5 rounded-full text-white" style={{ backgroundColor: t.color || "#6b7280" }}>
                {t.name}
              </span>
            ))}
            {item.created_by_name && <span>登録: {item.created_by_name}</span>}
            <span>{formatDate(item.updated_at)}</span>
          </DialogDescription>
        </DialogHeader>

        {/* Tabs */}
        <div className="flex gap-1 border-b">
          {(["view", "edit", "permissions", "raw"] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`px-3 py-1.5 text-sm border-b-2 transition-colors ${
                tab === t ? "border-primary text-primary font-medium" : "border-transparent text-muted-foreground hover:text-foreground"
              }`}
            >
              {{ view: "表示", edit: "編集", permissions: "権限", raw: "Raw テキスト" }[t]}
            </button>
          ))}
          <div className="ml-auto flex items-center gap-1 pb-1">
            {item.source_path && (
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
                if (!confirm("この文書を削除しますか？")) return;
                try {
                  await deleteDocument(item.id);
                  toast.success("削除しました");
                  onUpdated();
                } catch { toast.error("削除失敗"); }
              }}
            >
              <Trash2 className="h-3.5 w-3.5 mr-1" />削除
            </Button>
          </div>
        </div>

        {/* Tab content */}
        <div className="flex-1 min-h-0 overflow-y-auto">
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
            <DocumentPreview docId={doc.id} fileType={doc.file_type} content={doc.content} mode="raw" />
          )}

          {tab === "edit" && doc && (
            <EditTab doc={doc} item={item} folders={folders} allTags={allTags} onSaved={onUpdated} onTagsChanged={onTagsChanged} />
          )}

          {tab === "permissions" && doc && (
            <PermissionsTab docId={item.id} doc={doc} />
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
  onSaved: () => void;
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
      await updateDocument(item.id, {
        title,
        summary,
        memo,
        searchable,
        ai_knowledge: aiKnowledge,
        folder_id: folderId || null,
        tag_ids: docTags.map((t) => t.id),
      });
      toast.success("保存しました");
      onSaved();
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
