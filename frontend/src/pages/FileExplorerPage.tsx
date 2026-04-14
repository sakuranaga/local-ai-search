import { useCallback, useEffect, useMemo, useRef, useState, lazy, Suspense } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import { t } from "@/i18n";
import { ChatPanel } from "@/components/ChatPanel";
import { DocumentDetailModal } from "@/components/DocumentDetailModal";
import { DocumentContextMenu, type ContextMenuState } from "@/components/DocumentContextMenu";
import { BulkPermissionsDialog, BulkFolderDialog, BulkTagDialog, UploadDialog } from "@/components/BulkActionDialogs";
import { FolderPermissionsDialog } from "@/components/FolderPermissionsDialog";
import { ShareLinkDialog } from "@/components/ShareLinkDialog";
import { CreateTextDocumentDialog } from "@/components/CreateTextDocumentDialog";
import { SidebarTagItem, DropTarget, TrashDropTarget, FolderTreeItem } from "@/components/FolderSidebarItems";
import NoteSidebarItems, { type NoteContextMenuState } from "@/components/NoteSidebarItems";
const NoteEditor = lazy(() => import("@/components/NoteEditor"));
import { Tooltip } from "@/components/ui/tooltip";
import { DatePickerInput } from "@/components/DatePickerInput";
import { UploadProgressPanel } from "@/components/UploadProgressPanel";
import { UploadQueueManager, type QueueState } from "@/lib/uploadQueue";
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
  BookOpenText,
  ChevronLeft,
  ArrowUpDown,
  ArrowUp,
  ArrowDown,
  Upload,
  Trash2,
  Shield,
  Pencil,
  Link,
  Search as SearchIcon,
  FileText,
  Bot,
  FolderIcon,
  FilePlus,
  FolderPlus,
  Menu,
  Plus,
  X,
  Undo2,
  Sparkles,
  Pin,
  PinOff,
  RefreshCw,
  Star,
  Clock,
} from "lucide-react";
import {
  getDocuments,
  getDocument,
  getFilterOptions,
  getShareEnabled,
  updateDocument,
  bulkAction,
  pollJobsProgress,
  getFolders,
  createFolder,
  createFoldersBulk,
  updateFolder,
  deleteFolder,
  createTag,
  updateTag,
  getTags,
  getTrash,
  restoreFromTrash,
  purgeFromTrash,
  emptyTrash,
  checkDuplicates,
  searchDocumentsList,
  getFavorites,
  addFavorite,
  removeFavorite,
  type TrashItem,
  type DocumentListItem,
  type Folder,
  type TagInfo,
  type FilterOptions,
  getNoteTree,
  getNote,
  createNote,
  moveNote,
  removeNote,
  deleteNoteWithFile,
  convertToNote,
  getMe,
  deleteConversation,
  type NoteTreeItem,
  type NoteDetail,
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
  clearUnpinnedSearchHistory,
  checkInterruptedUploads,
  clearInterruptedUpload,
  TAG_COLORS,
  hasDirectoryEntries,
  traverseDataTransferItems,
  type FileWithPath,
  type FolderNode,
  type SearchHistoryEntry,
} from "@/lib/fileExplorerHelpers";

const NoteReadonlyView = lazy(() => import("@/components/NoteReadonlyView"));

