import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import { ChatPanel } from "@/components/ChatPanel";
import { DocumentDetailModal } from "@/components/DocumentDetailModal";
import { DocumentContextMenu, type ContextMenuState } from "@/components/DocumentContextMenu";
import { BulkPermissionsDialog, BulkFolderDialog, BulkTagDialog, UploadDialog } from "@/components/BulkActionDialogs";
import { FolderPermissionsDialog } from "@/components/FolderPermissionsDialog";
import { ShareLinkDialog } from "@/components/ShareLinkDialog";
import { SidebarTagItem, DropTarget, TrashDropTarget, FolderTreeItem } from "@/components/FolderSidebarItems";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
import { Separator } from "@/components/ui/separator";
import {
  ChevronLeft,
  ArrowUpDown,
  ArrowUp,
  ArrowDown,
  Upload,
  Trash2,
  Shield,
  RefreshCw,
  Pencil,
  Link,
  Search as SearchIcon,
  FileText,
  Bot,
  FolderIcon,
  FolderPlus,
  Plus,
  X,
  Tag as TagIcon,
  Undo2,
  Sparkles,
  History,
  Pin,
  PinOff,
} from "lucide-react";
import {
  getDocuments,
  getFilterOptions,
  getShareEnabled,
  updateDocument,
  bulkAction,
  getFolders,
  createFolder,
  updateFolder,
  deleteFolder,
  getGroups,
  createTag,
  updateTag,
  getTags,
  getTrash,
  restoreFromTrash,
  purgeFromTrash,
  emptyTrash,
  checkDuplicates,
  searchDocumentsList,
  type TrashItem,
  type DocumentListItem,
  type Folder,
  type TagInfo,
  type Group,
  type FilterOptions,
} from "@/lib/api";
import {
  formatDate,
  formatBytes,
  buildFolderTree,
  uploadWithProgress,
  loadSearchHistory,
  addSearchHistory,
  togglePinSearchHistory,
  removeSearchHistory,
  TAG_COLORS,
  formatPermString,
  type FolderNode,
  type SearchHistoryEntry,
} from "@/lib/fileExplorerHelpers";

// ---------------------------------------------------------------------------
// Main Component
// ---------------------------------------------------------------------------

