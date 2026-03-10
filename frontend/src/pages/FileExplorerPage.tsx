import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import ReactMarkdown from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
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
  ChevronDown,
  ChevronRightIcon,
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
  FolderIcon,
  FolderOpen,
  FolderPlus,
  Plus,
  X,
  Tag as TagIcon,
  Pencil,
  Undo2,
  Download,
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
  getFolders,
  createFolder,
  updateFolder,
  deleteFolder,
  getTags,
  createTag,
  updateTag,
  deleteTag,
  getTrash,
  restoreFromTrash,
  purgeFromTrash,
  emptyTrash,
  type TrashItem,
  type DocumentListItem,
  type DocumentPermissionEntry,
  type Document,
  type User,
  type Role,
  type Folder,
  type TagInfo,
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

const TAG_COLORS = [
  "#ef4444", "#f97316", "#eab308", "#22c55e", "#06b6d4",
  "#3b82f6", "#8b5cf6", "#ec4899", "#6b7280",
];

interface FolderNode extends Folder {
  children: FolderNode[];
}

function buildFolderTree(folders: Folder[]): FolderNode[] {
  const map = new Map<string, FolderNode>();
  for (const f of folders) {
    map.set(f.id, { ...f, children: [] });
  }
  const roots: FolderNode[] = [];
  for (const node of map.values()) {
    if (node.parent_id && map.has(node.parent_id)) {
      map.get(node.parent_id)!.children.push(node);
    } else {
      roots.push(node);
    }
  }
  // Sort children alphabetically
  const sortChildren = (nodes: FolderNode[]) => {
    nodes.sort((a, b) => a.name.localeCompare(b.name));
    for (const n of nodes) sortChildren(n.children);
  };
  sortChildren(roots);
  return roots;
}

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

  // Folder state
  const [folders, setFolders] = useState<Folder[]>([]);
  const [allDocCount, setAllDocCount] = useState(0);
  const [activeFolderId, setActiveFolderId] = useState<string | null>(null); // null = all, "unfiled" = no folder
  const [newFolderOpen, setNewFolderOpen] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  const [newFolderParent, setNewFolderParent] = useState<string | null>(null);

  // Tag state
  const [allTags, setAllTags] = useState<TagInfo[]>([]);
  const [activeTag, setActiveTag] = useState<string | null>(null);
  const [newTagOpen, setNewTagOpen] = useState(false);
  const [newTagName, setNewTagName] = useState("");
  const [newTagColor, setNewTagColor] = useState(TAG_COLORS[0]);

  // Dialogs
  const [detailDoc, setDetailDoc] = useState<DocumentListItem | null>(null);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [bulkActionOpen, setBulkActionOpen] = useState<string | null>(null);

  // Trash
  const [showTrash, setShowTrash] = useState(false);
  const [trashItems, setTrashItems] = useState<TrashItem[]>([]);
  const [trashSelected, setTrashSelected] = useState<Set<string>>(new Set());

  // File drop upload
  const [fileDragOver, setFileDragOver] = useState(false);
  const [uploading, setUploading] = useState(false);
  const dragCounter = useRef(0);

  const loadFolders = useCallback(async () => {
    try {
      const f = await getFolders();
      setFolders(f);
      // Fetch total doc count for sidebar
      const countData = await getDocuments({ page: 1, per_page: 1 });
      setAllDocCount(countData.total);
    } catch { /* ignore */ }
  }, []);

  const loadTags = useCallback(async () => {
    try {
      setAllTags(await getTags());
    } catch { /* ignore */ }
  }, []);

  const loadTrash = useCallback(async () => {
    try {
      setTrashItems(await getTrash());
    } catch { /* ignore */ }
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params: Parameters<typeof getDocuments>[0] = {
        page,
        per_page: perPage,
        sort_by: sortBy,
        sort_dir: sortDir,
        file_type: filterType || undefined,
        q: filterQ || undefined,
      };
      if (activeFolderId === "unfiled") {
        params.unfiled = true;
      } else if (activeFolderId) {
        params.folder_id = activeFolderId;
      }
      if (activeTag) {
        params.tag = activeTag;
      }
      const data = await getDocuments(params);
      setItems(data.items);
      setTotal(data.total);
    } catch {
      toast.error("文書一覧の取得に失敗");
    } finally {
      setLoading(false);
    }
  }, [page, perPage, sortBy, sortDir, filterType, filterQ, activeFolderId, activeTag]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { loadFolders(); loadTags(); loadTrash(); }, []);

  const totalPages = Math.ceil(total / perPage);
  const folderTree = useMemo(() => buildFolderTree(folders), [folders]);
  const folderDocTotal = useMemo(() => folders.reduce((s, f) => s + f.document_count, 0), [folders]);
  const unfiledCount = Math.max(0, allDocCount - folderDocTotal);

  function handleSort(col: string) {
    if (sortBy === col) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else { setSortBy(col); setSortDir("desc"); }
    setPage(1);
  }

  function SortIcon({ col }: { col: string }) {
    if (sortBy !== col) return <ArrowUpDown className="h-3 w-3 ml-1 opacity-30" />;
    return sortDir === "asc" ? <ArrowUp className="h-3 w-3 ml-1" /> : <ArrowDown className="h-3 w-3 ml-1" />;
  }

  const lastClickedIdx = useRef<number | null>(null);

  function toggleSelect(id: string, e?: React.MouseEvent) {
    const idx = items.findIndex((i) => i.id === id);

    if (e?.shiftKey && lastClickedIdx.current !== null && idx !== -1) {
      // Shift+click: range select/deselect (Gmail-style)
      // The action matches what would happen to the clicked item
      const willSelect = !selected.has(id);
      const start = Math.min(lastClickedIdx.current, idx);
      const end = Math.max(lastClickedIdx.current, idx);
      setSelected((prev) => {
        const next = new Set(prev);
        for (let i = start; i <= end; i++) {
          if (willSelect) next.add(items[i].id);
          else next.delete(items[i].id);
        }
        return next;
      });
    } else {
      setSelected((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id); else next.add(id);
        return next;
      });
    }
    lastClickedIdx.current = idx;
  }

  function toggleSelectAll() {
    if (selected.size === items.length) setSelected(new Set());
    else setSelected(new Set(items.map((i) => i.id)));
  }

  async function handleToggleFlag(item: DocumentListItem, field: "searchable" | "ai_knowledge") {
    try {
      await updateDocument(item.id, { [field]: !item[field] });
      setItems((prev) => prev.map((i) => (i.id === item.id ? { ...i, [field]: !i[field] } : i)));
    } catch { toast.error("更新に失敗"); }
  }

  async function handleBulkAction(action: string, extra?: Record<string, unknown>) {
    try {
      const res = await bulkAction([...selected], action, undefined, extra);
      toast.success(`${res.processed}件${action === "delete" ? "ゴミ箱に移動しました" : "処理しました"}`);
      setSelected(new Set());
      setBulkActionOpen(null);
      load();
      loadFolders();
      loadTags();
      if (action === "delete") loadTrash();
    } catch { toast.error("処理に失敗しました"); }
  }

  // Drag & drop / bulk move: move documents to folders
  async function handleDropOnFolder(folderId: string | null, docIds: string[]) {
    if (docIds.length === 0) return;

    // Optimistic update: adjust folder counts immediately
    const movingItems = items.filter((i) => docIds.includes(i.id));
    const sourceFolderCounts = new Map<string, number>();
    for (const it of movingItems) {
      if (it.folder_id) {
        sourceFolderCounts.set(it.folder_id, (sourceFolderCounts.get(it.folder_id) || 0) + 1);
      }
    }
    setFolders((prev) =>
      prev.map((f) => {
        let count = f.document_count;
        if (sourceFolderCounts.has(f.id)) count -= sourceFolderCounts.get(f.id)!;
        if (f.id === folderId) count += docIds.length;
        return { ...f, document_count: Math.max(0, count) };
      })
    );
    // Optimistic update: update items in table
    setItems((prev) =>
      prev.map((i) =>
        docIds.includes(i.id)
          ? { ...i, folder_id: folderId, folder_name: folders.find((f) => f.id === folderId)?.name ?? null }
          : i
      )
    );

    try {
      const res = await bulkAction(docIds, "move_to_folder", undefined, { folder_id: folderId });
      toast.success(`${res.processed}件を移動しました`);
      setSelected(new Set());
      // Reload to get accurate data from server
      load();
      loadFolders();
    } catch {
      toast.error("移動に失敗しました");
      // Revert on error
      load();
      loadFolders();
    }
  }

  function handleDragStart(e: React.DragEvent, itemId: string) {
    // If the dragged item is in the selection, drag all selected; otherwise drag just the one
    const ids = selected.has(itemId) ? [...selected] : [itemId];
    e.dataTransfer.setData("application/x-doc-ids", JSON.stringify(ids));
    e.dataTransfer.effectAllowed = "move";
  }

  async function handleCreateFolder() {
    if (!newFolderName.trim()) return;
    try {
      await createFolder({ name: newFolderName.trim(), parent_id: newFolderParent });
      setNewFolderName("");
      setNewFolderParent(null);
      setNewFolderOpen(false);
      loadFolders();
    } catch { toast.error("フォルダ作成失敗"); }
  }

  async function handleCreateTag() {
    if (!newTagName.trim()) return;
    try {
      const tag = await createTag({ name: newTagName.trim(), color: newTagColor });
      setAllTags((prev) => [...prev, { ...tag, document_count: 0 } as TagInfo & { document_count?: number }].sort((a, b) => a.name.localeCompare(b.name)));
      setNewTagName("");
      setNewTagOpen(false);
    } catch { toast.error("タグ作成失敗"); }
  }

  function hasFiles(e: React.DragEvent) {
    return e.dataTransfer.types.includes("Files");
  }

  function handleFileDragEnter(e: React.DragEvent) {
    e.preventDefault();
    if (!hasFiles(e)) return;
    dragCounter.current++;
    if (dragCounter.current === 1) setFileDragOver(true);
  }

  function handleFileDragLeave(e: React.DragEvent) {
    e.preventDefault();
    if (!hasFiles(e)) return;
    dragCounter.current--;
    if (dragCounter.current <= 0) {
      dragCounter.current = 0;
      setFileDragOver(false);
    }
  }

  function handleFileDragOver(e: React.DragEvent) {
    e.preventDefault();
    if (hasFiles(e)) e.dataTransfer.dropEffect = "copy";
  }

  async function handleFileDrop(e: React.DragEvent) {
    e.preventDefault();
    dragCounter.current = 0;
    setFileDragOver(false);
    if (!hasFiles(e)) return;

    const files = Array.from(e.dataTransfer.files);
    if (files.length === 0) return;

    setUploading(true);
    let success = 0;
    let failed = 0;
    for (const file of files) {
      try {
        await uploadDocument(file);
        success++;
      } catch {
        failed++;
      }
    }
    setUploading(false);
    if (success > 0) toast.success(`${success}件アップロードしました`);
    if (failed > 0) toast.error(`${failed}件失敗しました`);
    if (success > 0) { load(); loadFolders(); }
  }

  return (
    <div
      className="max-w-[1600px] mx-auto p-4 flex gap-4 relative"
      onDragEnter={handleFileDragEnter}
      onDragLeave={handleFileDragLeave}
      onDragOver={handleFileDragOver}
      onDrop={handleFileDrop}
    >
      {/* File drop overlay */}
      {(fileDragOver || uploading) && (
        <div className="absolute inset-0 z-50 bg-background/80 backdrop-blur-sm flex items-center justify-center rounded-lg border-2 border-dashed border-primary m-4 pointer-events-none">
          <div className="text-center">
            <Upload className="h-12 w-12 text-primary mx-auto mb-3" />
            <p className="text-lg font-medium">{uploading ? "アップロード中..." : "ファイルをドロップしてアップロード"}</p>
            <p className="text-sm text-muted-foreground mt-1">.md, .txt, .pdf, .docx に対応</p>
          </div>
        </div>
      )}
      {/* Sidebar */}
      <div className="w-56 flex-shrink-0 space-y-4">
        {/* Folder tree */}
        <div>
          <div className="flex items-center justify-between mb-1">
            <h3 className="text-sm font-semibold text-muted-foreground">フォルダ</h3>
            <button onClick={() => setNewFolderOpen(true)} className="p-0.5 hover:bg-muted rounded" title="新しいフォルダ">
              <FolderPlus className="h-3.5 w-3.5 text-muted-foreground" />
            </button>
          </div>
          <div className="space-y-0.5">
            <button
              onClick={() => { setActiveFolderId(null); setPage(1); setShowTrash(false); }}
              className={`w-full text-left text-sm px-2 py-1 rounded flex items-center gap-1.5 ${activeFolderId === null && !showTrash ? "bg-primary/10 text-primary font-medium" : "hover:bg-muted"}`}
            >
              <FolderIcon className="h-3.5 w-3.5" />
              <span className="truncate">すべて</span>
              <span className="ml-auto text-xs text-muted-foreground">{allDocCount}</span>
            </button>
            <DropTarget folderId={null} onDrop={handleDropOnFolder} label="未整理" count={unfiledCount} isActive={activeFolderId === "unfiled" && !showTrash} onClick={() => { setActiveFolderId("unfiled"); setPage(1); setShowTrash(false); }} icon={<FileText className="h-3.5 w-3.5" />} />
            {folderTree.map((node) => (
              <FolderTreeItem
                key={node.id}
                node={node}
                activeFolderId={activeFolderId}
                onSelect={(id) => { setActiveFolderId(id); setPage(1); setShowTrash(false); }}
                onReload={() => { loadFolders(); load(); }}
                onDrop={handleDropOnFolder}
                allFolders={folders}
              />
            ))}
          </div>
        </div>

        <Separator />

        {/* Tags */}
        <div>
          <div className="flex items-center justify-between mb-1">
            <h3 className="text-sm font-semibold text-muted-foreground">タグ</h3>
            <button onClick={() => setNewTagOpen(true)} className="p-0.5 hover:bg-muted rounded" title="新しいタグ">
              <Plus className="h-3.5 w-3.5 text-muted-foreground" />
            </button>
          </div>
          <div className="space-y-0.5">
            {activeTag && (
              <button
                onClick={() => { setActiveTag(null); setPage(1); }}
                className="w-full text-left text-sm px-2 py-1 rounded flex items-center gap-1.5 hover:bg-muted text-muted-foreground"
              >
                <X className="h-3 w-3" />フィルタ解除
              </button>
            )}
            {allTags.map((tag) => (
              <SidebarTagItem
                key={tag.id}
                tag={tag}
                isActive={activeTag === tag.name}
                onSelect={() => { setActiveTag(activeTag === tag.name ? null : tag.name); setPage(1); setShowTrash(false); }}
                onDeleted={() => {
                  setAllTags((prev) => prev.filter((t) => t.id !== tag.id));
                  if (activeTag === tag.name) setActiveTag(null);
                  load();
                }}
                onRenamed={(updated) => {
                  setAllTags((prev) => prev.map((t) => t.id === updated.id ? updated : t));
                  if (activeTag === tag.name) setActiveTag(updated.name);
                  load();
                }}
              />
            ))}
          </div>
        </div>

        {/* Trash */}
        <Separator />
        <button
          onClick={() => { setShowTrash(true); loadTrash(); }}
          className={`w-full text-left text-sm px-2 py-1 rounded flex items-center gap-1.5 ${showTrash ? "bg-primary/10 text-primary font-medium" : "hover:bg-muted text-muted-foreground"}`}
        >
          <Trash2 className="h-3.5 w-3.5" />ゴミ箱
          {trashItems.length > 0 && (
            <span className="ml-auto text-xs text-muted-foreground">{trashItems.length}</span>
          )}
        </button>
      </div>

      {/* Main content */}
      <div className="flex-1 min-w-0 space-y-4">
        {/* Header */}
        <div className="flex items-center justify-between">
          <h1 className="text-xl font-bold">{showTrash ? "ゴミ箱" : "文書管理"}</h1>
          {showTrash ? (
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={() => { setShowTrash(false); setTrashSelected(new Set()); }}>
                <ChevronLeft className="h-4 w-4 mr-1" />戻る
              </Button>
              {trashItems.length > 0 && (
                <Button variant="destructive" size="sm" onClick={async () => {
                  if (!confirm("ゴミ箱を空にしますか？この操作は取り消せません。")) return;
                  try {
                    const res = await emptyTrash();
                    toast.success(`${res.purged}件を完全に削除しました`);
                    loadTrash();
                  } catch { toast.error("削除に失敗しました"); }
                }}>
                  <Trash2 className="h-4 w-4 mr-1" />ゴミ箱を空にする
                </Button>
              )}
            </div>
          ) : (
            <Button onClick={() => setUploadOpen(true)}>
              <Upload className="h-4 w-4 mr-2" />アップロード
            </Button>
          )}
        </div>

        {showTrash ? (
          /* Trash view */
          <div>
            {trashItems.length === 0 ? (
              <p className="text-sm text-muted-foreground py-8 text-center">ゴミ箱は空です</p>
            ) : (
              <>
                <div className="flex items-center gap-2 p-2 bg-muted rounded-lg mb-3">
                  <span className="text-sm font-medium w-20">{trashSelected.size > 0 ? `${trashSelected.size}件選択中` : "\u00A0"}</span>
                  <Button variant="outline" size="sm" disabled={trashSelected.size === 0} onClick={async () => {
                    try {
                      const res = await restoreFromTrash([...trashSelected]);
                      toast.success(`${res.restored}件を復元しました`);
                      setTrashSelected(new Set());
                      loadTrash();
                      load();
                      loadFolders();
                    } catch { toast.error("復元に失敗しました"); }
                  }}>
                    <Undo2 className="h-3.5 w-3.5 mr-1" />復元
                  </Button>
                  <Button variant="destructive" size="sm" disabled={trashSelected.size === 0} onClick={async () => {
                    if (!confirm("選択した文書を完全に削除しますか？この操作は取り消せません。")) return;
                    try {
                      const res = await purgeFromTrash([...trashSelected]);
                      toast.success(`${res.purged}件を完全に削除しました`);
                      setTrashSelected(new Set());
                      loadTrash();
                    } catch { toast.error("削除に失敗しました"); }
                  }}>
                    <Trash2 className="h-3.5 w-3.5 mr-1" />完全に削除
                  </Button>
                </div>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-10">
                        <input
                          type="checkbox"
                          checked={trashSelected.size === trashItems.length && trashItems.length > 0}
                          onChange={(e) => setTrashSelected(e.target.checked ? new Set(trashItems.map((t) => t.id)) : new Set())}
                        />
                      </TableHead>
                      <TableHead>タイトル</TableHead>
                      <TableHead className="w-20">種別</TableHead>
                      <TableHead className="w-36">削除日時</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {trashItems.map((t) => (
                      <TableRow key={t.id}>
                        <TableCell>
                          <input
                            type="checkbox"
                            checked={trashSelected.has(t.id)}
                            onChange={(e) => {
                              setTrashSelected((prev) => {
                                const next = new Set(prev);
                                e.target.checked ? next.add(t.id) : next.delete(t.id);
                                return next;
                              });
                            }}
                          />
                        </TableCell>
                        <TableCell className="text-sm">{t.title}</TableCell>
                        <TableCell><Badge variant="outline" className="text-[10px]">{t.file_type}</Badge></TableCell>
                        <TableCell className="text-xs text-muted-foreground">{formatDate(t.deleted_at)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </>
            )}
          </div>
        ) : (
        <>
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
          <span className="text-sm text-muted-foreground ml-auto">{total.toLocaleString()}件</span>
        </div>

        {/* Bulk actions — always visible */}
        <div className="flex items-center gap-2 p-2 bg-muted rounded-lg">
          <span className="text-sm font-medium w-20">{selected.size > 0 ? `${selected.size}件選択中` : "\u00A0"}</span>
          <Button variant="destructive" size="sm" disabled={selected.size === 0} onClick={() => setBulkActionOpen("delete")}>
            <Trash2 className="h-3.5 w-3.5 mr-1" />ゴミ箱に移動
          </Button>
          <Button variant="outline" size="sm" disabled={selected.size === 0} onClick={() => setBulkActionOpen("reindex")}>
            <RefreshCw className="h-3.5 w-3.5 mr-1" />ベクトル再構築
          </Button>
          <Button variant="outline" size="sm" disabled={selected.size === 0} onClick={() => setBulkActionOpen("permissions")}>
            <Shield className="h-3.5 w-3.5 mr-1" />権限変更
          </Button>
          <Button variant="outline" size="sm" disabled={selected.size === 0} onClick={() => setBulkActionOpen("move_folder")}>
            <FolderIcon className="h-3.5 w-3.5 mr-1" />フォルダ移動
          </Button>
          <Button variant="outline" size="sm" disabled={selected.size === 0} onClick={() => setBulkActionOpen("add_tags")}>
            <TagIcon className="h-3.5 w-3.5 mr-1" />タグ追加
          </Button>
          {selected.size > 0 && <Button variant="ghost" size="sm" onClick={() => setSelected(new Set())}>選択解除</Button>}
        </div>

        {/* Table */}
        <Card>
          <ScrollArea className="w-full">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-10 px-0 cursor-pointer select-none" onClick={toggleSelectAll}>
                    <div className="flex items-center justify-center px-3">
                      <input type="checkbox" checked={items.length > 0 && selected.size === items.length} readOnly className="pointer-events-none" />
                    </div>
                  </TableHead>
                  <TableHead className="cursor-pointer select-none" onClick={() => handleSort("title")}>
                    <span className="flex items-center">タイトル <SortIcon col="title" /></span>
                  </TableHead>
                  <TableHead className="w-16">種別</TableHead>
                  <TableHead className="w-14">チャンク</TableHead>
                  <TableHead className="w-24">登録者</TableHead>
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
                    draggable
                    onDragStart={(e) => handleDragStart(e, item.id)}
                    className={`cursor-pointer ${selected.has(item.id) ? "bg-muted/50" : "hover:bg-muted/30"}`}
                  >
                    <TableCell
                      className="cursor-pointer select-none px-0"
                      onClick={(e) => { e.stopPropagation(); toggleSelect(item.id, e); }}
                    >
                      <div className="flex items-center justify-center w-full h-full py-2 px-3">
                        <input type="checkbox" checked={selected.has(item.id)} readOnly className="pointer-events-none" />
                      </div>
                    </TableCell>
                    <TableCell onClick={() => setDetailDoc(item)}>
                      <span className="font-medium text-sm max-w-[400px] truncate block hover:underline">
                        {item.title}
                      </span>
                      <div className="flex items-center gap-1 mt-0.5 flex-wrap">
                        {item.folder_name && (
                          <span className="text-xs text-muted-foreground flex items-center gap-0.5">
                            <FolderIcon className="h-3 w-3" />{item.folder_name}
                          </span>
                        )}
                        {item.tags?.map((t) => (
                          <span
                            key={t.id}
                            className="inline-flex items-center text-xs px-1.5 py-0 rounded-full text-white"
                            style={{ backgroundColor: t.color || "#6b7280" }}
                          >
                            {t.name}
                          </span>
                        ))}
                        {item.memo && (
                          <span className="text-xs text-muted-foreground truncate max-w-[200px]">{item.memo}</span>
                        )}
                      </div>
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
                    <TableCell colSpan={7} className="text-center py-8 text-muted-foreground">
                      文書がありません
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </ScrollArea>
        </Card>

        {/* Pagination — always visible */}
        <div className="flex items-center justify-center gap-2 py-3 border-t">
          <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>
            <ChevronLeft className="h-4 w-4" />
          </Button>
          {Array.from({ length: totalPages }, (_, i) => i + 1)
            .filter((p) => p === 1 || p === totalPages || Math.abs(p - page) <= 2)
            .reduce<(number | "...")[]>((acc, p, idx, arr) => {
              if (idx > 0 && p - (arr[idx - 1] as number) > 1) acc.push("...");
              acc.push(p);
              return acc;
            }, [])
            .map((item, idx) =>
              item === "..." ? (
                <span key={`ellipsis-${idx}`} className="px-1 text-muted-foreground">…</span>
              ) : (
                <Button
                  key={item}
                  variant={item === page ? "default" : "outline"}
                  size="sm"
                  className="min-w-[36px]"
                  onClick={() => setPage(item as number)}
                >
                  {item}
                </Button>
              ),
            )}
          <Button variant="outline" size="sm" disabled={page >= totalPages} onClick={() => setPage(page + 1)}>
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
        </>
        )}
      </div>

      {/* Detail Modal */}
      <DocumentDetailModal
        item={detailDoc}
        folders={folders}
        allTags={allTags}
        onClose={() => setDetailDoc(null)}
        onUpdated={() => { setDetailDoc(null); load(); loadFolders(); loadTags(); }}
        onTagsChanged={loadTags}
      />

      {/* Bulk action confirms */}
      <Dialog open={bulkActionOpen === "delete"} onOpenChange={() => setBulkActionOpen(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>ゴミ箱に移動</DialogTitle>
            <DialogDescription>{selected.size}件の文書をゴミ箱に移動します。ゴミ箱から復元できます。</DialogDescription>
          </DialogHeader>
          <DialogFooter showCloseButton>
            <Button variant="destructive" onClick={() => { handleBulkAction("delete"); loadTrash(); }}>ゴミ箱に移動</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={bulkActionOpen === "reindex"} onOpenChange={() => setBulkActionOpen(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>一括ベクトル再構築</DialogTitle>
            <DialogDescription>{selected.size}件の文書のベクトルデータを再構築します。</DialogDescription>
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

      <BulkFolderDialog
        open={bulkActionOpen === "move_folder"}
        folders={folders}
        selectedIds={[...selected]}
        onClose={() => setBulkActionOpen(null)}
        onMove={(folderId) => {
          setBulkActionOpen(null);
          handleDropOnFolder(folderId, [...selected]);
        }}
      />

      <BulkTagDialog
        open={bulkActionOpen === "add_tags"}
        allTags={allTags}
        selectedIds={[...selected]}
        onClose={() => setBulkActionOpen(null)}
        onDone={() => { setBulkActionOpen(null); setSelected(new Set()); load(); loadTags(); }}
      />

      {/* New Folder Dialog */}
      <Dialog open={newFolderOpen} onOpenChange={() => setNewFolderOpen(false)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>新しいフォルダ</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <Input placeholder="フォルダ名" value={newFolderName} onChange={(e) => setNewFolderName(e.target.value)} autoFocus />
            <select
              value={newFolderParent ?? ""}
              onChange={(e) => setNewFolderParent(e.target.value || null)}
              className="w-full h-9 rounded-md border bg-background px-3 text-sm"
            >
              <option value="">ルート（トップレベル）</option>
              {folders.map((f) => (
                <option key={f.id} value={f.id}>{f.name}</option>
              ))}
            </select>
          </div>
          <DialogFooter showCloseButton>
            <Button onClick={handleCreateFolder} disabled={!newFolderName.trim()}>作成</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* New Tag Dialog */}
      <Dialog open={newTagOpen} onOpenChange={() => setNewTagOpen(false)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>新しいタグ</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <Input placeholder="タグ名" value={newTagName} onChange={(e) => setNewTagName(e.target.value)} autoFocus />
            <div className="flex items-center gap-2">
              <span className="text-sm text-muted-foreground">色:</span>
              {TAG_COLORS.map((c) => (
                <button
                  key={c}
                  onClick={() => setNewTagColor(c)}
                  className={`w-6 h-6 rounded-full border-2 transition-colors ${newTagColor === c ? "border-foreground" : "border-transparent"}`}
                  style={{ backgroundColor: c }}
                />
              ))}
            </div>
          </div>
          <DialogFooter showCloseButton>
            <Button onClick={handleCreateTag} disabled={!newTagName.trim()}>作成</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Upload Dialog */}
      <UploadDialog
        open={uploadOpen}
        folders={folders}
        activeFolderId={activeFolderId}
        onClose={() => setUploadOpen(false)}
        onUploaded={() => { setUploadOpen(false); load(); loadFolders(); }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sidebar Tag Item (with rename / delete)
// ---------------------------------------------------------------------------

function SidebarTagItem({
  tag,
  isActive,
  onSelect,
  onDeleted,
  onRenamed,
}: {
  tag: TagInfo & { document_count?: number };
  isActive: boolean;
  onSelect: () => void;
  onDeleted: () => void;
  onRenamed: (updated: TagInfo) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState(tag.name);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  async function handleRename() {
    if (!editName.trim() || editName === tag.name) { setEditing(false); return; }
    try {
      const updated = await updateTag(tag.id, { name: editName.trim() });
      onRenamed(updated);
    } catch { toast.error("リネーム失敗"); }
    setEditing(false);
  }

  return (
    <div className={`group flex items-center text-sm rounded ${isActive ? "bg-primary/10 font-medium" : "hover:bg-muted"}`}>
      {editing ? (
        <input
          ref={inputRef}
          value={editName}
          onChange={(e) => setEditName(e.target.value)}
          onBlur={handleRename}
          onKeyDown={(e) => { if (e.key === "Enter") handleRename(); if (e.key === "Escape") setEditing(false); }}
          className="flex-1 text-sm bg-background border rounded px-2 py-0.5 mx-1"
        />
      ) : (
        <>
          <button onClick={onSelect} className="flex items-center gap-1 flex-1 min-w-0 px-2 py-1">
            <span className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ backgroundColor: tag.color || "#6b7280" }} />
            <span className="truncate">{tag.name}</span>
            <span className="text-xs text-muted-foreground ml-auto">{tag.document_count ?? ""}</span>
          </button>
          <div className="hidden group-hover:flex items-center gap-0.5 mr-0.5">
            <button
              onClick={(e) => { e.stopPropagation(); setEditName(tag.name); setEditing(true); }}
              className="p-0.5 hover:bg-muted rounded" title="リネーム"
            >
              <Pencil className="h-3 w-3 text-muted-foreground" />
            </button>
            <button
              onClick={async (e) => {
                e.stopPropagation();
                if (!confirm(`タグ「${tag.name}」を削除しますか？`)) return;
                try {
                  await deleteTag(tag.id);
                  onDeleted();
                } catch { toast.error("タグ削除失敗"); }
              }}
              className="p-0.5 hover:bg-muted rounded" title="削除"
            >
              <Trash2 className="h-3 w-3 text-destructive" />
            </button>
          </div>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Drop Target (for "未整理" and similar simple items)
// ---------------------------------------------------------------------------

function DropTarget({
  folderId,
  onDrop,
  label,
  count,
  isActive,
  onClick,
  icon,
}: {
  folderId: string | null;
  onDrop: (folderId: string | null, docIds: string[]) => void;
  label: string;
  count?: number;
  isActive: boolean;
  onClick: () => void;
  icon: React.ReactNode;
}) {
  const [dragOver, setDragOver] = useState(false);

  return (
    <button
      onClick={onClick}
      onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; setDragOver(true); }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        try {
          const ids: string[] = JSON.parse(e.dataTransfer.getData("application/x-doc-ids"));
          if (ids.length > 0) onDrop(folderId, ids);
        } catch { /* ignore */ }
      }}
      className={`w-full text-left text-sm px-2 py-1 rounded flex items-center gap-1.5 transition-colors ${
        dragOver ? "bg-primary/20 ring-2 ring-primary/40" : isActive ? "bg-primary/10 text-primary font-medium" : "hover:bg-muted"
      }`}
    >
      {icon}
      <span className="truncate">{label}</span>
      {count != null && <span className="ml-auto text-xs text-muted-foreground">{count}</span>}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Folder Tree Item (recursive, with drop target)
// ---------------------------------------------------------------------------

function FolderTreeItem({
  node,
  activeFolderId,
  onSelect,
  onReload,
  onDrop,
  allFolders,
  depth = 0,
}: {
  node: FolderNode;
  activeFolderId: string | null;
  onSelect: (id: string) => void;
  onReload: () => void;
  onDrop: (folderId: string | null, docIds: string[]) => void;
  allFolders: Folder[];
  depth?: number;
}) {
  const [expanded, setExpanded] = useState(depth < 2);
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState(node.name);
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const isActive = activeFolderId === node.id;
  const hasChildren = node.children.length > 0;

  async function handleRename() {
    if (!editName.trim() || editName === node.name) { setEditing(false); return; }
    try {
      await updateFolder(node.id, { name: editName.trim() });
      onReload();
    } catch { toast.error("リネーム失敗"); }
    setEditing(false);
  }

  async function handleDelete() {
    if (!confirm(`フォルダ「${node.name}」を削除しますか？中の文書は未整理に移動します。`)) return;
    try {
      await deleteFolder(node.id);
      onReload();
    } catch { toast.error("削除失敗"); }
  }

  function handleDragOver(e: React.DragEvent) {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setDragOver(true);
  }

  function handleDragLeave() {
    setDragOver(false);
  }

  function handleDropOnThis(e: React.DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);
    try {
      const ids: string[] = JSON.parse(e.dataTransfer.getData("application/x-doc-ids"));
      if (ids.length > 0) onDrop(node.id, ids);
    } catch { /* ignore */ }
  }

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  return (
    <div>
      <div
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDropOnThis}
        className={`group flex items-center gap-0.5 text-sm rounded py-0.5 pr-2 transition-colors ${
          dragOver ? "bg-primary/20 ring-2 ring-primary/40" : isActive ? "bg-primary/10 text-primary font-medium" : "hover:bg-muted"
        }`}
        style={{ paddingLeft: `${depth * 12 + 2}px` }}
      >
        <button
          onClick={() => hasChildren && setExpanded(!expanded)}
          className={`p-0.5 ${hasChildren ? "" : "invisible"}`}
        >
          {expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRightIcon className="h-3 w-3" />}
        </button>
        {editing ? (
          <input
            ref={inputRef}
            value={editName}
            onChange={(e) => setEditName(e.target.value)}
            onBlur={handleRename}
            onKeyDown={(e) => { if (e.key === "Enter") handleRename(); if (e.key === "Escape") setEditing(false); }}
            className="flex-1 text-sm bg-background border rounded px-1 py-0"
          />
        ) : (
          <>
            <button onClick={() => onSelect(node.id)} className="flex items-center gap-1 flex-1 truncate text-left">
              {isActive || dragOver ? <FolderOpen className="h-3.5 w-3.5 flex-shrink-0" /> : <FolderIcon className="h-3.5 w-3.5 flex-shrink-0" />}
              <span className="truncate">{node.name}</span>
              {node.document_count > 0 && (
                <span className="text-xs text-muted-foreground ml-auto">{node.document_count}</span>
              )}
            </button>
            <div className="hidden group-hover:flex items-center gap-0.5 ml-auto">
              <button onClick={() => { setEditName(node.name); setEditing(true); }} className="p-0.5 hover:bg-muted rounded" title="リネーム">
                <Pencil className="h-3 w-3 text-muted-foreground" />
              </button>
              <button onClick={handleDelete} className="p-0.5 hover:bg-muted rounded" title="削除">
                <Trash2 className="h-3 w-3 text-destructive" />
              </button>
            </div>
          </>
        )}
      </div>
      {expanded && node.children.map((child) => (
        <FolderTreeItem
          key={child.id}
          node={child}
          activeFolderId={activeFolderId}
          onSelect={onSelect}
          onReload={onReload}
          onDrop={onDrop}
          allFolders={allFolders}
          depth={depth + 1}
        />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Document Detail Modal
// ---------------------------------------------------------------------------

function DocumentDetailModal({
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
            <div className="space-y-3">
              {doc.memo && (
                <div className="text-sm text-muted-foreground bg-muted rounded-md px-3 py-2">{doc.memo}</div>
              )}
              <div className="prose dark:prose-invert max-w-none p-1">
                <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]}>{doc.content}</ReactMarkdown>
              </div>
            </div>
          )}

          {tab === "edit" && doc && (
            <EditTab doc={doc} item={item} folders={folders} allTags={allTags} onSaved={onUpdated} onTagsChanged={onTagsChanged} />
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
  const [memo, setMemo] = useState(doc.memo ?? "");
  const [isPublic, setIsPublic] = useState(doc.is_public);
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
        memo,
        is_public: isPublic,
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
// Permissions Tab
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
          <p className="text-xs text-muted-foreground mt-1">adminロールのユーザーは全文書にアクセス可能です</p>
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
                  <TableCell className="text-xs text-muted-foreground">{user?.roles?.[0] ?? "-"}</TableCell>
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
              <option key={u.id} value={u.id}>{u.username}{u.roles?.[0] ? ` (${u.roles[0]})` : ""}</option>
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
          <DialogDescription>{selectedIds.length}件の文書に同じ権限を設定します。</DialogDescription>
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
// Bulk Folder Move Dialog
// ---------------------------------------------------------------------------

function BulkFolderDialog({
  open,
  folders,
  selectedIds,
  onClose,
  onMove,
}: {
  open: boolean;
  folders: Folder[];
  selectedIds: string[];
  onClose: () => void;
  onMove: (folderId: string | null) => void;
}) {
  const [targetFolder, setTargetFolder] = useState("");

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

function BulkTagDialog({
  open,
  allTags,
  selectedIds,
  onClose,
  onDone,
}: {
  open: boolean;
  allTags: TagInfo[];
  selectedIds: string[];
  onClose: () => void;
  onDone: () => void;
}) {
  const [selectedTags, setSelectedTags] = useState<Set<number>>(new Set());
  const [saving, setSaving] = useState(false);

  function toggleTag(id: number) {
    setSelectedTags((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  async function handleSave() {
    if (selectedTags.size === 0) return;
    setSaving(true);
    try {
      const res = await bulkAction(selectedIds, "add_tags", undefined, { tag_ids: [...selectedTags] });
      toast.success(`${res.processed}件にタグを追加しました`);
      setSelectedTags(new Set());
      onDone();
    } catch { toast.error("タグ追加失敗"); }
    finally { setSaving(false); }
  }

  return (
    <Dialog open={open} onOpenChange={() => onClose()}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>一括タグ追加</DialogTitle>
          <DialogDescription>{selectedIds.length}件の文書にタグを追加します。</DialogDescription>
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
          <Button onClick={handleSave} disabled={saving || selectedTags.size === 0}>追加する</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Upload Dialog
// ---------------------------------------------------------------------------

function UploadDialog({
  open,
  onClose,
  onUploaded,
}: {
  open: boolean;
  folders: Folder[];
  activeFolderId: string | null;
  onClose: () => void;
  onUploaded: () => void;
}) {
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
