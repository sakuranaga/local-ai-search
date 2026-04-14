import { useState } from "react";
import { toast } from "sonner";
import { t } from "@/i18n";
import {
  ChevronDown,
  ChevronRightIcon,
  FolderIcon,
  FolderOpen,
  Pencil,
  Trash2,
} from "lucide-react";
import {
  deleteTag,
  type TagInfo,
} from "@/lib/api";
import { Tooltip } from "@/components/ui/tooltip";
import type { FolderNode } from "@/lib/fileExplorerHelpers";

// ---------------------------------------------------------------------------
// Sidebar Tag Item (with rename / delete)
// ---------------------------------------------------------------------------

export function SidebarTagItem({
  tag,
  isActive,
  onSelect,
  onDeleted,
  onEdit,
}: {
  tag: TagInfo & { document_count?: number };
  isActive: boolean;
  onSelect: () => void;
  onDeleted: () => void;
  onEdit: (tag: TagInfo) => void;
}) {
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null);

  return (
    <div className={`group flex items-center text-sm rounded ${isActive ? "bg-primary/10 font-medium" : "hover:bg-muted"}`}>
      <button
        onClick={onSelect}
        onContextMenu={(e) => { e.preventDefault(); setCtxMenu({ x: e.clientX, y: e.clientY }); }}
        className="flex items-center gap-1 flex-1 min-w-0 px-2 py-1"
      >
        <span className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ backgroundColor: tag.color || "#6b7280" }} />
        <Tooltip content={tag.name} onlyWhenTruncated><span className="truncate">{tag.name}</span></Tooltip>
        <span className="text-xs text-muted-foreground ml-auto">{tag.document_count ?? ""}</span>
      </button>

      {ctxMenu && (
        <>
          <div className="fixed inset-0 z-50" onClick={() => setCtxMenu(null)} onContextMenu={(e) => { e.preventDefault(); setCtxMenu(null); }} />
          <div
            className="fixed z-50 min-w-[140px] rounded-lg bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10 animate-in fade-in-0 zoom-in-95"
            style={{ left: ctxMenu.x, top: ctxMenu.y }}
          >
            <button className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent hover:text-accent-foreground" onClick={() => { setCtxMenu(null); onEdit(tag); }}>
              <Pencil className="h-4 w-4" />{t("common:edit")}
            </button>
            <div className="-mx-1 my-1 h-px bg-border" />
            <button
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-destructive hover:bg-destructive/10"
              onClick={async () => {
                setCtxMenu(null);
                if (!confirm(t("fileExplorer:tagDeleteConfirm", { name: tag.name }))) return;
                try {
                  await deleteTag(tag.id);
                  onDeleted();
                } catch { toast.error(t("fileExplorer:tagDeleteFailed")); }
              }}
            >
              <Trash2 className="h-4 w-4" />{t("common:delete")}
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

export function DropTarget({
  folderId,
  onDrop,
  onFolderDrop,
  label,
  count,
  isActive,
  onClick,
  icon,
}: {
  folderId: string | null;
  onDrop: (folderId: string | null, docIds: string[]) => void;
  onFolderDrop?: (draggedFolderId: string, targetFolderId: string | null) => void;
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
        const draggedFolderId = e.dataTransfer.getData("application/x-folder-id");
        if (draggedFolderId) {
          onFolderDrop?.(draggedFolderId, folderId);
          return;
        }
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
// Trash Drop Target
// ---------------------------------------------------------------------------

export function TrashDropTarget({
  isActive,
  count,
  onClick,
  onDrop,
}: {
  isActive: boolean;
  count: number;
  onClick: () => void;
  onDrop: (docIds: string[]) => void;
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
          if (ids.length > 0) onDrop(ids);
        } catch { /* ignore */ }
      }}
      className={`w-full text-left text-sm px-2 py-1 rounded flex items-center gap-1.5 transition-colors ${
        dragOver ? "bg-destructive/20 ring-2 ring-destructive/40" : isActive ? "bg-primary/10 text-primary font-medium" : "hover:bg-muted text-muted-foreground"
      }`}
    >
      <Trash2 className="h-3.5 w-3.5" />{t("fileExplorer:trash")}
      {count > 0 && <span className="ml-auto text-xs text-muted-foreground">{count}</span>}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Folder Tree Item (recursive, with drop target)
// ---------------------------------------------------------------------------

export function FolderTreeItem({
  node,
  activeFolderId,
  onSelect,
  onDrop,
  onFolderDrop,
  onContextMenu,
  expandedIds,
  onToggleExpand,
  depth = 0,
}: {
  node: FolderNode;
  activeFolderId: string | null;
  onSelect: (id: string) => void;
  onDrop: (folderId: string | null, docIds: string[]) => void;
  onFolderDrop?: (draggedFolderId: string, targetFolderId: string | null) => void;
  onContextMenu: (e: React.MouseEvent, node: FolderNode) => void;
  expandedIds: Set<string>;
  onToggleExpand: (id: string) => void;
  depth?: number;
}) {
  const expanded = expandedIds.has(node.id);
  const [dragOver, setDragOver] = useState(false);

  const isActive = activeFolderId === node.id;
  const hasChildren = node.children.length > 0;

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
    // Check for folder drag first
    const folderId = e.dataTransfer.getData("application/x-folder-id");
    if (folderId) {
      if (folderId !== node.id) onFolderDrop?.(folderId, node.id);
      return;
    }
    try {
      const ids: string[] = JSON.parse(e.dataTransfer.getData("application/x-doc-ids"));
      if (ids.length > 0) onDrop(node.id, ids);
    } catch { /* ignore */ }
  }

  return (
    <div>
      <div
        draggable
        onDragStart={(e) => {
          e.dataTransfer.setData("application/x-folder-id", node.id);
          e.dataTransfer.effectAllowed = "move";
          e.stopPropagation();
        }}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDropOnThis}
        onContextMenu={(e) => { e.preventDefault(); onContextMenu(e, node); }}
        className={`group flex items-center gap-0.5 text-sm rounded py-0.5 pr-2 transition-colors ${
          dragOver ? "bg-primary/20 ring-2 ring-primary/40" : isActive ? "bg-primary/10 text-primary font-medium" : "hover:bg-muted"
        }`}
        style={{ paddingLeft: `${depth * 12 + 2}px` }}
      >
        <button
          onClick={() => hasChildren && onToggleExpand(node.id)}
          className={`p-0.5 ${hasChildren ? "" : "invisible"}`}
        >
          {expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRightIcon className="h-3 w-3" />}
        </button>
        <button onClick={() => onSelect(node.id)} onDoubleClick={() => hasChildren && onToggleExpand(node.id)} className="flex items-center gap-1 flex-1 truncate text-left">
          {isActive || dragOver ? <FolderOpen className="h-3.5 w-3.5 flex-shrink-0" /> : <FolderIcon className="h-3.5 w-3.5 flex-shrink-0" />}
          <Tooltip content={node.name} onlyWhenTruncated>
            <span className="truncate">{node.name}</span>
          </Tooltip>
          {node.document_count > 0 && (
            <span className="text-xs text-muted-foreground ml-auto">{node.document_count}</span>
          )}
        </button>
      </div>
      {expanded && node.children.map((child) => (
        <FolderTreeItem
          key={child.id}
          node={child}
          activeFolderId={activeFolderId}
          onSelect={onSelect}
          onDrop={onDrop}
          onFolderDrop={onFolderDrop}
          onContextMenu={onContextMenu}
          expandedIds={expandedIds}
          onToggleExpand={onToggleExpand}
          depth={depth + 1}
        />
      ))}
    </div>
  );
}