export function FileExplorerPage() {
  const [searchParams] = useSearchParams();
  const urlQ = searchParams.get("q") ?? "";
  const urlT = searchParams.get("_t") ?? "";
  const isSearching = !!urlQ;

  const [items, setItems] = useState<DocumentListItem[]>([]);
  const [total, setTotal] = useState(0);
  const pageRef = useRef(1);
  const [hasMore, setHasMore] = useState(true);
  const perPage = 30;
  const [sortBy, setSortBy] = useState("updated_at");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const sentinelRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const loadingRef = useRef(false);
  const [filterType, setFilterType] = useState("");
  const [filterDateFrom, setFilterDateFrom] = useState("");
  const [filterDateTo, setFilterDateTo] = useState("");
  const [filterCreatedBy, setFilterCreatedBy] = useState("");
  const [filterOptions, setFilterOptions] = useState<FilterOptions>({ file_types: [], creators: [] });
  const [searchTokens, setSearchTokens] = useState<string[]>([]);

  // AI chat panel visibility for small screens
  const [chatOpen, setChatOpen] = useState(true);
  const [aiStreaming, setAiStreaming] = useState(false);

  // Search history
  const navigate = useNavigate();
  const [searchHistory, setSearchHistory] = useState<SearchHistoryEntry[]>(loadSearchHistory);
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
  const [editingTag, setEditingTag] = useState<TagInfo | null>(null);
  const [editTagName, setEditTagName] = useState("");
  const [editTagColor, setEditTagColor] = useState("");

  // Dialogs
  const [detailDoc, setDetailDoc] = useState<DocumentListItem | null>(null);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [bulkActionOpen, setBulkActionOpen] = useState<string | null>(null);
  const [shareTarget, setShareTarget] = useState<DocumentListItem | null>(null);
  const [shareEnabled, setShareEnabled] = useState(false);

  // Context menu
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);

  // Rename dialog
  const [renameTarget, setRenameTarget] = useState<DocumentListItem | null>(null);
  const [renameValue, setRenameValue] = useState("");

  // Folder context menu
  const [folderCtx, setFolderCtx] = useState<{ x: number; y: number; node: FolderNode } | null>(null);
  const [folderRenameTarget, setFolderRenameTarget] = useState<FolderNode | null>(null);
  const [folderRenameValue, setFolderRenameValue] = useState("");
  const [folderPermsTarget, setFolderPermsTarget] = useState<FolderNode | null>(null);

  // Trash
  const [showTrash, setShowTrash] = useState(false);
  const [trashItems, setTrashItems] = useState<TrashItem[]>([]);
  const [trashSelected, setTrashSelected] = useState<Set<string>>(new Set());

  // Selecting a folder/tag while searching should clear the search query
  const selectFolder = useCallback((id: string | null) => {
    setActiveFolderId(id);

    setShowTrash(false);
    if (isSearching) {
      navigate("/", { replace: true });
    }
  }, [isSearching, navigate]);

  // File drop upload
  const [fileDragOver, setFileDragOver] = useState(false);
  const dragCounter = useRef(0);

  // Overwrite confirmation queue (shared by drag-drop and upload dialog)
  const [overwriteQueue, setOverwriteQueue] = useState<globalThis.File[]>([]);


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

  // Generation counter to discard stale responses after filter/search changes
  const loadGenRef = useRef(0);

  const load = useCallback(async (reset = false) => {
    if (reset) {
      // Reset must always proceed — cancel any in-flight append
      pageRef.current = 1;
      loadGenRef.current += 1;
      setHasMore(true);
      setItems([]);
      setSelected(new Set());
    } else if (loadingRef.current) {
      return;
    }
    const gen = loadGenRef.current;
    loadingRef.current = true;
    setLoading(true);
    try {
      const currentPage = pageRef.current;
      if (isSearching) {
        const searchParams: Parameters<typeof searchDocumentsList>[0] = {
          q: urlQ,
          page: currentPage,
          per_page: perPage,
          file_type: filterType || undefined,
        };
        if (activeFolderId === "unfiled") {
          searchParams.unfiled = true;
        } else if (activeFolderId) {
          searchParams.folder_id = activeFolderId;
        }
        if (activeTag) {
          searchParams.tag = activeTag;
        }
        const data = await searchDocumentsList(searchParams);
        if (gen !== loadGenRef.current) return; // stale
        setItems((prev) => currentPage === 1 ? data.items : [...prev, ...data.items]);
        setTotal(data.total);
        setHasMore(currentPage * perPage < data.total);
        setSearchTokens(data.tokens ?? []);
      } else {
        const params: Parameters<typeof getDocuments>[0] = {
          page: currentPage,
          per_page: perPage,
          sort_by: sortBy,
          sort_dir: sortDir,
          file_type: filterType || undefined,
          date_from: filterDateFrom || undefined,
          date_to: filterDateTo || undefined,
          created_by: filterCreatedBy || undefined,
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
        if (gen !== loadGenRef.current) return; // stale
        setItems((prev) => currentPage === 1 ? data.items : [...prev, ...data.items]);
        setTotal(data.total);
        setHasMore(currentPage * perPage < data.total);
        setSearchTokens([]);
      }
    } catch {
      toast.error("文書一覧の取得に失敗");
      setHasMore(false);
    } finally {
      setLoading(false);
      loadingRef.current = false;
    }
  }, [perPage, sortBy, sortDir, filterType, filterDateFrom, filterDateTo, filterCreatedBy, activeFolderId, activeTag, isSearching, urlQ]);

  useEffect(() => { load(true); }, [load]);
  // Re-trigger search when URL timestamp changes (re-search same query)
  useEffect(() => { if (urlT) load(true); }, [urlT]);
  useEffect(() => { loadFolders(); loadTags(); loadTrash(); getFilterOptions().then(setFilterOptions).catch(() => {}); getShareEnabled().then(setShareEnabled).catch(() => {}); }, []);
  // Reset when search query changes & record search history
  useEffect(() => {
    if (urlQ) setSearchHistory(addSearchHistory(urlQ));
  }, [urlQ]);

  // Infinite scroll via IntersectionObserver
  useEffect(() => {
    const sentinel = sentinelRef.current;
    const root = scrollContainerRef.current;
    if (!sentinel || !root) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && hasMore && !loadingRef.current) {
          pageRef.current += 1;
          load();
        }
      },
      { root, threshold: 0 },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hasMore, load, loading, showTrash]);
  // Keyboard shortcuts
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      // Ignore when typing in input/textarea/contenteditable
      const tag = (e.target as HTMLElement).tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || (e.target as HTMLElement).isContentEditable) return;
      // Ignore when a dialog is open
      if (detailDoc || bulkActionOpen || uploadOpen || newFolderOpen) return;
      if (showTrash) return;

      const isMod = e.metaKey || e.ctrlKey;

      // Ctrl/Cmd+A: select all
      if (isMod && e.key === "a") {
        e.preventDefault();
        setSelected(new Set(items.map((i) => i.id)));
        return;
      }

      // Escape: clear selection
      if (e.key === "Escape") {
        setSelected(new Set());
        return;
      }

      // Delete / Backspace: move selected to trash (no dialog)
      if ((e.key === "Delete" || e.key === "Backspace") && selected.size > 0) {
        e.preventDefault();
        const ids = [...selected];
        const tid = toast.loading(`${ids.length}件をゴミ箱に移動中...`);
        bulkAction(ids, "delete").then((res) => {
          toast.success(`${res.processed}件をゴミ箱に移動しました`, { id: tid });
          setSelected(new Set());
          setItems((prev) => prev.filter((i) => !ids.includes(i.id)));
          setTotal((prev) => Math.max(0, prev - ids.length));
          loadFolders();
          loadTrash();
        }).catch(() => toast.error("削除に失敗しました", { id: tid }));
        return;
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [items, selected, showTrash, detailDoc, bulkActionOpen, uploadOpen, newFolderOpen]);

  const folderTree = useMemo(() => buildFolderTree(folders), [folders]);

  // Build breadcrumb path for active folder (e.g. "親フォルダ > 子フォルダ")
  const folderBreadcrumb = useMemo(() => {
    if (!activeFolderId || activeFolderId === "unfiled") return null;
    const map = new Map(folders.map((f) => [f.id, f]));
    const parts: { id: string; name: string }[] = [];
    let cur = map.get(activeFolderId);
    while (cur) {
      parts.unshift({ id: cur.id, name: cur.name });
      cur = cur.parent_id ? map.get(cur.parent_id) : undefined;
    }
    return parts;
  }, [activeFolderId, folders]);
  const folderDocTotal = useMemo(() => folders.reduce((s, f) => s + f.document_count, 0), [folders]);
  const unfiledCount = Math.max(0, allDocCount - folderDocTotal);

  function handleSort(col: string) {
    if (sortBy === col) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else { setSortBy(col); setSortDir("desc"); }

  }

  function SortIcon({ col }: { col: string }) {
    if (sortBy !== col) return <ArrowUpDown className="h-3 w-3 ml-1 opacity-30" />;
    return sortDir === "asc" ? <ArrowUp className="h-3 w-3 ml-1" /> : <ArrowDown className="h-3 w-3 ml-1" />;
  }

  const lastClickedIdx = useRef<number | null>(null);


  function handleRowClick(item: DocumentListItem, e: React.MouseEvent) {
    toggleSelect(item.id, e);
  }

  function handleRowDoubleClick(item: DocumentListItem) {
    setDetailDoc(item);
  }

  function toggleSelect(id: string, e?: React.MouseEvent) {
    const idx = items.findIndex((i) => i.id === id);

    if (e?.shiftKey && lastClickedIdx.current !== null && idx !== -1) {
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

  async function handleToggleFlag(item: DocumentListItem, field: "searchable" | "ai_knowledge") {
    try {
      await updateDocument(item.id, { [field]: !item[field] });
      setItems((prev) => prev.map((i) => (i.id === item.id ? { ...i, [field]: !i[field] } : i)));
    } catch { toast.error("更新に失敗"); }
  }

  function handleContextMenu(e: React.MouseEvent, item: DocumentListItem) {
    e.preventDefault();
    if (!selected.has(item.id)) {
      setSelected(new Set([item.id]));
    }
    setContextMenu({ x: e.clientX, y: e.clientY, item });
  }

  // Number of items targeted by the context menu
  const contextCount = contextMenu ? Math.max(selected.size, 1) : 0;
  const isMultiContext = contextCount > 1;

  function contextAction(action: string) {
    const item = contextMenu?.item;
    if (!item) return;
    setContextMenu(null);

    // Ensure the item is selected for bulk action dialogs
    if (!selected.has(item.id)) {
      setSelected(new Set([item.id]));
    }

    switch (action) {
      case "rename":
        setRenameTarget(item);
        setRenameValue(item.title);
        break;
      case "share":
        if (shareEnabled) setShareTarget(item);
        break;
      case "download":
        {
          const targets = isMultiContext ? items.filter((i) => selected.has(i.id)) : [item];
          const token = localStorage.getItem("las_token");
          if (targets.length === 1) {
            // Single file download
            const t = targets[0];
            (async () => {
              try {
                const res = await fetch(`/api/documents/${t.id}/download`, {
                  headers: token ? { Authorization: `Bearer ${token}` } : {},
                });
                if (!res.ok) throw new Error();
                const blob = await res.blob();
                const disposition = res.headers.get("content-disposition");
                const filenameMatch = disposition?.match(/filename\*?=(?:UTF-8''|"?)([^";]+)/i);
                const filename = filenameMatch ? decodeURIComponent(filenameMatch[1]) : t.title;
                const a = document.createElement("a");
                a.href = URL.createObjectURL(blob);
                a.download = filename;
                a.click();
                URL.revokeObjectURL(a.href);
              } catch { toast.error(`ダウンロード失敗: ${t.title}`); }
            })();
          } else {
            // Multiple files: download as zip
            (async () => {
              try {
                const res = await fetch("/api/documents/download-zip", {
                  method: "POST",
                  headers: {
                    "Content-Type": "application/json",
                    ...(token ? { Authorization: `Bearer ${token}` } : {}),
                  },
                  body: JSON.stringify({ ids: targets.map((t) => t.id) }),
                });
                if (!res.ok) throw new Error();
                const blob = await res.blob();
                const a = document.createElement("a");
                a.href = URL.createObjectURL(blob);
                a.download = "documents.zip";
                a.click();
                URL.revokeObjectURL(a.href);
                toast.success(`${targets.length}件をZipでダウンロードしました`);
              } catch { toast.error("Zipダウンロードに失敗しました"); }
            })();
          }
        }
        break;
      case "move_folder":
        setBulkActionOpen("move_folder");
        break;
      case "permissions":
        setBulkActionOpen("permissions");
        break;
      case "add_tags":
        setBulkActionOpen("add_tags");
        break;
      case "reindex":
        setBulkActionOpen("reindex");
        break;
      case "toggle_searchable":
        if (isMultiContext) {
          handleBulkAction("set_searchable", { searchable: !item.searchable });
        } else {
          handleToggleFlag(item, "searchable");
        }
        break;
      case "toggle_ai":
        if (isMultiContext) {
          handleBulkAction("set_ai_knowledge", { ai_knowledge: !item.ai_knowledge });
        } else {
          handleToggleFlag(item, "ai_knowledge");
        }
        break;
      case "delete":
        setBulkActionOpen("delete");
        break;
    }
  }

  async function handleBulkAction(action: string, extra?: Record<string, unknown>) {
    const ids = [...selected];
    const label = action === "delete" ? "ゴミ箱に移動" : "処理";
    const tid = ids.length >= 10 ? toast.loading(`${ids.length}件を${label}中...`) : undefined;
    try {
      const res = await bulkAction(ids, action, extra);
      const msg = `${res.processed}件${action === "delete" ? "ゴミ箱に移動しました" : "処理しました"}`;
      tid ? toast.success(msg, { id: tid }) : toast.success(msg);
      setBulkActionOpen(null);

      // For toggle-style actions: optimistically update items & keep selection
      if (action === "set_searchable" && extra && "searchable" in extra) {
        const idSet = new Set(ids);
        setItems((prev) => prev.map((i) => idSet.has(i.id) ? { ...i, searchable: extra.searchable as boolean } : i));
      } else if (action === "set_ai_knowledge" && extra && "ai_knowledge" in extra) {
        const idSet = new Set(ids);
        setItems((prev) => prev.map((i) => idSet.has(i.id) ? { ...i, ai_knowledge: extra.ai_knowledge as boolean } : i));
      } else if (action === "delete") {
        // Optimistically remove deleted items from list
        setSelected(new Set());
        setItems((prev) => prev.filter((i) => !ids.includes(i.id)));
        setTotal((prev) => Math.max(0, prev - ids.length));
        loadFolders();
        loadTrash();
      } else {
        // For structural actions: clear selection & reload
        setSelected(new Set());
        load(true);
        loadFolders();
        loadTags();
      }
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
      const res = await bulkAction(docIds, "move_to_folder", { folder_id: folderId });
      toast.success(`${res.processed}件を移動しました`);
      setSelected(new Set());
      // Reload to get accurate data from server
      load(true);
      loadFolders();
    } catch {
      toast.error("移動に失敗しました");
      // Revert on error
      load(true);
      loadFolders();
    }
  }

  function handleDragStart(e: React.DragEvent, itemId: string) {
    // If the dragged item is in the selection, drag all selected; otherwise drag just the one
    const ids = selected.has(itemId) ? [...selected] : [itemId];
    e.dataTransfer.setData("application/x-doc-ids", JSON.stringify(ids));
    e.dataTransfer.effectAllowed = "move";
  }

  async function handleDropOnTrash(docIds: string[]) {
    if (docIds.length === 0) return;
    const tid = docIds.length >= 10 ? toast.loading(`${docIds.length}件をゴミ箱に移動中...`) : undefined;
    try {
      const res = await bulkAction(docIds, "delete");
      const msg = `${res.processed}件をゴミ箱に移動しました`;
      tid ? toast.success(msg, { id: tid }) : toast.success(msg);
      setSelected(new Set());
      load(true);
      loadFolders();
      loadTrash();
    } catch {
      tid ? toast.error("ゴミ箱への移動に失敗しました", { id: tid }) : toast.error("ゴミ箱への移動に失敗しました");
    }
  }

  function handleFolderContextMenu(e: React.MouseEvent, node: FolderNode) {
    e.preventDefault();
    setFolderCtx({ x: e.clientX, y: e.clientY, node });
  }

  async function handleFolderRename() {
    if (!folderRenameTarget || !folderRenameValue.trim()) return;
    try {
      await updateFolder(folderRenameTarget.id, { name: folderRenameValue.trim() });
      setFolderRenameTarget(null);
      loadFolders();
      toast.success("フォルダ名を変更しました");
    } catch { toast.error("フォルダ名変更に失敗"); }
  }

  async function handleFolderDelete(node: FolderNode) {
    if (!confirm(`フォルダ「${node.name}」を削除しますか？\n中のファイルはすべてゴミ箱に移動します。`)) return;
    try {
      await deleteFolder(node.id);
      if (activeFolderId === node.id) selectFolder(null);
      loadFolders();
      load(true);
      loadTrash();
      toast.success("フォルダを削除しました");
    } catch (e: any) {
      const msg = e?.message?.includes("403") ? "権限がありません" : "フォルダ削除に失敗";
      toast.error(msg);
    }
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

  const uploadFolderId = activeFolderId && activeFolderId !== "unfiled" ? activeFolderId : null;

  async function startUploadWithCheck(files: globalThis.File[]) {
    const dupTitles = await checkDuplicates(files.map((f) => f.name));
    const dupSet = new Set(dupTitles);
    const dups: globalThis.File[] = [];
    const nonDups: globalThis.File[] = [];
    for (const f of files) {
      if (dupSet.has(f.name)) dups.push(f);
      else nonDups.push(f);
    }
    const reload = () => { load(true); loadFolders(); };
    for (const f of nonDups) {
      uploadWithProgress(f, reload, uploadFolderId);
    }
    if (dups.length > 0) {
      setOverwriteQueue(dups);
    }
  }

  function handleFileDrop(e: React.DragEvent) {
    e.preventDefault();
    dragCounter.current = 0;
    setFileDragOver(false);
    if (!hasFiles(e)) return;

    const files = Array.from(e.dataTransfer.files);
    if (files.length === 0) return;
    startUploadWithCheck(files);
  }

  function handleOverwriteConfirm() {
    const file = overwriteQueue[0];
    if (file) {
      const reload = () => { load(true); loadFolders(); };
      uploadWithProgress(file, reload, uploadFolderId);
    }
    setOverwriteQueue((q) => q.slice(1));
  }

  function handleOverwriteSkip() {
    setOverwriteQueue((q) => q.slice(1));
  }

  function handleOverwriteCancel() {
    setOverwriteQueue([]);
  }

  return (
    <div
      className="p-4 flex gap-4 relative h-full overflow-hidden"
      onDragEnter={handleFileDragEnter}
      onDragLeave={handleFileDragLeave}
      onDragOver={handleFileDragOver}
      onDrop={handleFileDrop}
    >
      {/* File drop overlay */}
      {fileDragOver && (
        <div className="absolute inset-0 z-50 bg-background/80 backdrop-blur-sm flex items-center justify-center rounded-lg border-2 border-dashed border-primary m-4 pointer-events-none">
          <div className="text-center">
            <Upload className="h-12 w-12 text-primary mx-auto mb-3" />
            <p className="text-lg font-medium">ファイルをドロップしてアップロード</p>
            <p className="text-sm text-muted-foreground mt-1">.md, .txt, .pdf, .docx, .xlsx, .csv, .html, .pptx, 画像 に対応</p>
          </div>
        </div>
      )}
      {/* Sidebar */}
      <div className="w-56 flex-shrink-0 flex flex-col gap-4 overflow-y-auto">
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
              onClick={() => selectFolder(null)}
              className={`w-full text-left text-sm px-2 py-1 rounded flex items-center gap-1.5 ${activeFolderId === null && !showTrash ? "bg-primary/10 text-primary font-medium" : "hover:bg-muted"}`}
            >
              <FolderIcon className="h-3.5 w-3.5" />
              <span className="truncate">すべて</span>
              <span className="ml-auto text-xs text-muted-foreground">{allDocCount}</span>
            </button>
            <DropTarget folderId={null} onDrop={handleDropOnFolder} label="未整理" count={unfiledCount} isActive={activeFolderId === "unfiled" && !showTrash} onClick={() => selectFolder("unfiled")} icon={<FileText className="h-3.5 w-3.5" />} />
            {folderTree.map((node) => (
              <FolderTreeItem
                key={node.id}
                node={node}
                activeFolderId={activeFolderId}
                onSelect={(id) => selectFolder(id)}
                onDrop={handleDropOnFolder}
                onContextMenu={handleFolderContextMenu}
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
            {allTags.map((tag) => (
              <SidebarTagItem
                key={tag.id}
                tag={tag}
                isActive={activeTag === tag.name}
                onSelect={() => { setActiveTag(activeTag === tag.name ? null : tag.name); setShowTrash(false); if (isSearching) navigate("/", { replace: true }); }}
                onDeleted={() => {
                  setAllTags((prev) => prev.filter((t) => t.id !== tag.id));
                  if (activeTag === tag.name) setActiveTag(null);
                  load(true);
                }}
                onEdit={(t) => { setEditingTag(t); setEditTagName(t.name); setEditTagColor(t.color || "#6b7280"); }}
              />
            ))}
          </div>
        </div>

        {/* Search History */}
        {searchHistory.length > 0 && (
          <>
            <Separator />
            <div>
              <h3 className="text-sm font-semibold text-muted-foreground mb-1 flex items-center gap-1">
                <History className="h-3.5 w-3.5" />検索履歴
              </h3>
              <div className="space-y-0.5">
                {/* Pinned first, then unpinned (each group by recency) */}
                {[...searchHistory.filter((e) => e.pinned), ...searchHistory.filter((e) => !e.pinned)].map((entry) => (
                  <div
                    key={entry.query}
                    className={`group flex items-center text-sm rounded hover:bg-muted ${urlQ === entry.query ? "bg-primary/10 text-primary font-medium" : ""}`}
                  >
                    <button
                      onClick={() => navigate(`/?q=${encodeURIComponent(entry.query)}&_t=${Date.now()}`)}
                      className="flex items-center gap-1.5 flex-1 min-w-0 px-2 py-1"
                    >
                      {entry.pinned ? (
                        <Pin className="h-3 w-3 text-primary flex-shrink-0" />
                      ) : (
                        <SearchIcon className="h-3 w-3 text-muted-foreground flex-shrink-0" />
                      )}
                      <span className="truncate">{entry.query}</span>
                    </button>
                    <div className="hidden group-hover:flex items-center gap-0.5 mr-0.5">
                      <button
                        onClick={(e) => { e.stopPropagation(); setSearchHistory(togglePinSearchHistory(entry.query)); }}
                        className="p-0.5 hover:bg-muted rounded"
                        title={entry.pinned ? "ピン解除" : "ピン留め"}
                      >
                        {entry.pinned ? <PinOff className="h-3 w-3 text-muted-foreground" /> : <Pin className="h-3 w-3 text-muted-foreground" />}
                      </button>
                      <button
                        onClick={(e) => { e.stopPropagation(); setSearchHistory(removeSearchHistory(entry.query)); }}
                        className="p-0.5 hover:bg-muted rounded"
                        title="削除"
                      >
                        <X className="h-3 w-3 text-muted-foreground" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </>
        )}

        {/* Trash — always at bottom */}
        <div className="mt-auto pt-4">
        <Separator />
        <TrashDropTarget
          isActive={showTrash}
          count={trashItems.length}
          onClick={() => { setShowTrash(true); loadTrash(); }}
          onDrop={handleDropOnTrash}
        />
        </div>
      </div>

      {/* Main content */}
      <div className="flex-1 min-w-0 flex flex-col gap-4 overflow-hidden px-0.5 pb-0.5">
        {/* Header */}
        <div className="flex items-center justify-between">
          <h1 className="text-xl font-bold">
            {showTrash ? "ゴミ箱" : isSearching ? `検索結果: ${urlQ}` : folderBreadcrumb ? (
              folderBreadcrumb.map((seg, i) => (
                <span key={seg.id}>
                  {i > 0 && <span className="mx-1 text-muted-foreground font-normal">&gt;</span>}
                  <button
                    className={i === folderBreadcrumb.length - 1 ? "" : "text-muted-foreground font-normal hover:text-foreground hover:underline"}
                    onClick={() => selectFolder(seg.id)}
                  >
                    {seg.name}
                  </button>
                </span>
              ))
            ) : activeFolderId === "unfiled" ? "未整理" : "ドキュメント"}
          </h1>
          {showTrash ? (
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={() => { setShowTrash(false); setTrashSelected(new Set()); }}>
                <ChevronLeft className="h-4 w-4 mr-1" />戻る
              </Button>
              {trashItems.length > 0 && (
                <Button variant="destructive" size="sm" onClick={async () => {
                  if (!confirm("ゴミ箱を空にしますか？この操作は取り消せません。")) return;
                  const tid = toast.loading(`${trashItems.length}件を削除中...`);
                  try {
                    const res = await emptyTrash();
                    toast.success(`${res.purged}件を完全に削除しました`, { id: tid });
                    loadTrash();
                  } catch { toast.error("削除に失敗しました", { id: tid }); }
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
                      load(true);
                      loadFolders();
                    } catch { toast.error("復元に失敗しました"); }
                  }}>
                    <Undo2 className="h-3.5 w-3.5 mr-1" />復元
                  </Button>
                  <Button variant="destructive" size="sm" disabled={trashSelected.size === 0} onClick={async () => {
                    if (!confirm("選択した文書を完全に削除しますか？この操作は取り消せません。")) return;
                    const tid = toast.loading(`${trashSelected.size}件を削除中...`);
                    try {
                      const res = await purgeFromTrash([...trashSelected]);
                      toast.success(`${res.purged}件を完全に削除しました`, { id: tid });
                      setTrashSelected(new Set());
                      loadTrash();
                    } catch { toast.error("削除に失敗しました", { id: tid }); }
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
        <div className="flex items-center gap-2 flex-wrap">
          {isSearching && searchTokens.length > 0 && searchTokens.join(" ") !== urlQ && (
            <div className="flex items-center gap-1">
              <span className="text-xs text-muted-foreground">検索語:</span>
              {searchTokens.map((t) => (
                <Badge key={t} variant="secondary" className="text-xs font-normal">{t}</Badge>
              ))}
            </div>
          )}
          <select
            value={filterType}
            onChange={(e) => { setFilterType(e.target.value); }}
            className="h-8 rounded-md border bg-background px-2 text-xs"
          >
            <option value="">種別</option>
            {filterOptions.file_types.map((t) => (
              <option key={t} value={t}>{t.toUpperCase()}</option>
            ))}
          </select>
          <select
            value={filterCreatedBy}
            onChange={(e) => { setFilterCreatedBy(e.target.value); }}
            className="h-8 rounded-md border bg-background px-2 text-xs"
          >
            <option value="">登録者</option>
            {filterOptions.creators.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
          <div className="flex items-center gap-1">
            <input
              type="date"
              value={filterDateFrom}
              onChange={(e) => setFilterDateFrom(e.target.value)}
              className="h-8 rounded-md border bg-background px-2 text-xs"
              title="更新日From"
            />
            <span className="text-xs text-muted-foreground">〜</span>
            <input
              type="date"
              value={filterDateTo}
              onChange={(e) => setFilterDateTo(e.target.value)}
              className="h-8 rounded-md border bg-background px-2 text-xs"
              title="更新日To"
            />
          </div>
          {(filterType || filterDateFrom || filterDateTo || filterCreatedBy) && (
            <button
              onClick={() => { setFilterType(""); setFilterDateFrom(""); setFilterDateTo(""); setFilterCreatedBy(""); }}
              className="text-xs text-muted-foreground hover:text-foreground underline"
            >
              クリア
            </button>
          )}
          <span className="text-sm text-muted-foreground ml-auto">{total.toLocaleString()}件</span>
          {/* AI chat toggle */}
          {!chatOpen && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setChatOpen(true)}
              title="AIチャットを開く"
            >
              <Sparkles className={`h-4 w-4 ${aiStreaming ? "animate-ai-glow text-primary" : ""}`} />
            </Button>
          )}
        </div>

        {/* Table */}
        <Card className="!py-0 !gap-0 flex-1 min-h-0 overflow-hidden flex flex-col">
          <table className="w-full text-sm" style={{ tableLayout: "fixed" }}>
            <colgroup>
              <col />
              <col style={{ width: 64 }} />
              <col style={{ width: 56 }} />
              <col style={{ width: 96 }} />
              <col style={{ width: 96 }} />
              <col style={{ width: 112 }} />
            </colgroup>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className={`pl-4 ${isSearching ? "" : "cursor-pointer select-none"}`} onClick={isSearching ? undefined : () => handleSort("title")}>
                  <span className="flex items-center gap-2">
                    タイトル {!isSearching && <SortIcon col="title" />}
                    {selected.size > 0 && (
                      <>
                        <span className="text-xs font-normal text-muted-foreground">{selected.size}件選択中</span>
                        <button
                          className="text-xs font-normal text-muted-foreground hover:text-foreground underline"
                          onClick={(e) => { e.stopPropagation(); setSelected(new Set()); }}
                        >
                          選択解除
                        </button>
                      </>
                    )}
                  </span>
                </TableHead>
                <TableHead>種別</TableHead>
                <TableHead>チャンク</TableHead>
                <TableHead>登録者</TableHead>
                <TableHead className={isSearching ? "" : "cursor-pointer select-none"} onClick={isSearching ? undefined : () => handleSort("updated_at")}>
                  <span className="flex items-center">更新日 {!isSearching && <SortIcon col="updated_at" />}</span>
                </TableHead>
                <TableHead className="text-center">検索 / AI</TableHead>
              </TableRow>
            </TableHeader>
          </table>
          <div className="w-full flex-1 min-h-0 overflow-y-auto" ref={scrollContainerRef}>
            <table className="w-full text-sm" style={{ tableLayout: "fixed" }}>
              <colgroup>
                <col />
                <col style={{ width: 64 }} />
                <col style={{ width: 56 }} />
                <col style={{ width: 96 }} />
                <col style={{ width: 96 }} />
                <col style={{ width: 112 }} />
              </colgroup>
              <TableBody className="[&_tr:last-child]:border-b">
                {items.map((item) => (
                  <TableRow
                    key={item.id}
                    draggable
                    onDragStart={(e) => handleDragStart(e, item.id)}
                    className={`cursor-pointer select-none ${selected.has(item.id) ? "bg-blue-50 dark:bg-blue-950/30 hover:bg-blue-50 dark:hover:bg-blue-950/30" : ""}`}
                    onClick={(e) => handleRowClick(item, e)}
                    onDoubleClick={() => handleRowDoubleClick(item)}
                    onContextMenu={(e) => handleContextMenu(e, item)}
                  >
                    <TableCell className="pl-4">
                      <span className="font-medium text-sm max-w-[400px] truncate flex items-center gap-1">
                        {item.title}
                        {(item as any).share_count > 0 && (
                          <Link className="h-3 w-3 text-primary flex-shrink-0" title={`共有中（${(item as any).share_count}件）`} />
                        )}
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
                    <TableCell>
                      <Badge variant="outline" className="text-xs">{item.file_type}</Badge>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {item.chunk_count}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {item.created_by_name ?? "-"}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
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
                          <Bot className="h-4 w-4" />
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
            </table>
            {/* Infinite scroll sentinel */}
            {hasMore && <div ref={sentinelRef} className="h-4" />}
            {loading && items.length > 0 && (
              <div className="flex justify-center py-2 text-sm text-muted-foreground">読み込み中…</div>
            )}
          </div>
        </Card>

        {/* Context menu */}
        {contextMenu && (
          <DocumentContextMenu
            menu={contextMenu}
            selectedCount={selected.size}
            shareEnabled={shareEnabled}
            onClose={() => setContextMenu(null)}
            onAction={contextAction}
          />
        )}

        </>
        )}
      </div>

      {/* AI Chat Panel — slide in/out */}
      <div
        className="flex-shrink-0 min-h-0 transition-[width,opacity] duration-300 ease-in-out overflow-hidden"
        style={{ width: chatOpen ? "36rem" : "0", opacity: chatOpen ? 1 : 0 }}
      >
        <div className="w-[36rem] h-full px-px py-px">
          <ChatPanel
            initialQuery={urlQ || undefined}
            onSourceClick={(docId) => {
              const found = items.find((i) => i.id === docId);
              if (found) setDetailDoc(found);
            }}
            onCollapse={() => setChatOpen(false)}
            onStreamingChange={setAiStreaming}
          />
        </div>
      </div>

      {/* Detail Modal */}
      <DocumentDetailModal
        item={detailDoc}
        folders={folders}
        allTags={allTags}
        shareEnabled={shareEnabled}
        onClose={() => setDetailDoc(null)}
        onUpdated={() => { setDetailDoc(null); load(true); loadFolders(); loadTags(); }}
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
        onDone={() => { setBulkActionOpen(null); setSelected(new Set()); load(true); }}
      />

      <BulkFolderDialog
        open={bulkActionOpen === "move_folder"}
        folders={folders}
        selectedIds={[...selected]}
        items={items}
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
        items={items}
        onClose={() => setBulkActionOpen(null)}
        onDone={() => { setBulkActionOpen(null); setSelected(new Set()); load(true); loadTags(); }}
      />

      {/* Rename Dialog */}
      <Dialog open={!!renameTarget} onOpenChange={(open) => { if (!open) setRenameTarget(null); }}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>名前変更</DialogTitle>
          </DialogHeader>
          <Input
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && renameValue.trim() && renameTarget) {
                updateDocument(renameTarget.id, { title: renameValue.trim() })
                  .then(() => { setRenameTarget(null); setItems((prev) => prev.map((i) => i.id === renameTarget!.id ? { ...i, title: renameValue.trim() } : i)); toast.success("名前を変更しました"); })
                  .catch(() => toast.error("名前変更に失敗"));
              }
            }}
            autoFocus
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setRenameTarget(null)}>キャンセル</Button>
            <Button
              disabled={!renameValue.trim()}
              onClick={() => {
                if (!renameTarget) return;
                updateDocument(renameTarget.id, { title: renameValue.trim() })
                  .then(() => { setRenameTarget(null); setItems((prev) => prev.map((i) => i.id === renameTarget!.id ? { ...i, title: renameValue.trim() } : i)); toast.success("名前を変更しました"); })
                  .catch(() => toast.error("名前変更に失敗"));
              }}
            >
              変更
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

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
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-sm text-muted-foreground">色:</span>
              {TAG_COLORS.map((c) => (
                <button
                  key={c}
                  onClick={() => setNewTagColor(c)}
                  className={`w-6 h-6 rounded-full border-2 transition-colors ${newTagColor === c ? "border-foreground" : "border-transparent"}`}
                  style={{ backgroundColor: c }}
                />
              ))}
              <input
                type="color"
                value={newTagColor}
                onChange={(e) => setNewTagColor(e.target.value)}
                className="w-6 h-6 rounded-full border-0 p-0 cursor-pointer"
                title="カスタム色"
              />
            </div>
          </div>
          <DialogFooter showCloseButton>
            <Button onClick={handleCreateTag} disabled={!newTagName.trim()}>作成</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Tag Edit Dialog */}
      <Dialog open={!!editingTag} onOpenChange={(open) => { if (!open) setEditingTag(null); }}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>タグ編集</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <Input
              placeholder="タグ名"
              value={editTagName}
              onChange={(e) => setEditTagName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && editTagName.trim() && editingTag) {
                  updateTag(editingTag.id, { name: editTagName.trim(), color: editTagColor })
                    .then((updated) => {
                      setAllTags((prev) => prev.map((t) => t.id === updated.id ? { ...t, ...updated } : t));
                      if (activeTag === editingTag!.name) setActiveTag(updated.name);
                      setEditingTag(null);
                      load(true);
                      toast.success("タグを更新しました");
                    })
                    .catch(() => toast.error("タグ更新失敗"));
                }
              }}
              autoFocus
            />
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-sm text-muted-foreground">色:</span>
              {TAG_COLORS.map((c) => (
                <button
                  key={c}
                  onClick={() => setEditTagColor(c)}
                  className={`w-6 h-6 rounded-full border-2 transition-colors ${editTagColor === c ? "border-foreground" : "border-transparent"}`}
                  style={{ backgroundColor: c }}
                />
              ))}
              <input
                type="color"
                value={editTagColor}
                onChange={(e) => setEditTagColor(e.target.value)}
                className="w-6 h-6 rounded-full border-0 p-0 cursor-pointer"
                title="カスタム色"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditingTag(null)}>キャンセル</Button>
            <Button
              disabled={!editTagName.trim()}
              onClick={() => {
                if (!editingTag) return;
                updateTag(editingTag.id, { name: editTagName.trim(), color: editTagColor })
                  .then((updated) => {
                    setAllTags((prev) => prev.map((t) => t.id === updated.id ? { ...t, ...updated } : t));
                    if (activeTag === editingTag!.name) setActiveTag(updated.name);
                    setEditingTag(null);
                    load(true);
                    toast.success("タグを更新しました");
                  })
                  .catch(() => toast.error("タグ更新失敗"));
              }}
            >
              保存
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Overwrite confirmation (one by one) */}
      <Dialog open={overwriteQueue.length > 0} onOpenChange={() => handleOverwriteCancel()}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>上書き確認</DialogTitle>
            <DialogDescription>
              同名のファイルが既に存在します{overwriteQueue.length > 1 ? `（残り ${overwriteQueue.length} 件）` : ""}
            </DialogDescription>
          </DialogHeader>
          {overwriteQueue[0] && (
            <div className="text-sm bg-muted rounded-md p-3">
              <p className="font-medium">{overwriteQueue[0].name}</p>
              <p className="text-muted-foreground">{formatBytes(overwriteQueue[0].size)}</p>
            </div>
          )}
          <div className="flex gap-2 justify-end">
            {overwriteQueue.length > 1 && (
              <Button variant="ghost" onClick={handleOverwriteCancel}>全てキャンセル</Button>
            )}
            <Button variant="outline" onClick={handleOverwriteSkip}>スキップ</Button>
            <Button variant="destructive" onClick={handleOverwriteConfirm}>上書き</Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Folder context menu */}
      {folderCtx && (
        <>
          <div className="fixed inset-0 z-50" onClick={() => setFolderCtx(null)} onContextMenu={(e) => { e.preventDefault(); setFolderCtx(null); }} />
          <div
            className="fixed z-50 min-w-[160px] rounded-lg bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10 animate-in fade-in-0 zoom-in-95"
            style={{ left: folderCtx.x, top: folderCtx.y }}
          >
            <button className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent hover:text-accent-foreground" onClick={() => { setFolderRenameTarget(folderCtx.node); setFolderRenameValue(folderCtx.node.name); setFolderCtx(null); }}>
              <Pencil className="h-4 w-4" />名前変更
            </button>
            <button className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent hover:text-accent-foreground" onClick={() => { setFolderPermsTarget(folderCtx.node); setFolderCtx(null); }}>
              <Shield className="h-4 w-4" />権限設定
            </button>
            <div className="-mx-1 my-1 h-px bg-border" />
            <button className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-destructive hover:bg-destructive/10" onClick={() => { handleFolderDelete(folderCtx.node); setFolderCtx(null); }}>
              <Trash2 className="h-4 w-4" />削除
            </button>
          </div>
        </>
      )}

      {/* Folder rename dialog */}
      <Dialog open={!!folderRenameTarget} onOpenChange={(open) => { if (!open) setFolderRenameTarget(null); }}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>フォルダ名変更</DialogTitle>
          </DialogHeader>
          <Input
            value={folderRenameValue}
            onChange={(e) => setFolderRenameValue(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") handleFolderRename(); }}
            autoFocus
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setFolderRenameTarget(null)}>キャンセル</Button>
            <Button disabled={!folderRenameValue.trim()} onClick={handleFolderRename}>変更</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Folder permissions dialog */}
      {folderPermsTarget && (
        <FolderPermissionsDialog
          folder={folderPermsTarget}
          onClose={() => setFolderPermsTarget(null)}
          onSaved={() => { setFolderPermsTarget(null); loadFolders(); load(true); }}
        />
      )}

      {/* Share Link Dialog */}
      {shareTarget && (
        <ShareLinkDialog
          open={!!shareTarget}
          documentId={shareTarget.id}
          documentTitle={shareTarget.title}
          onClose={() => setShareTarget(null)}
        />
      )}

      {/* Upload Dialog */}
      <UploadDialog
        open={uploadOpen}
        onClose={() => setUploadOpen(false)}
        onSubmit={(files) => { setUploadOpen(false); startUploadWithCheck(files); }}
      />
    </div>
  );
}
