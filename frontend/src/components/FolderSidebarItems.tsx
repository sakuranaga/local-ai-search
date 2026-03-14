import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import {
  ChevronDown,
  ChevronRightIcon,
  FolderIcon,
  FolderOpen,
  Pencil,
  Trash2,
} from "lucide-react";
import {
  updateTag,
  deleteTag,
  type Folder,
  type TagInfo,
} from "@/lib/api";
import type { FolderNode } from "@/lib/fileExplorerHelpers";

// ---------------------------------------------------------------------------
// Sidebar Tag Item (with rename / delete)
// ---------------------------------------------------------------------------

export function SidebarTagItem({
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

export function DropTarget({
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
      <Trash2 className="h-3.5 w-3.5" />ゴミ箱
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
  onContextMenu,
  depth = 0,
}: {
  node: FolderNode;
  activeFolderId: string | null;
  onSelect: (id: string) => void;
  onDrop: (folderId: string | null, docIds: string[]) => void;
  onContextMenu: (e: React.MouseEvent, node: FolderNode) => void;
  depth?: number;
}) {
  const [expanded, setExpanded] = useState(depth < 2);
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
    try {
      const ids: string[] = JSON.parse(e.dataTransfer.getData("application/x-doc-ids"));
      if (ids.length > 0) onDrop(node.id, ids);
    } catch { /* ignore */ }
  }

  return (
    <div>
      <div
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
          onClick={() => hasChildren && setExpanded(!expanded)}
          className={`p-0.5 ${hasChildren ? "" : "invisible"}`}
        >
          {expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRightIcon className="h-3 w-3" />}
        </button>
        <button onClick={() => onSelect(node.id)} className="flex items-center gap-1 flex-1 truncate text-left">
          {isActive || dragOver ? <FolderOpen className="h-3.5 w-3.5 flex-shrink-0" /> : <FolderIcon className="h-3.5 w-3.5 flex-shrink-0" />}
          <span className="truncate">{node.name}</span>
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
          onContextMenu={onContextMenu}
          depth={depth + 1}
        />
      ))}
    </div>
  );
}