const MAX_UPLOAD_FILES = 1000;

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
  const [filterIncludeUnsearchable, setFilterIncludeUnsearchable] = useState(false);
  const [filterOptions, setFilterOptions] = useState<FilterOptions>({ file_types: [], creators: [] });
  const [searchTokens, setSearchTokens] = useState<string[]>([]);

  // AI chat panel visibility (default closed on mobile)
  const [chatOpen, setChatOpen] = useState(false);
  // Mobile sidebar drawer
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [aiStreaming, setAiStreaming] = useState(false);

  // Sidebar section collapse state (persisted in localStorage)
  const [sidebarCollapsed, setSidebarCollapsed] = useState<Record<string, boolean>>(() => {
    try { return JSON.parse(localStorage.getItem("las_sidebar_collapsed") || "{}"); } catch { return {}; }
  });
  const toggleSection = useCallback((key: string) => {
    setSidebarCollapsed((prev) => {
      const next = { ...prev, [key]: !prev[key] };
      localStorage.setItem("las_sidebar_collapsed", JSON.stringify(next));
      return next;
    });
  }, []);

  // Search history
  const navigate = useNavigate();
  const [searchHistory, setSearchHistory] = useState<SearchHistoryEntry[]>(loadSearchHistory);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [focusedIdx, setFocusedIdx] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);

  // Recent items
  const [showRecent, setShowRecent] = useState(false);

  // Favorites
  const [favoriteIds, setFavoriteIds] = useState<Set<string>>(new Set());
  const [showFavorites, setShowFavorites] = useState(false);

  // Folder state
  const [folders, setFolders] = useState<Folder[]>([]);
  const [allDocCount, setAllDocCount] = useState(0);
  const [activeFolderId, setActiveFolderId] = useState<string | null>(() => localStorage.getItem("explorer_folder")); // null = all, "unfiled" = no folder
  const [dragOverFolderRowId, setDragOverFolderRowId] = useState<string | null>(null);
  const [newFolderOpen, setNewFolderOpen] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  const [newFolderParent, setNewFolderParent] = useState<string | null>(null);

  // Tag state
  const [allTags, setAllTags] = useState<TagInfo[]>([]);
  const [activeTags, setActiveTags] = useState<string[]>(() => {
    try { const v = localStorage.getItem("explorer_tags"); return v ? JSON.parse(v) : []; } catch { return []; }
  });
  const [newTagOpen, setNewTagOpen] = useState(false);
  const [newTagName, setNewTagName] = useState("");
  const [newTagColor, setNewTagColor] = useState(TAG_COLORS[0]);
  const [editingTag, setEditingTag] = useState<TagInfo | null>(null);
  const [editTagName, setEditTagName] = useState("");
  const [editTagColor, setEditTagColor] = useState("");

  // Persist sidebar state to localStorage
  useEffect(() => {
    if (activeFolderId) {
      localStorage.setItem("explorer_folder", activeFolderId);
    } else {
      localStorage.removeItem("explorer_folder");
    }
  }, [activeFolderId]);

  useEffect(() => {
    if (activeTags.length > 0) {
      localStorage.setItem("explorer_tags", JSON.stringify(activeTags));
    } else {
      localStorage.removeItem("explorer_tags");
    }
  }, [activeTags]);

  // Dialogs
  const [detailDoc, setDetailDoc] = useState<DocumentListItem | null>(null);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [createTextOpen, setCreateTextOpen] = useState(false);
  const [createTextFolderId, setCreateTextFolderId] = useState<string | null>(null);
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

  // Notes
  const [noteTree, setNoteTree] = useState<NoteTreeItem[]>([]);
  const [activeNoteId, setActiveNoteId] = useState<string | null>(null);
  const [activeNote, setActiveNote] = useState<NoteDetail | null>(null);
  const [meUser, setMeUser] = useState<{ display_name: string; username: string } | null>(null);
  const [noteDeleteTarget, setNoteDeleteTarget] = useState<{ noteId: string; title: string } | null>(null);
  const [noteDeleteMode, setNoteDeleteMode] = useState<"remove" | "delete">("remove");
  const [noteCtxMenu, setNoteCtxMenu] = useState<NoteContextMenuState | null>(null);
  const [blankCtx, setBlankCtx] = useState<{ x: number; y: number } | null>(null);
  const notesReadonly = activeNote?.note_readonly ?? false;
  const noteDirtyRef = useRef(false);

  const confirmDiscardNote = useCallback(() => {
    if (!noteDirtyRef.current) return true;
    return window.confirm(t("fileExplorer:noteUnsavedConfirm"));
  }, []);

  // Selecting a folder/tag while searching should clear the search query
  const selectFolder = useCallback((id: string | null) => {
    if (!confirmDiscardNote()) return;
    noteDirtyRef.current = false;
    setActiveFolderId(id);
    setActiveTags([]);
    setSidebarOpen(false);
    setShowTrash(false);
    setShowFavorites(false);
    setShowRecent(false);
    setActiveNoteId(null);
    setActiveNote(null);
    if (isSearching) {
      navigate("/", { replace: true });
    }
  }, [isSearching, navigate, confirmDiscardNote]);

  // File drop upload
  const [fileDragOver, setFileDragOver] = useState(false);
  const dragCounter = useRef(0);

  // Overwrite confirmation queue (shared by drag-drop and upload dialog)
  const [overwriteQueue, setOverwriteQueue] = useState<globalThis.File[]>([]);

  // Move duplicate confirmation
  const [pendingMove, setPendingMove] = useState<{
    docIds: string[];
    folderId: string | null;
    duplicateNames: string[];
  } | null>(null);

  // Upload queue manager (3+ files)
  const [queueState, setQueueState] = useState<QueueState | null>(null);
  const reloadRef = useRef<() => void>(() => {});
  const queueManagerRef = useRef<UploadQueueManager | null>(null);
  if (!queueManagerRef.current) {
    queueManagerRef.current = new UploadQueueManager(() => reloadRef.current());
  }
  const queueManager = queueManagerRef.current;

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

  const loadFavs = useCallback(async () => {
    try {
      const ids = await getFavorites();
      setFavoriteIds(new Set(ids));
    } catch { /* ignore */ }
  }, []);

  const loadNotes = useCallback(async () => {
    try {
      setNoteTree(await getNoteTree());
    } catch { /* ignore */ }
  }, []);

  async function toggleFavorite(docId: string) {
    const isFav = favoriteIds.has(docId);
    // Optimistic update
    setFavoriteIds((prev) => {
      const next = new Set(prev);
      if (isFav) next.delete(docId); else next.add(docId);
      return next;
    });
    if (isFav && showFavorites) {
      setItems((prev) => prev.filter((item) => item.id !== docId));
      setTotal((prev) => Math.max(0, prev - 1));
    }
    try {
      if (isFav) await removeFavorite(docId); else await addFavorite(docId);
    } catch {
      // Revert
      setFavoriteIds((prev) => {
        const next = new Set(prev);
        if (isFav) next.add(docId); else next.delete(docId);
        return next;
      });
      toast.error(t("fileExplorer:favoriteFailed"));
    }
  }

  // Generation counter to discard stale responses after filter/search changes
  const loadGenRef = useRef(0);

  const load = useCallback(async (reset = false) => {
    if (reset) {
      // Reset must always proceed — cancel any in-flight append
      pageRef.current = 1;
      loadGenRef.current += 1;
      setHasMore(true);
      setLoading(true);
      loadingRef.current = true;
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
          date_from: filterDateFrom || undefined,
          date_to: filterDateTo || undefined,
          created_by: filterCreatedBy || undefined,
          include_unsearchable: filterIncludeUnsearchable || undefined,
        };
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
        if (activeTags.length > 0) {
          params.tags = activeTags;
        } else if (showRecent) {
          params.recent = true;
        } else if (showFavorites) {
          params.favorites = true;
        } else if (activeFolderId === "unfiled") {
          params.unfiled = true;
        } else if (activeFolderId) {
          params.folder_id = activeFolderId;
        } else {
          // "All" view: show only unfiled files (folders shown separately)
          params.unfiled = true;
        }
        const data = await getDocuments(params);
        if (gen !== loadGenRef.current) return; // stale
        setItems((prev) => currentPage === 1 ? data.items : [...prev, ...data.items]);
        setTotal(data.total);
        setHasMore(currentPage * perPage < data.total);
        setSearchTokens([]);
      }
    } catch {
      if (gen === loadGenRef.current) {
        toast.error(t("fileExplorer:fetchFailed"));
        setHasMore(false);
      }
    } finally {
      // Only reset loading state if this is still the current generation.
      // Stale responses must NOT reset loadingRef — doing so lets the
      // IntersectionObserver fire page-2+ requests before page-1 completes,
      // which causes ghost rows from the previous view to bleed through.
      if (gen === loadGenRef.current) {
        setLoading(false);
        loadingRef.current = false;
      }
    }
  }, [perPage, sortBy, sortDir, filterType, filterDateFrom, filterDateTo, filterCreatedBy, filterIncludeUnsearchable, activeFolderId, activeTags, isSearching, urlQ, showFavorites, showRecent]);

  reloadRef.current = () => { load(true); loadFolders(); };

  // Note handlers (must be after `load` definition to avoid TDZ)
  const handleSelectNote = useCallback(async (noteId: string) => {
    if (!confirmDiscardNote()) return;
    noteDirtyRef.current = false;
    setActiveNote(null);
    setActiveNoteId(noteId);
    setShowTrash(false);
    setShowFavorites(false);
    setShowRecent(false);
    setSidebarOpen(false);
    try {
      const detail = await getNote(noteId);
      setActiveNoteId(detail.id);
      setActiveNote(detail);
    } catch {
      toast.error(t("fileExplorer:noteLoadFailed"));
      setActiveNoteId(null);
      setActiveNote(null);
    }
  }, [confirmDiscardNote]);

  const handleCreateNote = useCallback(async (parentId?: string | null) => {
    try {
      const note = await createNote(parentId);
      await loadNotes();
      handleSelectNote(note.id);
      toast.success(t("fileExplorer:noteCreated"));
    } catch {
      toast.error(t("fileExplorer:noteCreateFailed"));
    }
  }, [loadNotes, handleSelectNote]);

  const handleRemoveNote = useCallback(async (noteId: string, _title: string) => {
    try {
      await removeNote(noteId);
      if (activeNoteId === noteId) {
        setActiveNoteId(null);
        setActiveNote(null);
      }
      await loadNotes();
      load(true);
      toast.success(t("fileExplorer:noteRemoved"));
    } catch {
      toast.error(t("fileExplorer:noteRemoveFailed"));
    }
  }, [activeNoteId, loadNotes, load]);

  const handleDeleteNoteWithFile = useCallback(async (noteId: string, _title: string) => {
    try {
      await deleteNoteWithFile(noteId);
      if (activeNoteId === noteId) {
        setActiveNoteId(null);
        setActiveNote(null);
      }
      await loadNotes();
      load(true);
      loadTrash();
      toast.success(t("fileExplorer:noteDeleted"));
    } catch {
      toast.error(t("fileExplorer:noteDeleteFailed"));
    }
  }, [activeNoteId, loadNotes, load, loadTrash]);

  const handleMoveNote = useCallback(async (noteId: string, parentNoteId: string | null, position: number) => {
    try {
      await moveNote(noteId, { parent_note_id: parentNoteId ?? "", position });
      await loadNotes();
    } catch {
      toast.error(t("fileExplorer:noteMoveFailed"));
    }
  }, [loadNotes]);

  const handleConvertToNote = useCallback(async (docId: string) => {
    try {
      await convertToNote(docId);
      await loadNotes();
      load(true);
      toast.success(t("fileExplorer:noteConverted"));
    } catch {
      toast.error(t("fileExplorer:noteConvertFailed"));
    }
  }, [loadNotes, load]);

  useEffect(() => { load(true); }, [load]);
  // Re-trigger search when URL timestamp changes (re-search same query)
  useEffect(() => { if (urlT) load(true); }, [urlT]);
  // Exit trash/favorites view when entering search mode
  useEffect(() => { if (isSearching) { setShowTrash(false); setShowFavorites(false); } }, [isSearching]);
  useEffect(() => {
    loadFolders(); loadTags(); loadTrash(); loadFavs(); loadNotes(); getMe().then(setMeUser).catch(() => {}); getFilterOptions().then(setFilterOptions).catch(() => {}); getShareEnabled().then(setShareEnabled).catch(() => {});
    // Check for uploads interrupted by page reload
    const interrupted = checkInterruptedUploads();
    for (const filename of interrupted) {
      toast.warning(t("fileExplorer:interrupted", { filename }), {
        id: `interrupted-${filename}`,
        description: t("fileExplorer:interruptedHint"),
        duration: Infinity,
        action: {
          label: t("fileExplorer:dismiss"),
          onClick: () => clearInterruptedUpload(filename),
        },
      });
    }
  }, []);
  // Subscribe to upload queue state
  useEffect(() => {
    return queueManager.subscribe((state) => {
      setQueueState(state.items.length > 0 ? state : null);
    });
  }, [queueManager]);
  // Handle @mention clicks — navigate to note or open file modal
  useEffect(() => {
    const handler = (e: Event) => {
      const { documentId, isNote } = (e as CustomEvent).detail as { documentId: string; isNote: boolean };
      if (isNote) {
        handleSelectNote(documentId);
      } else {
        getDocument(documentId).then((doc) => {
          setDetailDoc(doc as unknown as DocumentListItem);
        }).catch(() => toast.error(t("fileExplorer:docNotFound")));
      }
    };
    window.addEventListener("doc-mention-click", handler);
    return () => window.removeEventListener("doc-mention-click", handler);
  }, [handleSelectNote]);

  // Reset when search query changes & record search history
  useEffect(() => {
    if (urlQ) {
      setSearchHistory(addSearchHistory(urlQ));
      setActiveTags([]);
      // Close note when search is triggered (e.g. from NavBar or search history)
      if (activeNoteId) {
        if (!confirmDiscardNote()) return;
        noteDirtyRef.current = false;
        setActiveNoteId(null);
        setActiveNote(null);
      }
    }
  }, [urlQ]); // eslint-disable-line react-hooks/exhaustive-deps


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

  // Keyboard-driven infinite scroll: trigger load when focusedIdx nears bottom
  useEffect(() => {
    if (focusedIdx !== null && items.length > 0 && focusedIdx >= items.length - 3 && hasMore && !loadingRef.current) {
      pageRef.current += 1;
      load();
    }
  }, [focusedIdx, items.length, hasMore, load]);

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

      // Arrow key navigation (←↑ = up, →↓ = down)
      if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.key) && !isMod) {
        e.preventDefault();
        const isUp = e.key === "ArrowUp" || e.key === "ArrowLeft";
        setFocusedIdx((prev) => {
          const cur = prev ?? (isUp ? 0 : -1);
          const next = isUp ? Math.max(0, cur - 1) : Math.min(items.length - 1, cur + 1);
          const item = items[next];
          if (!item) return prev;

          // Selection
          if (e.shiftKey) {
            // Shift+arrow: toggle the item we moved TO into selection
            setSelected((s) => { const n = new Set(s); n.add(item.id); return n; });
          } else {
            // Normal arrow: select only this item
            setSelected(new Set([item.id]));
          }
          lastClickedIdx.current = next;

          // Scroll row into view
          const row = scrollContainerRef.current?.querySelector(`[data-row-idx="${next}"]`);
          row?.scrollIntoView({ block: "nearest" });

          return next;
        });
        return;
      }

      // Enter / Space: open detail modal for focused item
      if ((e.key === "Enter" || e.key === " ") && focusedIdx !== null && items[focusedIdx]) {
        e.preventDefault();
        setDetailDoc(items[focusedIdx]);
        return;
      }

      // Ctrl/Cmd+A: select all
      if (isMod && e.key === "a") {
        e.preventDefault();
        setSelected(new Set(items.map((i) => i.id)));
        return;
      }

      // Escape: clear selection and focus
      if (e.key === "Escape") {
        setSelected(new Set());
        setFocusedIdx(null);
        return;
      }

      // Delete / Backspace: move selected to trash (no dialog)
      if ((e.key === "Delete" || e.key === "Backspace") && selected.size > 0) {
        e.preventDefault();
        const ids = [...selected];
        const tid = toast.loading(t("fileExplorer:movingToTrash", { count: ids.length }));
        bulkAction(ids, "delete").then((res) => {
          toast.success(t("fileExplorer:movedToTrash", { count: res.processed }), { id: tid });
          setSelected(new Set());
          setFocusedIdx(null);
          setItems((prev) => prev.filter((i) => !ids.includes(i.id)));
          setTotal((prev) => Math.max(0, prev - ids.length));
          loadFolders();
          loadTrash();
          loadNotes();
        }).catch(() => toast.error(t("fileExplorer:deleteFailed"), { id: tid }));
        return;
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [items, selected, showTrash, detailDoc, bulkActionOpen, uploadOpen, newFolderOpen, focusedIdx, hasMore]);

  const folderTree = useMemo(() => buildFolderTree(folders), [folders]);

  // Folder expand/collapse state persisted in localStorage
  const FOLDER_EXPANDED_KEY = "las-folder-expanded";
  const [expandedFolderIds, setExpandedFolderIds] = useState<Set<string>>(() => {
    try {
      const saved = localStorage.getItem(FOLDER_EXPANDED_KEY);
      if (saved) return new Set(JSON.parse(saved) as string[]);
    } catch { /* ignore */ }
    return new Set<string>();
  });
  const toggleFolderExpand = useCallback((id: string) => {
    setExpandedFolderIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      localStorage.setItem(FOLDER_EXPANDED_KEY, JSON.stringify([...next]));
      return next;
    });
  }, []);

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

  // Child folders to display in the file list (Google Drive style)
  const listFolders = useMemo(() => {
    if (isSearching || showTrash || showRecent || showFavorites || activeTags.length > 0 || activeFolderId === "unfiled") return [];
    if (activeFolderId === null) {
      // Root: show folders with no parent
      return folders.filter((f) => !f.parent_id).sort((a, b) => a.name.localeCompare(b.name));
    }
    // Inside a folder: show direct children
    return folders.filter((f) => f.parent_id === activeFolderId).sort((a, b) => a.name.localeCompare(b.name));
  }, [folders, activeFolderId, isSearching, showTrash, showRecent, showFavorites, activeTags]);

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
    } catch { toast.error(t("fileExplorer:updateFailed")); }
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
            const target = targets[0];
            (async () => {
              try {
                const res = await fetch(`/api/documents/${target.id}/download`, {
                  headers: token ? { Authorization: `Bearer ${token}` } : {},
                });
                if (!res.ok) throw new Error();
                const blob = await res.blob();
                const disposition = res.headers.get("content-disposition");
                const filenameMatch = disposition?.match(/filename\*?=(?:UTF-8''|"?)([^";]+)/i);
                const filename = filenameMatch ? decodeURIComponent(filenameMatch[1]) : target.title;
                const a = document.createElement("a");
                a.href = URL.createObjectURL(blob);
                a.download = filename;
                a.click();
                URL.revokeObjectURL(a.href);
              } catch { toast.error(t("fileExplorer:downloadFailed", { title: target.title })); }
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
                toast.success(t("fileExplorer:zipDownloaded", { count: targets.length }));
              } catch { toast.error(t("fileExplorer:zipDownloadFailed")); }
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
      case "toggle_favorite":
        toggleFavorite(item.id);
        break;
      case "convert_to_note":
        handleConvertToNote(item.id);
        break;
      case "remove_note":
        handleRemoveNote(item.id, item.title);
        break;
      case "delete":
        setBulkActionOpen("delete");
        break;
      case "new_folder":
        setNewFolderParent(activeFolderId && activeFolderId !== "unfiled" ? activeFolderId : null);
        setNewFolderOpen(true);
        break;
      case "new_text":
        setCreateTextFolderId(item.folder_id ?? null);
        setCreateTextOpen(true);
        break;
      case "new_upload":
        setUploadOpen(true);
        break;
    }
  }

  async function handleBulkAction(action: string, extra?: Record<string, unknown>) {
    const ids = [...selected];
    const tid = ids.length >= 10 ? toast.loading(action === "delete" ? t("fileExplorer:movingToTrash", { count: ids.length }) : `${ids.length}...`) : undefined;
    try {
      const res = await bulkAction(ids, action, extra);
      const msg = action === "delete" ? t("fileExplorer:movedToTrash", { count: res.processed }) : t("fileExplorer:processed", { count: res.processed });
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
        loadNotes();
      } else {
        // For structural actions: clear selection & reload
        setSelected(new Set());
        load(true);
        loadFolders();
        loadTags();
      }
    } catch { toast.error(t("fileExplorer:processFailed")); }
  }

  // Drag & drop / bulk move: move documents to folders
  async function handleDropOnFolder(folderId: string | null, docIds: string[], overwrite = false) {
    if (docIds.length === 0) return;

    // Check for duplicates in target folder (skip if overwrite already confirmed)
    if (!overwrite) {
      try {
        const movingItems = items.filter((i) => docIds.includes(i.id));
        const titles = movingItems.map((i) => i.title);
        if (titles.length > 0) {
          const dupTitles = await checkDuplicates(titles, folderId);
          if (dupTitles.length > 0) {
            setPendingMove({ docIds, folderId, duplicateNames: dupTitles });
            return;
          }
        }
      } catch {
        // If duplicate check fails, proceed with move
      }
    }

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
      const res = await bulkAction(docIds, "move_to_folder", { folder_id: folderId, overwrite });
      toast.success(t("fileExplorer:moved", { count: res.processed }));
      setSelected(new Set());
      // Reload to get accurate data from server
      load(true);
      loadFolders();
    } catch {
      toast.error(t("fileExplorer:moveFailed"));
      // Revert on error
      load(true);
      loadFolders();
    }
  }

  // Check if targetId is a descendant of folderId (prevent circular move)
  function isDescendant(folderId: string, targetId: string): boolean {
    const children = folders.filter((f) => f.parent_id === folderId);
    for (const child of children) {
      if (child.id === targetId) return true;
      if (isDescendant(child.id, targetId)) return true;
    }
    return false;
  }

  async function handleDropFolderOnFolder(draggedFolderId: string, targetFolderId: string | null) {
    if (draggedFolderId === targetFolderId) return;
    if (targetFolderId && isDescendant(draggedFolderId, targetFolderId)) {
      toast.error(t("fileExplorer:circularMoveError"));
      return;
    }
    try {
      // Backend requires "" (empty string) to move to root, not null
      await updateFolder(draggedFolderId, { parent_id: targetFolderId ?? "" });
      // Auto-expand target so the moved folder is visible
      if (targetFolderId) {
        setExpandedFolderIds((prev) => {
          const next = new Set(prev);
          next.add(targetFolderId);
          localStorage.setItem(FOLDER_EXPANDED_KEY, JSON.stringify([...next]));
          return next;
        });
      }
      toast.success(t("fileExplorer:folderMoved"));
      loadFolders();
    } catch {
      toast.error(t("fileExplorer:folderMoveFailed"));
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
    const tid = docIds.length >= 10 ? toast.loading(t("fileExplorer:movingToTrash", { count: docIds.length })) : undefined;
    try {
      const res = await bulkAction(docIds, "delete");
      const msg = t("fileExplorer:movedToTrash", { count: res.processed });
      tid ? toast.success(msg, { id: tid }) : toast.success(msg);
      setSelected(new Set());
      load(true);
      loadFolders();
      loadTrash();
      loadNotes();
    } catch {
      tid ? toast.error(t("fileExplorer:moveToTrashFailed"), { id: tid }) : toast.error(t("fileExplorer:moveToTrashFailed"));
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
      toast.success(t("fileExplorer:folderRenamed"));
    } catch { toast.error(t("fileExplorer:folderRenameFailed")); }
  }

  async function handleFolderDelete(node: FolderNode) {
    if (!confirm(t("fileExplorer:folderDeleteConfirm", { name: node.name }))) return;
    try {
      await deleteFolder(node.id);
      if (activeFolderId === node.id) selectFolder(null);
      loadFolders();
      load(true);
      loadTrash();
      toast.success(t("fileExplorer:folderDeleted"));
    } catch (e: any) {
      const msg = e?.message?.includes("403") ? t("common:noPermission") : t("fileExplorer:folderDeleteFailed");
      toast.error(msg);
    }
  }

  async function handleCreateFolder() {
    if (!newFolderName.trim()) return;
    try {
      await createFolder({ name: newFolderName.trim(), parent_id: newFolderParent });
      // Auto-expand parent so the new subfolder is visible
      if (newFolderParent) {
        setExpandedFolderIds((prev) => {
          const next = new Set(prev);
          next.add(newFolderParent);
          localStorage.setItem(FOLDER_EXPANDED_KEY, JSON.stringify([...next]));
          return next;
        });
      }
      setNewFolderName("");
      setNewFolderParent(null);
      setNewFolderOpen(false);
      loadFolders();
    } catch { toast.error(t("fileExplorer:folderCreateFailed")); }
  }

  async function handleCreateTag() {
    if (!newTagName.trim()) return;
    try {
      const tag = await createTag({ name: newTagName.trim(), color: newTagColor });
      setAllTags((prev) => [...prev, { ...tag, document_count: 0 } as TagInfo & { document_count?: number }].sort((a, b) => a.name.localeCompare(b.name)));
      setNewTagName("");
      setNewTagOpen(false);
    } catch { toast.error(t("fileExplorer:tagCreateFailed")); }
  }

  function hasFiles(e: React.DragEvent) {
    return e.dataTransfer.types.includes("Files");
  }

  function handleFileDragEnter(e: React.DragEvent) {
    e.preventDefault();
    if (!hasFiles(e) || uploadOpen) return;
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
    if (e.dataTransfer.types.includes("application/x-folder-id") || e.dataTransfer.types.includes("application/x-doc-ids")) {
      e.dataTransfer.dropEffect = "move";
    } else if (hasFiles(e)) {
      e.dataTransfer.dropEffect = "copy";
    }
  }

  const uploadFolderId = activeFolderId && activeFolderId !== "unfiled" ? activeFolderId : null;

  async function startUploadWithCheck(files: globalThis.File[]) {
    if (files.length > MAX_UPLOAD_FILES) {
      toast.error(t("fileExplorer:maxFilesExceeded", { max: MAX_UPLOAD_FILES, count: files.length }));
      return;
    }
    const dupTitles = await checkDuplicates(files.map((f) => f.name), uploadFolderId);
    const dupSet = new Set(dupTitles);
    const dups: globalThis.File[] = [];
    const nonDups: globalThis.File[] = [];
    for (const f of files) {
      if (dupSet.has(f.name)) dups.push(f);
      else nonDups.push(f);
    }
    if (nonDups.length > 0) {
      if (nonDups.length <= 2 && dups.length === 0) {
        // Small batch: toast-based upload
        const reload = () => { load(true); loadFolders(); };
        for (const f of nonDups) {
          uploadWithProgress(f, reload, uploadFolderId);
        }
      } else {
        // 3+ files: queue manager with progress panel
        queueManager.enqueue(nonDups, uploadFolderId);
      }
    }
    if (dups.length > 0) {
      setOverwriteQueue(dups);
    }
  }

  function handleFileDrop(e: React.DragEvent) {
    e.preventDefault();
    dragCounter.current = 0;
    setFileDragOver(false);

    // Handle folder dragged from sidebar into file list
    const draggedFolderId = e.dataTransfer.getData("application/x-folder-id");
    if (draggedFolderId) {
      const targetFolderId = activeFolderId && activeFolderId !== "unfiled" ? activeFolderId : null;
      if (draggedFolderId !== targetFolderId) {
        handleDropFolderOnFolder(draggedFolderId, targetFolderId);
      }
      return;
    }

    // Handle documents dragged from file list
    const docData = e.dataTransfer.getData("application/x-doc-ids");
    if (docData) {
      try {
        const ids: string[] = JSON.parse(docData);
        const targetFolderId = activeFolderId && activeFolderId !== "unfiled" ? activeFolderId : null;
        if (ids.length > 0) handleDropOnFolder(targetFolderId, ids);
      } catch { /* ignore */ }
      return;
    }

    if (!hasFiles(e) || uploadOpen) return;

    // Check for directory entries (folder drop)
    if (hasDirectoryEntries(e.dataTransfer)) {
      handleFolderUpload(e.dataTransfer);
      return;
    }

    const files = Array.from(e.dataTransfer.files);
    if (files.length === 0) return;
    startUploadWithCheck(files);
  }

  async function handleFolderUpload(dataTransfer: DataTransfer) {
    const toastId = toast.loading(t("fileExplorer:readingFolder"));
    try {
      const result = await traverseDataTransferItems(dataTransfer, MAX_UPLOAD_FILES);
      if (result.truncated) {
        toast.error(t("fileExplorer:maxFilesError", { max: MAX_UPLOAD_FILES }), { id: toastId });
        return;
      }
      if (result.files.length === 0) {
        toast.info(t("fileExplorer:noUploadableFiles"), { id: toastId });
        return;
      }
      toast.dismiss(toastId);
      await handleFolderUploadEntries(result.files);
    } catch (err) {
      toast.error(t("fileExplorer:folderUploadFailed", { error: err instanceof Error ? err.message : t("fileExplorer:unknownError") }), { id: toastId });
    }
  }

  async function handleFolderUploadEntries(entries: FileWithPath[]) {
    const toastId = toast.loading(t("fileExplorer:creatingFolders"));
    try {
      const folderPaths = [...new Set(entries.map((e) => e.folderPath).filter(Boolean))];

      let pathToFolderId: Record<string, string> = {};
      if (folderPaths.length > 0) {
        toast.loading(t("fileExplorer:creatingFoldersCount", { count: folderPaths.length }), { id: toastId });
        const result = await createFoldersBulk(folderPaths, uploadFolderId);
        for (const { path, id } of result.folders) {
          pathToFolderId[path] = id;
        }
        loadFolders();
      }

      const queueItems = entries.map((entry) => ({
        file: entry.file,
        folderId: entry.folderPath ? (pathToFolderId[entry.folderPath] ?? uploadFolderId) : uploadFolderId,
      }));

      toast.success(t("fileExplorer:filesQueued", { count: entries.length }), { id: toastId });
      queueManager.enqueue(queueItems);
    } catch (err) {
      toast.error(t("fileExplorer:folderUploadFailed", { error: err instanceof Error ? err.message : t("fileExplorer:unknownError") }), { id: toastId });
    }
  }

  function handleOverwriteConfirm() {
    const file = overwriteQueue[0];
    if (file) {
      const reload = () => { load(true); loadFolders(); };
      uploadWithProgress(file, reload, uploadFolderId);
    }
    setOverwriteQueue((q) => q.slice(1));
  }

  function handleOverwriteAll() {
    if (overwriteQueue.length <= 2) {
      const reload = () => { load(true); loadFolders(); };
      for (const file of overwriteQueue) {
        uploadWithProgress(file, reload, uploadFolderId);
      }
    } else {
      queueManager.enqueue(overwriteQueue, uploadFolderId);
    }
    setOverwriteQueue([]);
  }

  function handleOverwriteSkip() {
    setOverwriteQueue((q) => q.slice(1));
  }

  function handleOverwriteSkipAll() {
    setOverwriteQueue([]);
  }

  function handleOverwriteCancel() {
    setOverwriteQueue([]);
  }

  // Move duplicate handlers
  function handleMoveOverwrite() {
    if (!pendingMove) return;
    setPendingMove(null);
    handleDropOnFolder(pendingMove.folderId, pendingMove.docIds, true);
  }
  function handleMoveSkip() {
    if (!pendingMove) return;
    const skipSet = new Set(pendingMove.duplicateNames);
    const nonDupIds = pendingMove.docIds.filter((id) => {
      const item = items.find((i) => i.id === id);
      return item && !skipSet.has(item.title);
    });
    setPendingMove(null);
    if (nonDupIds.length > 0) {
      handleDropOnFolder(pendingMove.folderId, nonDupIds);
    }
  }
  function handleMoveCancel() {
    setPendingMove(null);
  }

  return (
    <div
      className="p-2 md:p-4 flex gap-2 md:gap-4 relative h-full overflow-hidden"
      onDragEnter={handleFileDragEnter}
      onDragLeave={handleFileDragLeave}
      onDragOver={handleFileDragOver}
      onDrop={handleFileDrop}
    >
      {/* File drop overlay */}
      {fileDragOver && (
        <div
          className="absolute inset-0 z-50 bg-background/80 backdrop-blur-sm flex items-center justify-center rounded-lg border-2 border-dashed border-primary m-4"
          onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; }}
          onDrop={(e) => { e.stopPropagation(); handleFileDrop(e); }}
        >
          <div className="text-center">
            <Upload className="h-12 w-12 text-primary mx-auto mb-3" />
            <p className="text-lg font-medium">{t("fileExplorer:dropToUpload")}</p>
            <p className="text-sm text-muted-foreground mt-1">{t("fileExplorer:dropFolderHint")}</p>
          </div>
        </div>
      )}
      {/* Sidebar backdrop (mobile) */}
      {sidebarOpen && (
        <div className="fixed inset-0 z-40 bg-black/50 md:hidden" onClick={() => setSidebarOpen(false)} />
      )}
      {/* Sidebar */}
      <div className={`
        fixed inset-y-0 left-0 z-50 w-64 bg-background border-r p-4 flex flex-col gap-4 overflow-y-auto scrollbar-hide
        transform transition-transform duration-200 ease-in-out
        md:static md:w-56 md:z-auto md:border-r-0 md:transform-none md:transition-none md:p-0
        ${sidebarOpen ? "translate-x-0" : "-translate-x-full md:translate-x-0"}
      `}>
        {/* Folder tree */}
        <div>
          <div className="flex items-center justify-between mb-1">
            <button onClick={() => toggleSection("folders")} className="text-sm font-semibold text-muted-foreground hover:text-foreground">
              {t("fileExplorer:folders")}
            </button>
            {sidebarCollapsed.folders ? (
              <button onClick={() => toggleSection("folders")} className="text-xs text-muted-foreground hover:text-foreground">{t("fileExplorer:expand")}</button>
            ) : (
              <button onClick={() => setNewFolderOpen(true)} className="p-0.5 hover:bg-muted rounded" title={t("fileExplorer:newFolder")}>
                <FolderPlus className="h-3.5 w-3.5 text-muted-foreground" />
              </button>
            )}
          </div>
          {!sidebarCollapsed.folders && <div className="space-y-0.5">
            <button
              onClick={() => { setShowRecent(true); setShowFavorites(false); setShowTrash(false); setActiveFolderId(null); setSidebarOpen(false); if (isSearching) navigate("/", { replace: true }); }}
              className={`w-full text-left text-sm px-2 py-1 rounded flex items-center gap-1.5 ${showRecent ? "bg-primary/10 text-primary font-medium" : "hover:bg-muted"}`}
            >
              <Clock className={`h-3.5 w-3.5`} />
              <span className="truncate">{t("fileExplorer:recentItems")}</span>
            </button>
            <button
              onClick={() => { setShowFavorites(true); setShowRecent(false); setShowTrash(false); setActiveFolderId(null); setSidebarOpen(false); if (isSearching) navigate("/", { replace: true }); }}
              className={`w-full text-left text-sm px-2 py-1 rounded flex items-center gap-1.5 ${showFavorites ? "bg-primary/10 text-primary font-medium" : "hover:bg-muted"}`}
            >
              <Star className={`h-3.5 w-3.5 ${showFavorites ? "fill-primary" : ""}`} />
              <span className="truncate">{t("fileExplorer:favorites")}</span>
              {favoriteIds.size > 0 && <span className="ml-auto text-xs text-muted-foreground">{favoriteIds.size}</span>}
            </button>
            <DropTarget folderId={null} onDrop={handleDropOnFolder} onFolderDrop={handleDropFolderOnFolder} label={t("fileExplorer:all")} count={allDocCount} isActive={activeFolderId === null && !showTrash && !showFavorites && !showRecent} onClick={() => selectFolder(null)} icon={<FolderIcon className="h-3.5 w-3.5" />} />
            <DropTarget folderId={null} onDrop={handleDropOnFolder} onFolderDrop={handleDropFolderOnFolder} label={t("fileExplorer:unfiled")} count={unfiledCount} isActive={activeFolderId === "unfiled" && !showTrash} onClick={() => selectFolder("unfiled")} icon={<FileText className="h-3.5 w-3.5" />} />
            {folderTree.map((node) => (
              <FolderTreeItem
                key={node.id}
                node={node}
                activeFolderId={activeFolderId}
                onSelect={(id) => selectFolder(id)}
                onDrop={handleDropOnFolder}
                onFolderDrop={handleDropFolderOnFolder}
                onContextMenu={handleFolderContextMenu}
                expandedIds={expandedFolderIds}
                onToggleExpand={toggleFolderExpand}
              />
            ))}
          </div>}
        </div>

        <Separator />

        {/* Tags */}
        <div>
          <div className="flex items-center justify-between mb-1">
            <button onClick={() => toggleSection("tags")} className="text-sm font-semibold text-muted-foreground hover:text-foreground">
              {t("fileExplorer:tags")}
            </button>
            {sidebarCollapsed.tags ? (
              <button onClick={() => toggleSection("tags")} className="text-xs text-muted-foreground hover:text-foreground">{t("fileExplorer:expand")}</button>
            ) : (
              <button onClick={() => setNewTagOpen(true)} className="p-0.5 hover:bg-muted rounded" title={t("fileExplorer:newTag")}>
                <Plus className="h-3.5 w-3.5 text-muted-foreground" />
              </button>
            )}
          </div>
          {!sidebarCollapsed.tags && <div className="space-y-0.5">
            {allTags.map((tag) => (
              <SidebarTagItem
                key={tag.id}
                tag={tag}
                isActive={activeTags.includes(tag.name)}
                onSelect={() => {
                  if (!confirmDiscardNote()) return;
                  noteDirtyRef.current = false;
                  setActiveTags((prev) => prev.includes(tag.name) ? prev.filter((t) => t !== tag.name) : [...prev, tag.name]);
                  setActiveNoteId(null);
                  setActiveNote(null);
                  setShowTrash(false);
                  setShowFavorites(false);
                  setSidebarOpen(false);
                  if (isSearching) navigate("/", { replace: true });
                }}
                onDeleted={() => {
                  setAllTags((prev) => prev.filter((t) => t.id !== tag.id));
                  setActiveTags((prev) => prev.filter((t) => t !== tag.name));
                  load(true);
                }}
                onEdit={(t) => { setEditingTag(t); setEditTagName(t.name); setEditTagColor(t.color || "#6b7280"); }}
              />
            ))}
          </div>}
        </div>

        <Separator />

        {/* Notes */}
        <NoteSidebarItems
          notes={noteTree}
          activeNoteId={activeNoteId}
          onSelect={handleSelectNote}
          onCreateNote={handleCreateNote}
          onContextMenu={setNoteCtxMenu}
          onMoveNote={handleMoveNote}
          collapsed={!!sidebarCollapsed.notes}
          onToggleCollapse={() => toggleSection("notes")}
        />

        {/* Search History */}
        {searchHistory.length > 0 && (
          <>
            <Separator />
            <div>
              <div className="flex items-center justify-between mb-1">
                <button onClick={() => toggleSection("history")} className="text-sm font-semibold text-muted-foreground hover:text-foreground">
                  {t("fileExplorer:searchHistory")}
                </button>
                {sidebarCollapsed.history ? (
                  <button onClick={() => toggleSection("history")} className="text-xs text-muted-foreground hover:text-foreground">{t("fileExplorer:expand")}</button>
                ) : (
                  <button
                    onClick={() => { if (confirm(t("fileExplorer:deleteSearchHistory"))) { searchHistory.filter((e) => !e.pinned).forEach((e) => deleteConversation(e.query).catch(() => {})); setSearchHistory(clearUnpinnedSearchHistory()); } }}
                    className="p-0.5 hover:bg-muted rounded text-muted-foreground"
                    title={t("fileExplorer:deleteUnpinnedTooltip")}
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
              {!sidebarCollapsed.history && <div className="space-y-0.5">
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
                      <Tooltip content={entry.query} onlyWhenTruncated><span className="truncate">{entry.query}</span></Tooltip>
                    </button>
                    <div className="hidden group-hover:flex items-center gap-0.5 mr-0.5">
                      <button
                        onClick={(e) => { e.stopPropagation(); setSearchHistory(togglePinSearchHistory(entry.query)); }}
                        className="p-0.5 hover:bg-muted rounded"
                        title={entry.pinned ? t("fileExplorer:unpin") : t("fileExplorer:pin")}
                      >
                        {entry.pinned ? <PinOff className="h-3 w-3 text-muted-foreground" /> : <Pin className="h-3 w-3 text-muted-foreground" />}
                      </button>
                      <button
                        onClick={(e) => { e.stopPropagation(); deleteConversation(entry.query).catch(() => {}); setSearchHistory(removeSearchHistory(entry.query)); }}
                        className="p-0.5 hover:bg-muted rounded"
                        title={t("common:delete")}
                      >
                        <X className="h-3 w-3 text-muted-foreground" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>}
            </div>
          </>
        )}

        {/* Trash — always at bottom */}
        <div className="mt-auto pt-4">
        <Separator />
        <TrashDropTarget
          isActive={showTrash}
          count={trashItems.length}
          onClick={() => {
            if (!confirmDiscardNote()) return;
            noteDirtyRef.current = false;
            setShowTrash(true);
            setActiveTags([]);
            setActiveNoteId(null);
            setActiveNote(null);
            loadTrash();
            setSidebarOpen(false);
          }}
          onDrop={handleDropOnTrash}
        />
        </div>
      </div>

      {/* Main content */}
      <div className="flex-1 min-w-0 flex flex-col gap-4 overflow-hidden px-0.5 pb-0.5">
        {/* Note editor view */}
        {activeNoteId && activeNote ? (
          <div className="flex-1 min-h-0 flex flex-col">
            <div className="flex items-center gap-2 mb-2">
              <Button variant="ghost" size="icon" className="md:hidden -ml-1 mr-1 shrink-0 h-12 w-12" onClick={() => setSidebarOpen(true)}>
                <Menu className="h-8 w-8" strokeWidth={2.5} />
              </Button>
              <Button variant="outline" size="sm" onClick={() => { if (!confirmDiscardNote()) return; noteDirtyRef.current = false; setActiveNoteId(null); setActiveNote(null); }}>
                <ChevronLeft className="h-4 w-4 mr-1" />{t("common:documentList")}
              </Button>
            </div>
            <Card className="flex-1 min-h-0 overflow-hidden !py-0 !gap-0">
              {notesReadonly ? (
                <div className="flex flex-col h-full">
                  <div className="flex items-center gap-2 px-4 py-2">
                    <h2 className="text-lg font-semibold">{activeNote.title}</h2>
                    <Badge variant="secondary" className="ml-auto text-xs">{t("common:readOnly")}</Badge>
                  </div>
                  {activeNote.updated_at && (
                    <div className="flex items-center gap-3 px-4 py-1 text-xs text-muted-foreground border-b">
                      <span>{t("common:updated")}: {new Date(activeNote.updated_at).toLocaleString("ja-JP", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })}</span>
                      {activeNote.updated_by_name && <span>by {activeNote.updated_by_name}</span>}
                      {activeNote.current_version != null && <span>v{activeNote.current_version}</span>}
                      <button
                        className="hover:text-foreground hover:underline cursor-pointer"
                        onClick={() => {
                          const item = items.find((i) => i.id === activeNoteId);
                          if (item) setDetailDoc(item);
                          else setDetailDoc({ id: activeNoteId } as any);
                        }}
                      >
                        {activeNote.folder_path ? `${activeNote.folder_path}/${activeNote.title}` : activeNote.title}
                      </button>
                    </div>
                  )}
                  <div className="flex-1 overflow-auto">
                    <Suspense fallback={<div className="flex items-center justify-center h-32 text-muted-foreground">{t("common:loading")}</div>}>
                      <NoteReadonlyView initialContent={activeNote.note_content} />
                    </Suspense>
                  </div>
                </div>
              ) : (
                <Suspense fallback={<div className="flex items-center justify-center h-full text-muted-foreground">{t("common:loading")}</div>}>
                  <NoteEditor
                    key={activeNoteId}
                    noteId={activeNoteId}
                    title={activeNote.title}
                    initialContent={activeNote.note_content}
                    userName={meUser?.display_name || meUser?.username || "User"}
                    updatedAt={activeNote.updated_at}
                    updatedByName={activeNote.updated_by_name}
                    currentVersion={activeNote.current_version}
                    folderPath={activeNote.folder_path}
                    onTitleChange={(newTitle) => {
                      setActiveNote((prev) => prev ? { ...prev, title: newTitle } : prev);
                      loadNotes();
                    }}
                    onSaved={() => { loadNotes(); load(true); }}
                    onDirtyChange={(d) => { noteDirtyRef.current = d; }}
                    onFileClick={(id) => {
                      const item = items.find((i) => i.id === id);
                      if (item) setDetailDoc(item);
                      else setDetailDoc({ id } as any);
                    }}
                  />
                </Suspense>
              )}
            </Card>
          </div>
        ) : (
        <>
        {/* Header */}
        <div className="flex items-center justify-between">
          <Button variant="ghost" size="icon" className="md:hidden -ml-1 mr-1 shrink-0 h-12 w-12" onClick={() => setSidebarOpen(true)}>
            <Menu className="h-8 w-8" strokeWidth={2.5} />
          </Button>
          <h1 className="text-lg md:text-xl font-bold min-w-0 flex items-center overflow-hidden">
            {isSearching ? <span className="truncate">{t("fileExplorer:searchResult", { query: urlQ })}</span> : showTrash ? t("fileExplorer:trash") : showRecent ? t("fileExplorer:recentItems") : showFavorites ? t("fileExplorer:favorites") : activeTags.length > 0 ? (
              <span className="flex items-center gap-1.5">
                <span className="text-muted-foreground font-normal">{t("fileExplorer:tagLabel")}</span>
                {activeTags.map((t) => {
                  const tagInfo = allTags.find((at) => at.name === t);
                  return (
                    <span key={t} className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-sm">
                      <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: tagInfo?.color || "#6b7280" }} />
                      {t}
                    </span>
                  );
                })}
              </span>
            ) : folderBreadcrumb ? (
              folderBreadcrumb.map((seg, i) => (
                <span key={seg.id} className={`flex items-center ${i === folderBreadcrumb.length - 1 ? "min-w-0 overflow-hidden" : "shrink-0"}`}>
                  {i > 0 && <span className="mx-1 text-muted-foreground font-normal shrink-0">&gt;</span>}
                  <button
                    className={`${i === folderBreadcrumb.length - 1 ? "truncate" : "text-muted-foreground font-normal hover:text-foreground hover:underline whitespace-nowrap"}`}
                    onClick={() => selectFolder(seg.id)}
                  >
                    {seg.name}
                  </button>
                </span>
              ))
            ) : activeFolderId === "unfiled" ? t("fileExplorer:unfiled") : t("fileExplorer:documents")}
          </h1>
          {showTrash && !isSearching ? (
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={() => { setShowTrash(false); setTrashSelected(new Set()); }}>
                <ChevronLeft className="h-4 w-4 mr-1" />{t("common:back")}
              </Button>
              {trashItems.length > 0 && (
                <Button variant="destructive" size="sm" onClick={async () => {
                  if (!confirm(t("fileExplorer:emptyTrashConfirm"))) return;
                  const tid = toast.loading(t("fileExplorer:deleting", { count: trashItems.length }));
                  try {
                    const res = await emptyTrash();
                    toast.success(t("fileExplorer:purged", { count: res.purged }), { id: tid });
                    loadTrash();
                  } catch { toast.error(t("fileExplorer:deleteFailed"), { id: tid }); }
                }}>
                  <Trash2 className="h-4 w-4 mr-1" />{t("fileExplorer:emptyTrash")}
                </Button>
              )}
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <Button variant="outline" onClick={() => setCreateTextOpen(true)}>
                <FilePlus className="h-4 w-4 md:mr-2" /><span className="hidden md:inline">{t("fileExplorer:newCreate")}</span>
              </Button>
              <Button onClick={() => setUploadOpen(true)}>
                <Upload className="h-4 w-4 md:mr-2" /><span className="hidden md:inline">{t("fileExplorer:upload")}</span>
              </Button>
            </div>
          )}
        </div>

        {showTrash && !isSearching ? (
          /* Trash view */
          <div className="flex-1 min-h-0 overflow-auto">
            {trashItems.length === 0 ? (
              <p className="text-sm text-muted-foreground py-8 text-center">{t("fileExplorer:trashEmpty")}</p>
            ) : (
              <>
                <div className="flex items-center gap-2 p-2 bg-muted rounded-lg mb-3">
                  <span className="text-sm font-medium w-20">{trashSelected.size > 0 ? t("fileExplorer:selected", { count: trashSelected.size }) : "\u00A0"}</span>
                  <Button variant="outline" size="sm" disabled={trashSelected.size === 0} onClick={async () => {
                    try {
                      const res = await restoreFromTrash([...trashSelected]);
                      toast.success(t("fileExplorer:restored", { count: res.restored }));
                      setTrashSelected(new Set());
                      loadTrash();
                      load(true);
                      loadFolders();
                    } catch { toast.error(t("fileExplorer:restoreFailed")); }
                  }}>
                    <Undo2 className="h-3.5 w-3.5 mr-1" />{t("fileExplorer:restore")}
                  </Button>
                  <Button variant="destructive" size="sm" disabled={trashSelected.size === 0} onClick={async () => {
                    if (!confirm(t("fileExplorer:purgeConfirm"))) return;
                    const tid = toast.loading(t("fileExplorer:deleting", { count: trashSelected.size }));
                    try {
                      const res = await purgeFromTrash([...trashSelected]);
                      toast.success(t("fileExplorer:purged", { count: res.purged }), { id: tid });
                      setTrashSelected(new Set());
                      loadTrash();
                    } catch { toast.error(t("fileExplorer:deleteFailed"), { id: tid }); }
                  }}>
                    <Trash2 className="h-3.5 w-3.5 mr-1" />{t("fileExplorer:permanentDelete")}
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
                      <TableHead>{t("fileExplorer:title")}</TableHead>
                      <TableHead className="w-20">{t("fileExplorer:type")}</TableHead>
                      <TableHead className="w-36">{t("fileExplorer:deleteTrashDate")}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {trashItems.map((t) => (
                      <TableRow key={t.id} className="cursor-pointer" onClick={() => {
                        setTrashSelected((prev) => {
                          const next = new Set(prev);
                          next.has(t.id) ? next.delete(t.id) : next.add(t.id);
                          return next;
                        });
                      }}>
                        <TableCell>
                          <input
                            type="checkbox"
                            checked={trashSelected.has(t.id)}
                            onClick={(e) => e.stopPropagation()}
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
              <span className="text-xs text-muted-foreground">{t("fileExplorer:searchTokens")}</span>
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
            <option value="">{t("fileExplorer:typeFilter")}</option>
            {filterOptions.file_types.map((t) => (
              <option key={t} value={t}>{t.toUpperCase()}</option>
            ))}
          </select>
          <select
            value={filterCreatedBy}
            onChange={(e) => { setFilterCreatedBy(e.target.value); }}
            className="h-8 rounded-md border bg-background px-2 text-xs"
          >
            <option value="">{t("fileExplorer:creatorFilter")}</option>
            {filterOptions.creators.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
          <div className="hidden md:flex items-center gap-1">
            <DatePickerInput
              value={filterDateFrom}
              onChange={setFilterDateFrom}
              title={t("fileExplorer:dateFrom")}
            />
            <span className="text-xs text-muted-foreground">〜</span>
            <DatePickerInput
              value={filterDateTo}
              onChange={setFilterDateTo}
              title={t("fileExplorer:dateTo")}
            />
          </div>
          {isSearching && (
            <label className="flex items-center gap-1 text-xs cursor-pointer select-none">
              <input
                type="checkbox"
                checked={filterIncludeUnsearchable}
                onChange={(e) => setFilterIncludeUnsearchable(e.target.checked)}
                className="rounded border-gray-300"
              />
              <span className="text-muted-foreground">{t("fileExplorer:includeUnsearchable")}</span>
            </label>
          )}
          {(filterType || filterDateFrom || filterDateTo || filterCreatedBy || filterIncludeUnsearchable) && (
            <button
              onClick={() => { setFilterType(""); setFilterDateFrom(""); setFilterDateTo(""); setFilterCreatedBy(""); setFilterIncludeUnsearchable(false); }}
              className="text-xs text-muted-foreground hover:text-foreground underline"
            >
              {t("fileExplorer:clearFilters")}
            </button>
          )}
          <span className="text-sm text-muted-foreground ml-auto">{t("fileExplorer:totalCount", { count: total.toLocaleString() })}</span>
          {/* AI chat toggle */}
          {!chatOpen && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setChatOpen(true)}
              title={t("fileExplorer:openAiChat")}
            >
              <Sparkles className={`h-4 w-4 ${aiStreaming ? "animate-ai-glow text-primary" : ""}`} />
            </Button>
          )}
        </div>

        {/* Table */}
        <Card className="!py-0 !gap-0 flex-1 min-h-0 overflow-hidden flex flex-col">
          <div className="flex-1 min-h-0 overflow-auto" ref={scrollContainerRef}
          onDragOver={(e) => {
            if (e.dataTransfer.types.includes("application/x-folder-id") || e.dataTransfer.types.includes("application/x-doc-ids")) {
              e.preventDefault();
              e.dataTransfer.dropEffect = "move";
            }
          }}
          onDrop={(e) => {
            const draggedFolderId = e.dataTransfer.getData("application/x-folder-id");
            if (draggedFolderId) {
              e.preventDefault();
              e.stopPropagation();
              const targetFolderId = activeFolderId && activeFolderId !== "unfiled" ? activeFolderId : null;
              if (draggedFolderId !== targetFolderId) handleDropFolderOnFolder(draggedFolderId, targetFolderId);
              return;
            }
            const docData = e.dataTransfer.getData("application/x-doc-ids");
            if (docData) {
              e.preventDefault();
              e.stopPropagation();
              try {
                const ids: string[] = JSON.parse(docData);
                const targetFolderId = activeFolderId && activeFolderId !== "unfiled" ? activeFolderId : null;
                if (ids.length > 0) handleDropOnFolder(targetFolderId, ids);
              } catch { /* ignore */ }
              return;
            }
          }}
          onContextMenu={(e) => {
            // Only show blank-area menu when right-clicking on empty space (not on a row)
            if ((e.target as HTMLElement).closest("tr")) return;
            if (showTrash) return;
            e.preventDefault();
            setBlankCtx({ x: e.clientX, y: e.clientY });
          }}>
            <table className="doc-table w-full text-sm" style={{ tableLayout: "fixed", minWidth: 720 }}>
              <colgroup>
                <col />
                <col style={{ width: 64 }} />
                <col style={{ width: 88 }} />
                <col style={{ width: 96 }} />
                <col style={{ width: 96 }} />
                {showRecent && <col style={{ width: 96 }} />}
                <col style={{ width: 112 }} />
              </colgroup>
            <TableHeader className="sticky top-0 z-10 bg-background">
              <TableRow className="hover:bg-transparent">
                <TableHead className={`pl-4 ${isSearching ? "" : "cursor-pointer select-none"}`} onClick={isSearching ? undefined : () => handleSort("title")}>
                  <span className="flex items-center gap-2">
                    {t("fileExplorer:title")} {!isSearching && <SortIcon col="title" />}
                    {selected.size > 0 && (
                      <>
                        <span className="text-xs font-normal text-muted-foreground">{t("fileExplorer:selected", { count: selected.size })}</span>
                        <button
                          className="text-xs font-normal text-muted-foreground hover:text-foreground underline"
                          onClick={(e) => { e.stopPropagation(); setSelected(new Set()); }}
                        >
                          {t("fileExplorer:deselect")}
                        </button>
                      </>
                    )}
                  </span>
                </TableHead>
                <TableHead>{t("fileExplorer:type")}</TableHead>
                <TableHead className="!text-right">{t("fileExplorer:size")}</TableHead>
                <TableHead>{t("fileExplorer:creator")}</TableHead>
                <TableHead className={isSearching ? "" : "cursor-pointer select-none"} onClick={isSearching ? undefined : () => handleSort("updated_at")}>
                  <span className="flex items-center">{t("fileExplorer:updatedDate")} {!isSearching && <SortIcon col="updated_at" />}</span>
                </TableHead>
                {showRecent && <TableHead>{t("fileExplorer:lastViewed")}</TableHead>}
                <TableHead className="text-center">{t("fileExplorer:searchAi")}</TableHead>
              </TableRow>
            </TableHeader>
              <TableBody className="[&_tr:last-child]:border-b">
                {listFolders.map((folder) => (
                  <TableRow
                    key={`folder-${folder.id}`}
                    draggable
                    onDragStart={(e) => {
                      e.dataTransfer.setData("application/x-folder-id", folder.id);
                      e.dataTransfer.effectAllowed = "move";
                    }}
                    className={`cursor-pointer select-none ${dragOverFolderRowId === folder.id ? "bg-primary/20 ring-2 ring-primary/40" : ""}`}
                    onDoubleClick={() => selectFolder(folder.id)}
                    onContextMenu={(e) => { e.preventDefault(); handleFolderContextMenu(e, { ...folder, children: [] }); }}
                    onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; setDragOverFolderRowId(folder.id); }}
                    onDragLeave={() => setDragOverFolderRowId(null)}
                    onDrop={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      setDragOverFolderRowId(null);
                      // Check folder drag first
                      const draggedFolderId = e.dataTransfer.getData("application/x-folder-id");
                      if (draggedFolderId) {
                        if (draggedFolderId !== folder.id) handleDropFolderOnFolder(draggedFolderId, folder.id);
                        return;
                      }
                      try {
                        const ids: string[] = JSON.parse(e.dataTransfer.getData("application/x-doc-ids"));
                        if (ids.length > 0) handleDropOnFolder(folder.id, ids);
                      } catch { /* ignore */ }
                    }}
                  >
                    <TableCell className="pl-4 overflow-hidden max-w-0">
                      <Tooltip content={folder.name} onlyWhenTruncated>
                        <div className="font-medium text-sm truncate flex items-center gap-1.5">
                          <FolderIcon className="h-4 w-4 text-primary flex-shrink-0" />
                          {folder.name}
                        </div>
                      </Tooltip>
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline" className="text-xs">{t("fileExplorer:folderBadge")}</Badge>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground !text-right tabular-nums">
                      {folder.document_count > 0 ? t("fileExplorer:itemsCount", { count: folder.document_count }) : "-"}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {folder.owner_name ?? "-"}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {formatDate(folder.updated_at)}
                    </TableCell>
                    {showRecent && <TableCell />}
                    <TableCell />
                  </TableRow>
                ))}
                {items.map((item, rowIdx) => (
                  <TableRow
                    key={item.id}
                    data-row-idx={rowIdx}
                    draggable
                    onDragStart={(e) => handleDragStart(e, item.id)}
                    className={`cursor-pointer select-none ${selected.has(item.id) ? "bg-blue-50 dark:bg-blue-800/40 hover:bg-blue-50 dark:hover:bg-blue-800/40" : ""}`}
                    onClick={(e) => { handleRowClick(item, e); setFocusedIdx(rowIdx); }}
                    onDoubleClick={() => handleRowDoubleClick(item)}
                    onContextMenu={(e) => handleContextMenu(e, item)}
                    onTouchStart={(e) => {
                      const touch = e.touches[0];
                      const timerId = window.setTimeout(() => {
                        handleContextMenu(
                          { preventDefault: () => {}, clientX: touch.clientX, clientY: touch.clientY } as any,
                          item,
                        );
                      }, 500);
                      const row = e.currentTarget;
                      const cancel = () => { window.clearTimeout(timerId); row.removeEventListener("touchend", cancel); row.removeEventListener("touchmove", cancelMove); };
                      const cancelMove = (ev: TouchEvent) => { if (Math.abs(ev.touches[0].clientX - touch.clientX) > 10 || Math.abs(ev.touches[0].clientY - touch.clientY) > 10) cancel(); };
                      row.addEventListener("touchend", cancel, { once: true });
                      row.addEventListener("touchmove", cancelMove as any);
                    }}
                  >
                    <TableCell className="pl-4 overflow-hidden max-w-0">
                      <div className="font-medium text-sm truncate flex items-center gap-1">
                        <Tooltip content={item.title}><span className="truncate">{item.title}</span></Tooltip>
                        {item.is_note && <Tooltip content={t("fileExplorer:noteTooltip")}><BookOpenText className="h-3 w-3 text-primary flex-shrink-0" /></Tooltip>}
                        {favoriteIds.has(item.id) && <Star className="h-3 w-3 fill-muted-foreground text-muted-foreground flex-shrink-0" />}
                        {isSearching && (item as any).rrf_score != null && (
                          <span className={`ml-2 text-xs font-normal ${(item as any).rrf_score >= 0.5 ? "text-green-600" : "text-orange-500"}`}>{((item as any).rrf_score as number).toFixed(4)}</span>
                        )}
                      </div>
                      <div className="flex items-center gap-1 mt-0.5 flex-wrap truncate">
                        {(item as any).share_count > 0 && (
                          <span title={t("fileExplorer:sharedCount", { count: (item as any).share_count })}><Link className="h-3 w-3 text-primary flex-shrink-0" /></span>
                        )}
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
                    <TableCell className="text-xs text-muted-foreground !text-right tabular-nums">
                      {item.file_size ? formatBytes(item.file_size) : "-"}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {item.created_by_name ?? "-"}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {formatDate(item.updated_at)}
                    </TableCell>
                    {showRecent && <TableCell className="text-xs text-muted-foreground">{item.last_accessed_at ? formatDate(item.last_accessed_at) : "-"}</TableCell>}
                    <TableCell onClick={(e) => e.stopPropagation()}>
                      <div className="flex items-center justify-center gap-2">
                        <button
                          title={item.searchable ? t("fileExplorer:searchTarget") : t("fileExplorer:searchExcluded")}
                          className={`p-1 rounded transition-colors ${item.searchable ? "text-primary" : "text-muted-foreground/30 hover:text-muted-foreground"}`}
                          onClick={() => handleToggleFlag(item, "searchable")}
                        >
                          <SearchIcon className="h-4 w-4" />
                        </button>
                        <button
                          title={item.ai_knowledge ? t("fileExplorer:aiKnowledgeTarget") : t("fileExplorer:aiKnowledgeExcluded")}
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
                    <TableCell colSpan={showRecent ? 7 : 6} className="text-center py-8 text-muted-foreground">
                      {t("fileExplorer:noDocuments")}
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </table>
            {/* Infinite scroll sentinel */}
            {hasMore && <div ref={sentinelRef} className="h-4" />}
            {loading && items.length > 0 && (
              <div className="flex justify-center py-2 text-sm text-muted-foreground">{t("common:loading")}</div>
            )}
          </div>
        </Card>

        {/* Context menu */}
        {contextMenu && (
          <DocumentContextMenu
            menu={contextMenu}
            selectedCount={selected.size}
            shareEnabled={shareEnabled}
            isFavorited={favoriteIds.has(contextMenu.item.id)}
            onClose={() => setContextMenu(null)}
            onAction={contextAction}
          />
        )}

        {/* Blank area context menu */}
        {blankCtx && (
          <>
            <div className="fixed inset-0 z-50" onClick={() => setBlankCtx(null)} onContextMenu={(e) => { e.preventDefault(); setBlankCtx(null); }} />
            <div
              className="fixed z-50 min-w-[160px] rounded-lg bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10 animate-in fade-in-0 zoom-in-95"
              style={{ left: blankCtx.x, top: blankCtx.y }}
            >
              <button className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent hover:text-accent-foreground" onClick={() => { setNewFolderParent(activeFolderId && activeFolderId !== "unfiled" ? activeFolderId : null); setNewFolderOpen(true); setBlankCtx(null); }}>
                <FolderPlus className="h-4 w-4" />{t("fileExplorer:contextMenu.newFolder")}
              </button>
              <button className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent hover:text-accent-foreground" onClick={() => { setCreateTextOpen(true); setBlankCtx(null); }}>
                <FilePlus className="h-4 w-4" />{t("fileExplorer:contextMenu.newText")}
              </button>
              <button className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent hover:text-accent-foreground" onClick={() => { setUploadOpen(true); setBlankCtx(null); }}>
                <Upload className="h-4 w-4" />{t("fileExplorer:contextMenu.newUpload")}
              </button>
            </div>
          </>
        )}

        </>
        )}
        </>
        )}
      </div>

      {/* AI Chat Panel — slide-in drawer on mobile, width transition on desktop */}
      {/* Mobile: overlay backdrop */}
      {chatOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/30 md:hidden animate-in fade-in-0 duration-200"
          onClick={() => setChatOpen(false)}
        />
      )}
      <div
        className={`flex-shrink-0 min-h-0 overflow-hidden
          max-md:fixed max-md:inset-y-0 max-md:right-0 max-md:z-50 max-md:w-full max-md:max-w-lg
          max-md:transform max-md:transition-transform max-md:duration-300 max-md:ease-in-out
          md:transition-[width] md:duration-300 md:ease-in-out
          ${chatOpen
            ? "max-md:translate-x-0 md:w-[36rem]"
            : "max-md:translate-x-full md:w-0"
          }`}
      >
        <div className="h-full w-[36rem] max-md:w-full md:px-px md:py-px">
          <ChatPanel
            initialQuery={urlQ || undefined}
            onSourceClick={(docId) => {
              const found = items.find((i) => i.id === docId);
              if (found) setDetailDoc(found);
            }}
            onCollapse={() => setChatOpen(false)}
            onStreamingChange={setAiStreaming}
            collapsed={!chatOpen}
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
        onUpdated={(updated) => { load(true); loadFolders(); loadTags(); loadNotes(); if (updated && detailDoc && updated.id === detailDoc.id) setDetailDoc(updated); }}
        onTagsChanged={loadTags}
        onPrev={(() => {
          if (!detailDoc) return undefined;
          const idx = items.findIndex((i) => i.id === detailDoc.id);
          return idx > 0 ? () => {
            const prev = items[idx - 1];
            setDetailDoc(prev);
            setSelected(new Set([prev.id]));
            setFocusedIdx(idx - 1);
            const row = scrollContainerRef.current?.querySelector(`[data-row-idx="${idx - 1}"]`);
            row?.scrollIntoView({ block: "nearest" });
          } : undefined;
        })()}
        onNext={(() => {
          if (!detailDoc) return undefined;
          const idx = items.findIndex((i) => i.id === detailDoc.id);
          return idx >= 0 && idx < items.length - 1 ? () => {
            const next = items[idx + 1];
            setDetailDoc(next);
            setSelected(new Set([next.id]));
            setFocusedIdx(idx + 1);
            const row = scrollContainerRef.current?.querySelector(`[data-row-idx="${idx + 1}"]`);
            row?.scrollIntoView({ block: "nearest" });
          } : undefined;
        })()}
        isFavorited={detailDoc ? favoriteIds.has(detailDoc.id) : false}
        onToggleFavorite={detailDoc ? () => toggleFavorite(detailDoc.id) : undefined}
      />

      {/* Bulk action confirms */}
      <Dialog open={bulkActionOpen === "delete"} onOpenChange={() => setBulkActionOpen(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("fileExplorer:deleteConfirmTitle")}</DialogTitle>
            <DialogDescription>{t("fileExplorer:deleteConfirmDescription", { count: selected.size })}</DialogDescription>
          </DialogHeader>
          <DialogFooter showCloseButton>
            <Button variant="destructive" onClick={() => { handleBulkAction("delete"); loadTrash(); }}>{t("fileExplorer:deleteConfirmButton")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={bulkActionOpen === "reindex"} onOpenChange={(o) => setBulkActionOpen(o ? "reindex" : null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("fileExplorer:reindexTitle")}</DialogTitle>
            <DialogDescription>{t("fileExplorer:reindexDescription", { count: selected.size })}</DialogDescription>
          </DialogHeader>
          <DialogFooter showCloseButton>
            <Button
              onClick={async () => {
                const ids = [...selected];
                setBulkActionOpen(null);
                const tid = toast.loading(t("fileExplorer:reindexing", { done: 0, total: ids.length }));
                try {
                  const res = await bulkAction(ids, "reindex");
                  const jobIds = res.job_ids ?? [];
                  if (jobIds.length === 0) {
                    toast.error(t("fileExplorer:reindexNoTarget"), { id: tid });
                  } else {
                    const result = await pollJobsProgress(jobIds, (done, total) => {
                      toast.loading(t("fileExplorer:reindexing", { done, total }), { id: tid });
                    });
                    const msg = result.errors > 0
                      ? t("fileExplorer:reindexDoneWithErrors", { done: result.done, errors: result.errors })
                      : t("fileExplorer:reindexDone", { done: result.done });
                    toast.success(msg, { id: tid });
                  }
                  load(true);
                } catch {
                  toast.error(t("fileExplorer:reindexFailed"), { id: tid });
                }
              }}
            >
              {t("fileExplorer:reindexButton")}
            </Button>
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
            <DialogTitle>{t("fileExplorer:rename")}</DialogTitle>
          </DialogHeader>
          <Input
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && renameValue.trim() && renameTarget) {
                updateDocument(renameTarget.id, { title: renameValue.trim() })
                  .then(() => { setRenameTarget(null); setItems((prev) => prev.map((i) => i.id === renameTarget!.id ? { ...i, title: renameValue.trim() } : i)); if (renameTarget!.is_note) loadNotes(); toast.success(t("fileExplorer:renamed")); })
                  .catch(() => toast.error(t("fileExplorer:renameFailed")));
              }
            }}
            autoFocus
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setRenameTarget(null)}>{t("common:cancel")}</Button>
            <Button
              disabled={!renameValue.trim()}
              onClick={() => {
                if (!renameTarget) return;
                updateDocument(renameTarget.id, { title: renameValue.trim() })
                  .then(() => { setRenameTarget(null); setItems((prev) => prev.map((i) => i.id === renameTarget!.id ? { ...i, title: renameValue.trim() } : i)); if (renameTarget!.is_note) loadNotes(); toast.success(t("fileExplorer:renamed")); })
                  .catch(() => toast.error(t("fileExplorer:renameFailed")));
              }}
            >
              {t("fileExplorer:change")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* New Folder Dialog */}
      <Dialog open={newFolderOpen} onOpenChange={() => setNewFolderOpen(false)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{t("fileExplorer:newFolder")}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <Input placeholder={t("fileExplorer:newFolderName")} value={newFolderName} onChange={(e) => setNewFolderName(e.target.value)} autoFocus />
            <select
              value={newFolderParent ?? ""}
              onChange={(e) => setNewFolderParent(e.target.value || null)}
              className="w-full h-9 rounded-md border bg-background px-3 text-sm"
            >
              <option value="">{t("fileExplorer:rootLevel")}</option>
              {folders.map((f) => (
                <option key={f.id} value={f.id}>{f.name}</option>
              ))}
            </select>
          </div>
          <DialogFooter showCloseButton>
            <Button onClick={handleCreateFolder} disabled={!newFolderName.trim()}>{t("common:create")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* New Tag Dialog */}
      <Dialog open={newTagOpen} onOpenChange={() => setNewTagOpen(false)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{t("fileExplorer:newTag")}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <Input placeholder={t("fileExplorer:tagName")} value={newTagName} onChange={(e) => setNewTagName(e.target.value)} autoFocus />
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-sm text-muted-foreground">{t("fileExplorer:tagColor")}</span>
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
                title={t("fileExplorer:customColor")}
              />
            </div>
          </div>
          <DialogFooter showCloseButton>
            <Button onClick={handleCreateTag} disabled={!newTagName.trim()}>{t("common:create")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Tag Edit Dialog */}
      <Dialog open={!!editingTag} onOpenChange={(open) => { if (!open) setEditingTag(null); }}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{t("fileExplorer:tagEdit")}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <Input
              placeholder={t("fileExplorer:tagName")}
              value={editTagName}
              onChange={(e) => setEditTagName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && editTagName.trim() && editingTag) {
                  updateTag(editingTag.id, { name: editTagName.trim(), color: editTagColor })
                    .then((updated) => {
                      setAllTags((prev) => prev.map((t) => t.id === updated.id ? { ...t, ...updated } : t));
                      setActiveTags((prev) => prev.map((t) => t === editingTag!.name ? updated.name : t));
                      setEditingTag(null);
                      load(true);
                      toast.success(t("fileExplorer:tagUpdated"));
                    })
                    .catch(() => toast.error(t("fileExplorer:tagUpdateFailed")));
                }
              }}
              autoFocus
            />
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-sm text-muted-foreground">{t("fileExplorer:tagColor")}</span>
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
                title={t("fileExplorer:customColor")}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditingTag(null)}>{t("common:cancel")}</Button>
            <Button
              disabled={!editTagName.trim()}
              onClick={() => {
                if (!editingTag) return;
                updateTag(editingTag.id, { name: editTagName.trim(), color: editTagColor })
                  .then((updated) => {
                    setAllTags((prev) => prev.map((t) => t.id === updated.id ? { ...t, ...updated } : t));
                    setActiveTags((prev) => prev.map((t) => t === editingTag!.name ? updated.name : t));
                    setEditingTag(null);
                    load(true);
                    toast.success(t("fileExplorer:tagUpdated"));
                  })
                  .catch(() => toast.error(t("fileExplorer:tagUpdateFailed")));
              }}
            >
              {t("common:save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Overwrite confirmation (one by one) */}
      <Dialog open={overwriteQueue.length > 0} onOpenChange={() => handleOverwriteCancel()}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{t("fileExplorer:overwriteConfirmTitle")}</DialogTitle>
            <DialogDescription>
              {overwriteQueue.length > 1 ? t("fileExplorer:overwriteConfirmDescriptionMulti", { count: overwriteQueue.length }) : t("fileExplorer:overwriteConfirmDescription")}
            </DialogDescription>
          </DialogHeader>
          {overwriteQueue[0] && (
            <div className="text-sm bg-muted rounded-md p-3">
              <p className="font-medium">{overwriteQueue[0].name}</p>
              <p className="text-muted-foreground">{formatBytes(overwriteQueue[0].size)}</p>
            </div>
          )}
          <div className="flex gap-2 justify-end flex-wrap">
            {overwriteQueue.length > 1 && (
              <>
                <Button variant="outline" onClick={handleOverwriteSkipAll}>{t("fileExplorer:overwrite.skipAll")}</Button>
                <Button variant="outline" className="text-destructive border-destructive/50 hover:text-destructive" onClick={handleOverwriteAll}>{t("fileExplorer:overwrite.overwriteAll")}</Button>
              </>
            )}
            <Button variant="outline" onClick={handleOverwriteSkip}>{t("fileExplorer:overwrite.skip")}</Button>
            <Button variant="destructive" onClick={handleOverwriteConfirm}>{t("fileExplorer:overwrite.overwrite")}</Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Move duplicate confirmation */}
      <Dialog open={!!pendingMove} onOpenChange={() => handleMoveCancel()}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{t("fileExplorer:moveDuplicate.title")}</DialogTitle>
            <DialogDescription>
              {t("fileExplorer:moveDuplicateDescription", { count: pendingMove?.duplicateNames.length })}
            </DialogDescription>
          </DialogHeader>
          {pendingMove && (
            <div className="text-sm bg-muted rounded-md p-3 max-h-40 overflow-auto space-y-1">
              {pendingMove.duplicateNames.map((name) => (
                <p key={name} className="font-medium">{name}</p>
              ))}
            </div>
          )}
          <div className="flex gap-2 justify-end">
            <Button variant="outline" onClick={handleMoveCancel}>{t("common:cancel")}</Button>
            <Button variant="outline" onClick={handleMoveSkip}>{t("fileExplorer:moveDuplicate.skip")}</Button>
            <Button variant="destructive" onClick={handleMoveOverwrite}>{t("fileExplorer:moveDuplicate.overwrite")}</Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Note context menu */}
      {noteCtxMenu && (
        <>
          <div className="fixed inset-0 z-50" onClick={() => setNoteCtxMenu(null)} onContextMenu={(e) => { e.preventDefault(); setNoteCtxMenu(null); }} />
          <div
            className="fixed z-50 min-w-[160px] rounded-lg bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10 animate-in fade-in-0 zoom-in-95"
            style={{ left: noteCtxMenu.x, top: noteCtxMenu.y }}
          >
            <button
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent hover:text-accent-foreground"
              onClick={() => { handleCreateNote(noteCtxMenu.noteId); setNoteCtxMenu(null); }}
            >
              <Plus className="h-4 w-4" />{t("fileExplorer:noteCtx.createSub")}
            </button>
            <div className="-mx-1 my-1 h-px bg-border" />
            <button
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-destructive hover:bg-destructive/10"
              onClick={() => { setNoteDeleteTarget({ noteId: noteCtxMenu.noteId, title: noteCtxMenu.title }); setNoteCtxMenu(null); }}
            >
              <Trash2 className="h-4 w-4" />{t("common:delete")}
            </button>
          </div>
        </>
      )}

      {/* Folder context menu */}
      {folderCtx && (
        <>
          <div className="fixed inset-0 z-50" onClick={() => setFolderCtx(null)} onContextMenu={(e) => { e.preventDefault(); setFolderCtx(null); }} />
          <div
            className="fixed z-50 min-w-[160px] rounded-lg bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10 animate-in fade-in-0 zoom-in-95"
            style={{ left: folderCtx.x, top: folderCtx.y }}
          >
            <button className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent hover:text-accent-foreground" onClick={() => { setFolderRenameTarget(folderCtx.node); setFolderRenameValue(folderCtx.node.name); setFolderCtx(null); }}>
              <Pencil className="h-4 w-4" />{t("fileExplorer:folderCtx.rename")}
            </button>
            <button className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent hover:text-accent-foreground" onClick={() => { setFolderPermsTarget(folderCtx.node); setFolderCtx(null); }}>
              <Shield className="h-4 w-4" />{t("fileExplorer:folderCtx.permissions")}
            </button>
            <button className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent hover:text-accent-foreground" onClick={() => { setNewFolderParent(folderCtx.node.id); setNewFolderOpen(true); setFolderCtx(null); }}>
              <FolderPlus className="h-4 w-4" />{t("fileExplorer:folderCtx.createSub")}
            </button>
            <div className="-mx-1 my-1 h-px bg-border" />
            <button className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-destructive hover:bg-destructive/10" onClick={() => { handleFolderDelete(folderCtx.node); setFolderCtx(null); }}>
              <Trash2 className="h-4 w-4" />{t("common:delete")}
            </button>
          </div>
        </>
      )}

      {/* Folder rename dialog */}
      <Dialog open={!!folderRenameTarget} onOpenChange={(open) => { if (!open) setFolderRenameTarget(null); }}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{t("fileExplorer:folderRenameTitle")}</DialogTitle>
          </DialogHeader>
          <Input
            value={folderRenameValue}
            onChange={(e) => setFolderRenameValue(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") handleFolderRename(); }}
            autoFocus
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setFolderRenameTarget(null)}>{t("common:cancel")}</Button>
            <Button disabled={!folderRenameValue.trim()} onClick={handleFolderRename}>{t("fileExplorer:change")}</Button>
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
        onSubmit={(entries) => {
          setUploadOpen(false);
          const hasFolders = entries.some((e) => e.folderPath !== "");
          if (hasFolders) {
            handleFolderUploadEntries(entries);
          } else {
            startUploadWithCheck(entries.map((e) => e.file));
          }
        }}
      />

      {/* Create Text Document Dialog */}
      <CreateTextDocumentDialog
        open={createTextOpen}
        onClose={() => { setCreateTextOpen(false); setCreateTextFolderId(null); }}
        folders={folders}
        currentFolderId={createTextFolderId ?? uploadFolderId}
        onCreated={() => { setCreateTextOpen(false); setCreateTextFolderId(null); load(true); }}
      />

      {/* Note Delete Dialog */}
      <Dialog open={!!noteDeleteTarget} onOpenChange={(open) => { if (!open) setNoteDeleteTarget(null); }}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{t("fileExplorer:noteDeleteTitle")}</DialogTitle>
            <DialogDescription>
              {t("fileExplorer:noteDeleteDescription", { title: noteDeleteTarget?.title })}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <label className={`flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${noteDeleteMode === "remove" ? "border-primary bg-primary/5" : "hover:bg-muted"}`}>
              <input type="radio" name="noteDeleteMode" checked={noteDeleteMode === "remove"} onChange={() => setNoteDeleteMode("remove")} className="mt-0.5" />
              <div>
                <div className="text-sm font-medium">{t("fileExplorer:noteDeleteRemove")}</div>
                <div className="text-xs text-muted-foreground">{t("fileExplorer:noteDeleteRemoveHint")}</div>
              </div>
            </label>
            <label className={`flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${noteDeleteMode === "delete" ? "border-destructive bg-destructive/5" : "hover:bg-muted"}`}>
              <input type="radio" name="noteDeleteMode" checked={noteDeleteMode === "delete"} onChange={() => setNoteDeleteMode("delete")} className="mt-0.5" />
              <div>
                <div className="text-sm font-medium">{t("fileExplorer:noteDeleteFile")}</div>
                <div className="text-xs text-muted-foreground">{t("fileExplorer:noteDeleteFileHint")}</div>
              </div>
            </label>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setNoteDeleteTarget(null)}>{t("common:cancel")}</Button>
            <Button
              variant="destructive"
              onClick={async () => {
                if (!noteDeleteTarget) return;
                const { noteId, title } = noteDeleteTarget;
                setNoteDeleteTarget(null);
                if (noteDeleteMode === "remove") {
                  handleRemoveNote(noteId, title);
                } else {
                  handleDeleteNoteWithFile(noteId, title);
                }
              }}
            >
              {t("common:delete")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Upload Progress Panel (3+ files) */}
      {queueState && (
        <UploadProgressPanel
          state={queueState}
          onAbort={() => queueManager.abort()}
          onClear={() => queueManager.clear()}
        />
      )}
    </div>
  );
}
