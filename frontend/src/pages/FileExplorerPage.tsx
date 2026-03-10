import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import ReactMarkdown from "react-markdown";
import remarkBreaks from "remark-breaks";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import {
  ChevronLeft,
  ChevronRight,
  ArrowUpDown,
  ArrowUp,
  ArrowDown,
  Upload,
  Trash2,
  Shield,
  RefreshCw,
  Search as SearchIcon,
  FileText,
  Brain,
} from "lucide-react";
import {
  getDocuments,
  getDocument,
  updateDocument,
  uploadDocument,
  deleteDocument,
  bulkAction,
  getDocumentPermissions,
  setDocumentPermissions,
  reindexDocument,
  getUsers,
  getRoles,
  type DocumentListItem,
  type DocumentPermissionEntry,
  type Document,
  type User,
  type Role,
} from "@/lib/api";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatDate(d: string): string {
  return new Date(d).toLocaleDateString("ja-JP", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
}

const FILE_TYPES = ["", "md", "pdf", "docx"] as const;

// ---------------------------------------------------------------------------
// Main Component
// ---------------------------------------------------------------------------

export function FileExplorerPage() {
  const [items, setItems] = useState<DocumentListItem[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [perPage] = useState(30);
  const [sortBy, setSortBy] = useState("updated_at");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [filterType, setFilterType] = useState("");
  const [filterQ, setFilterQ] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);

  // Dialogs
  const [detailDoc, setDetailDoc] = useState<DocumentListItem | null>(null);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [bulkActionOpen, setBulkActionOpen] = useState<string | null>(null); // "delete"|"reindex"|"permissions"

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await getDocuments({
        page,
        per_page: perPage,
        sort_by: sortBy,
        sort_dir: sortDir,
        file_type: filterType || undefined,
        q: filterQ || undefined,
      });
      setItems(data.items);
      setTotal(data.total);
    } catch {
      toast.error("文書一覧の取得に失敗");
    } finally {
      setLoading(false);
    }
  }, [page, perPage, sortBy, sortDir, filterType, filterQ]);

  useEffect(() => {
    load();
  }, [load]);

  const totalPages = Math.ceil(total / perPage);

  function handleSort(col: string) {
    if (sortBy === col) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortBy(col);
      setSortDir("desc");
    }
    setPage(1);
  }

  function SortIcon({ col }: { col: string }) {
    if (sortBy !== col) return <ArrowUpDown className="h-3 w-3 ml-1 opacity-30" />;
    return sortDir === "asc" ? <ArrowUp className="h-3 w-3 ml-1" /> : <ArrowDown className="h-3 w-3 ml-1" />;
  }

  function toggleSelect(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleSelectAll() {
    if (selected.size === items.length) setSelected(new Set());
    else setSelected(new Set(items.map((i) => i.id)));
  }

  async function handleToggleFlag(item: DocumentListItem, field: "searchable" | "ai_knowledge") {
    try {
      await updateDocument(item.id, { [field]: !item[field] });
      setItems((prev) => prev.map((i) => (i.id === item.id ? { ...i, [field]: !i[field] } : i)));
    } catch {
      toast.error("更新に失敗");
    }
  }

  async function handleBulkAction(action: string) {
    try {
      const res = await bulkAction([...selected], action);
      toast.success(`${res.processed}件処理しました`);
      setSelected(new Set());
      setBulkActionOpen(null);
      load();
    } catch {
      toast.error("処理に失敗しました");
    }
  }

  return (
    <div className="max-w-7xl mx-auto p-4 space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold">文書管理</h1>
        <Button onClick={() => setUploadOpen(true)}>
          <Upload className="h-4 w-4 mr-2" />
          アップロード
        </Button>
      </div>

      {/* Filters */}
      <div className="flex items-center gap-3">
        <form
          className="relative flex-1 max-w-sm"
          onSubmit={(e) => { e.preventDefault(); setFilterQ(searchInput); setPage(1); }}
        >
          <SearchIcon className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="タイトル検索..."
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            className="pl-9 h-9 text-sm"
          />
        </form>
        <select
          value={filterType}
          onChange={(e) => { setFilterType(e.target.value); setPage(1); }}
          className="h-9 rounded-md border bg-background px-3 text-sm"
        >
          <option value="">すべての種別</option>
          {FILE_TYPES.filter(Boolean).map((t) => (
            <option key={t} value={t}>{t.toUpperCase()}</option>
          ))}
        </select>
        <span className="text-sm text-muted-foreground ml-auto">
          {total.toLocaleString()}件
        </span>
      </div>

      {/* Bulk actions */}
      {selected.size > 0 && (
        <div className="flex items-center gap-2 p-2 bg-muted rounded-lg">
          <span className="text-sm font-medium">{selected.size}件選択中</span>
          <Button variant="destructive" size="sm" onClick={() => setBulkActionOpen("delete")}>
            <Trash2 className="h-3.5 w-3.5 mr-1" />削除
          </Button>
          <Button variant="outline" size="sm" onClick={() => setBulkActionOpen("reindex")}>
            <RefreshCw className="h-3.5 w-3.5 mr-1" />ベクトル再構築
          </Button>
          <Button variant="outline" size="sm" onClick={() => setBulkActionOpen("permissions")}>
            <Shield className="h-3.5 w-3.5 mr-1" />権限変更
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setSelected(new Set())}>
            選択解除
          </Button>
        </div>
      )}

      {/* Table */}
      <Card>
        <ScrollArea className="w-full">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-10">
                  <input
                    type="checkbox"
                    checked={items.length > 0 && selected.size === items.length}
                    onChange={toggleSelectAll}
                  />
                </TableHead>
                <TableHead className="cursor-pointer select-none" onClick={() => handleSort("title")}>
                  <span className="flex items-center">タイトル <SortIcon col="title" /></span>
                </TableHead>
                <TableHead className="w-16">種別</TableHead>
                <TableHead className="w-14">チャンク</TableHead>
                <TableHead className="w-24">登録者</TableHead>
                <TableHead className="w-24">更新者</TableHead>
                <TableHead className="w-24 cursor-pointer select-none" onClick={() => handleSort("updated_at")}>
                  <span className="flex items-center">更新日 <SortIcon col="updated_at" /></span>
                </TableHead>
                <TableHead className="w-28 text-center">検索 / AI</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((item) => (
                <TableRow
                  key={item.id}
                  className={`cursor-pointer ${selected.has(item.id) ? "bg-muted/50" : "hover:bg-muted/30"}`}
                >
                  <TableCell onClick={(e) => e.stopPropagation()}>
                    <input
                      type="checkbox"
                      checked={selected.has(item.id)}
                      onChange={() => toggleSelect(item.id)}
                    />
                  </TableCell>
                  <TableCell onClick={() => setDetailDoc(item)}>
                    <span className="font-medium text-sm max-w-[300px] truncate block hover:underline">
                      {item.title}
                    </span>
                    {item.memo && (
                      <p className="text-xs text-muted-foreground truncate max-w-[300px]">{item.memo}</p>
                    )}
                  </TableCell>
                  <TableCell onClick={() => setDetailDoc(item)}>
                    <Badge variant="outline" className="text-xs">{item.file_type}</Badge>
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground" onClick={() => setDetailDoc(item)}>
                    {item.chunk_count}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground" onClick={() => setDetailDoc(item)}>
                    {item.created_by_name ?? "-"}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground" onClick={() => setDetailDoc(item)}>
                    {item.updated_by_name ?? "-"}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground" onClick={() => setDetailDoc(item)}>
                    {formatDate(item.updated_at)}
                  </TableCell>
                  <TableCell onClick={(e) => e.stopPropagation()}>
                    <div className="flex items-center justify-center gap-2">
                      <button
                        title={item.searchable ? "検索対象" : "検索除外"}
                        className={`p-1 rounded transition-colors ${item.searchable ? "text-primary" : "text-muted-foreground/30 hover:text-muted-foreground"}`}
                        onClick={() => handleToggleFlag(item, "searchable")}
                      >
                        <SearchIcon className="h-4 w-4" />
                      </button>
                      <button
                        title={item.ai_knowledge ? "AIナレッジ対象" : "AIナレッジ除外"}
                        className={`p-1 rounded transition-colors ${item.ai_knowledge ? "text-primary" : "text-muted-foreground/30 hover:text-muted-foreground"}`}
                        onClick={() => handleToggleFlag(item, "ai_knowledge")}
                      >
                        <Brain className="h-4 w-4" />
                      </button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
              {items.length === 0 && !loading && (
                <TableRow>
                  <TableCell colSpan={8} className="text-center py-8 text-muted-foreground">
                    文書がありません
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </ScrollArea>
      </Card>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-2">
          <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <span className="text-sm text-muted-foreground">{page} / {totalPages}</span>
          <Button variant="outline" size="sm" disabled={page >= totalPages} onClick={() => setPage(page + 1)}>
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      )}

      {/* Detail Modal */}
      <DocumentDetailModal
        item={detailDoc}
        onClose={() => setDetailDoc(null)}
        onUpdated={() => { setDetailDoc(null); load(); }}
      />

      {/* Bulk action confirms */}
      <Dialog open={bulkActionOpen === "delete"} onOpenChange={() => setBulkActionOpen(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>一括削除の確認</DialogTitle>
            <DialogDescription>{selected.size}件の文書を削除します。この操作は取り消せません。</DialogDescription>
          </DialogHeader>
          <DialogFooter showCloseButton>
            <Button variant="destructive" onClick={() => handleBulkAction("delete")}>削除する</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={bulkActionOpen === "reindex"} onOpenChange={() => setBulkActionOpen(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>一括ベクトル再構築</DialogTitle>
            <DialogDescription>{selected.size}件の文書のベクトルデータを再構築します。時間がかかる場合があります。</DialogDescription>
          </DialogHeader>
          <DialogFooter showCloseButton>
            <Button onClick={() => handleBulkAction("reindex")}>再構築する</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <BulkPermissionsDialog
        open={bulkActionOpen === "permissions"}
        selectedIds={[...selected]}
        onClose={() => setBulkActionOpen(null)}
        onDone={() => { setBulkActionOpen(null); setSelected(new Set()); load(); }}
      />

      {/* Upload Dialog */}
      <UploadDialog
        open={uploadOpen}
        onClose={() => setUploadOpen(false)}
        onUploaded={() => { setUploadOpen(false); load(); }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Document Detail Modal (replaces separate action buttons)
// ---------------------------------------------------------------------------

function DocumentDetailModal({
  item,
  onClose,
  onUpdated,
}: {
  item: DocumentListItem | null;
  onClose: () => void;
  onUpdated: () => void;
}) {
  const [doc, setDoc] = useState<Document | null>(null);
  const [tab, setTab] = useState<"view" | "edit" | "permissions">("view");
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
            {item.created_by_name && <span>登録: {item.created_by_name}</span>}
            {item.updated_by_name && <span>更新: {item.updated_by_name}</span>}
            <span>{formatDate(item.updated_at)}</span>
          </DialogDescription>
        </DialogHeader>

        {/* Tabs */}
        <div className="flex gap-1 border-b">
          {(["view", "edit", "permissions"] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`px-3 py-1.5 text-sm border-b-2 transition-colors ${
                tab === t ? "border-primary text-primary font-medium" : "border-transparent text-muted-foreground hover:text-foreground"
              }`}
            >
              {{ view: "表示", edit: "編集", permissions: "権限" }[t]}
            </button>
          ))}
          <div className="ml-auto flex items-center gap-1 pb-1">
            <Button
              variant="outline"
              size="sm"
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
              variant="destructive"
              size="sm"
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
            <div className="space-y-3">
              {doc.memo && (
                <div className="text-sm text-muted-foreground bg-muted rounded-md px-3 py-2">{doc.memo}</div>
              )}
              <div className="prose dark:prose-invert max-w-none p-1">
                <ReactMarkdown remarkPlugins={[remarkBreaks]}>{doc.content}</ReactMarkdown>
              </div>
            </div>
          )}

          {tab === "edit" && doc && (
            <EditTab doc={doc} item={item} onSaved={onUpdated} />
          )}

          {tab === "permissions" && (
            <PermissionsTab docId={item.id} docTitle={item.title} isPublic={item.is_public} />
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Edit Tab
// ---------------------------------------------------------------------------

function EditTab({ doc, item, onSaved }: { doc: Document; item: DocumentListItem; onSaved: () => void }) {
  const [title, setTitle] = useState(doc.title);
  const [memo, setMemo] = useState(doc.memo ?? "");
  const [isPublic, setIsPublic] = useState(doc.is_public);
  const [searchable, setSearchable] = useState(doc.searchable);
  const [aiKnowledge, setAiKnowledge] = useState(doc.ai_knowledge);
  const [saving, setSaving] = useState(false);

  async function handleSave() {
    setSaving(true);
    try {
      await updateDocument(item.id, { title, memo, is_public: isPublic, searchable, ai_knowledge: aiKnowledge });
      toast.success("保存しました");
      onSaved();
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
        <label className="text-sm font-medium">メモ</label>
        <Textarea value={memo} onChange={(e) => setMemo(e.target.value)} placeholder="メモ..." rows={3} />
      </div>
      <div className="flex flex-col gap-2">
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={isPublic} onChange={(e) => setIsPublic(e.target.checked)} />
          公開（全ユーザーが閲覧可能）
        </label>
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
// Permissions Tab (integrated with roles)
// ---------------------------------------------------------------------------

function PermissionsTab({ docId, isPublic }: { docId: string; docTitle: string; isPublic: boolean }) {
  const [perms, setPerms] = useState<DocumentPermissionEntry[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [roles, setRoles] = useState<Role[]>([]);
  const [addUserId, setAddUserId] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    getDocumentPermissions(docId).then(setPerms).catch(() => {});
    getUsers().then(setUsers).catch(() => {});
    getRoles().then(setRoles).catch(() => {});
  }, [docId]);

  function handleToggle(userId: string, field: "can_read" | "can_write") {
    setPerms((prev) => prev.map((p) => (p.user_id === userId ? { ...p, [field]: !p[field] } : p)));
  }

  function handleAdd() {
    if (!addUserId || perms.find((p) => p.user_id === addUserId)) return;
    const user = users.find((u) => String(u.id) === addUserId);
    setPerms((prev) => [...prev, { user_id: addUserId, username: user?.username ?? null, can_read: true, can_write: false }]);
    setAddUserId("");
  }

  function handleRemove(userId: string) {
    setPerms((prev) => prev.filter((p) => p.user_id !== userId));
  }

  async function handleSave() {
    setSaving(true);
    try {
      await setDocumentPermissions(docId, perms);
      toast.success("権限を保存しました");
    } catch { toast.error("保存失敗"); }
    finally { setSaving(false); }
  }

  // Group users by role for display
  const userRoleMap = new Map<number, string>();
  for (const u of users) {
    if (u.role) userRoleMap.set(u.id, u.role);
  }

  const availableUsers = users.filter((u) => !perms.find((p) => p.user_id === String(u.id)));

  return (
    <div className="space-y-4 p-1">
      <div className="flex items-center gap-2">
        <Badge>{isPublic ? "公開" : "非公開"}</Badge>
        <span className="text-xs text-muted-foreground">
          {isPublic ? "全ユーザーが閲覧可能" : "権限のあるユーザーのみ"}
        </span>
      </div>

      {roles.length > 0 && (
        <div>
          <h4 className="text-sm font-medium mb-1">ロール</h4>
          <div className="flex flex-wrap gap-2">
            {roles.map((r) => (
              <Badge key={r.id} variant="outline" className="text-xs">
                {r.name}: {r.permissions.join(", ") || "権限なし"}
              </Badge>
            ))}
          </div>
          <p className="text-xs text-muted-foreground mt-1">
            adminロールのユーザーは全文書にアクセス可能です
          </p>
        </div>
      )}

      <Separator />

      <h4 className="text-sm font-medium">個別権限</h4>

      {perms.length > 0 && (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>ユーザー</TableHead>
              <TableHead className="w-16">ロール</TableHead>
              <TableHead className="w-16 text-center">閲覧</TableHead>
              <TableHead className="w-16 text-center">編集</TableHead>
              <TableHead className="w-12" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {perms.map((p) => {
              const user = users.find((u) => String(u.id) === p.user_id);
              return (
                <TableRow key={p.user_id}>
                  <TableCell className="text-sm">{p.username ?? p.user_id}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{user?.role ?? "-"}</TableCell>
                  <TableCell className="text-center">
                    <input type="checkbox" checked={p.can_read} onChange={() => handleToggle(p.user_id, "can_read")} />
                  </TableCell>
                  <TableCell className="text-center">
                    <input type="checkbox" checked={p.can_write} onChange={() => handleToggle(p.user_id, "can_write")} />
                  </TableCell>
                  <TableCell>
                    <Button variant="ghost" size="icon-sm" onClick={() => handleRemove(p.user_id)}>
                      <Trash2 className="h-3.5 w-3.5 text-destructive" />
                    </Button>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}

      {availableUsers.length > 0 && (
        <div className="flex items-center gap-2">
          <select
            value={addUserId}
            onChange={(e) => setAddUserId(e.target.value)}
            className="h-9 flex-1 rounded-md border bg-background px-3 text-sm"
          >
            <option value="">ユーザーを追加...</option>
            {availableUsers.map((u) => (
              <option key={u.id} value={u.id}>{u.username}{u.role ? ` (${u.role})` : ""}</option>
            ))}
          </select>
          <Button size="sm" onClick={handleAdd} disabled={!addUserId}>追加</Button>
        </div>
      )}

      <Button onClick={handleSave} disabled={saving}>権限を保存</Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Bulk Permissions Dialog
// ---------------------------------------------------------------------------

function BulkPermissionsDialog({
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
  const [users, setUsers] = useState<User[]>([]);
  const [perms, setPerms] = useState<DocumentPermissionEntry[]>([]);
  const [addUserId, setAddUserId] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) getUsers().then(setUsers).catch(() => {});
  }, [open]);

  function handleAdd() {
    if (!addUserId || perms.find((p) => p.user_id === addUserId)) return;
    const user = users.find((u) => String(u.id) === addUserId);
    setPerms((prev) => [...prev, { user_id: addUserId, username: user?.username ?? null, can_read: true, can_write: false }]);
    setAddUserId("");
  }

  async function handleSave() {
    setSaving(true);
    try {
      const res = await bulkAction(selectedIds, "set_permissions", perms);
      toast.success(`${res.processed}件に権限を設定しました`);
      onDone();
    } catch { toast.error("保存失敗"); }
    finally { setSaving(false); }
  }

  const availableUsers = users.filter((u) => !perms.find((p) => p.user_id === String(u.id)));

  return (
    <Dialog open={open} onOpenChange={() => onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>一括権限変更</DialogTitle>
          <DialogDescription>{selectedIds.length}件の文書に同じ権限を設定します。既存の個別権限は上書きされます。</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          {perms.length > 0 && (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>ユーザー</TableHead>
                  <TableHead className="w-16 text-center">閲覧</TableHead>
                  <TableHead className="w-16 text-center">編集</TableHead>
                  <TableHead className="w-12" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {perms.map((p) => (
                  <TableRow key={p.user_id}>
                    <TableCell className="text-sm">{p.username ?? p.user_id}</TableCell>
                    <TableCell className="text-center">
                      <input type="checkbox" checked={p.can_read} onChange={() => setPerms((prev) => prev.map((x) => x.user_id === p.user_id ? { ...x, can_read: !x.can_read } : x))} />
                    </TableCell>
                    <TableCell className="text-center">
                      <input type="checkbox" checked={p.can_write} onChange={() => setPerms((prev) => prev.map((x) => x.user_id === p.user_id ? { ...x, can_write: !x.can_write } : x))} />
                    </TableCell>
                    <TableCell>
                      <Button variant="ghost" size="icon-sm" onClick={() => setPerms((prev) => prev.filter((x) => x.user_id !== p.user_id))}>
                        <Trash2 className="h-3.5 w-3.5 text-destructive" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
          {availableUsers.length > 0 && (
            <div className="flex items-center gap-2">
              <select value={addUserId} onChange={(e) => setAddUserId(e.target.value)} className="h-9 flex-1 rounded-md border bg-background px-3 text-sm">
                <option value="">ユーザーを追加...</option>
                {availableUsers.map((u) => (
                  <option key={u.id} value={u.id}>{u.username}</option>
                ))}
              </select>
              <Button size="sm" onClick={handleAdd} disabled={!addUserId}>追加</Button>
            </div>
          )}
        </div>
        <DialogFooter showCloseButton>
          <Button onClick={handleSave} disabled={saving}>適用</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Upload Dialog
// ---------------------------------------------------------------------------

function UploadDialog({ open, onClose, onUploaded }: { open: boolean; onClose: () => void; onUploaded: () => void }) {
  const [file, setFile] = useState<globalThis.File | null>(null);
  const [uploading, setUploading] = useState(false);

  async function handleUpload() {
    if (!file) return;
    setUploading(true);
    try {
      await uploadDocument(file);
      toast.success("アップロードしました");
      setFile(null);
      onUploaded();
    } catch { toast.error("アップロード失敗"); }
    finally { setUploading(false); }
  }

  return (
    <Dialog open={open} onOpenChange={() => onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>ファイルアップロード</DialogTitle>
          <DialogDescription>対応形式: Markdown, テキスト, PDF, Word</DialogDescription>
        </DialogHeader>
        <Input type="file" accept=".md,.txt,.pdf,.docx,.doc,.markdown" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        {file && <p className="text-sm text-muted-foreground">{file.name} ({formatBytes(file.size)})</p>}
        <DialogFooter showCloseButton>
          <Button onClick={handleUpload} disabled={!file || uploading}>
            <Upload className="h-4 w-4 mr-2" />アップロード
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
