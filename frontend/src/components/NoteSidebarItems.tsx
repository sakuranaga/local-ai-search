import { useCallback, useState } from "react";
import {
  BookOpenText,
  Plus,
  ChevronRight,
  ChevronDown,
} from "lucide-react";
import { Tooltip } from "@/components/ui/tooltip";
import type { NoteTreeItem } from "@/lib/api/types";

export interface NoteContextMenuState {
  x: number;
  y: number;
  noteId: string;
  title: string;
}

type DropZone = "before" | "inside" | "after";

interface DropIndicator {
  noteId: string;
  zone: DropZone;
}

function computeZone(e: React.DragEvent): DropZone {
  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
  const y = e.clientY - rect.top;
  const h = rect.height;
  if (y < h * 0.3) return "before";
  if (y > h * 0.7) return "after";
  return "inside";
}

interface NoteTreeItemProps {
  node: NoteTreeItem;
  activeNoteId: string | null;
  depth?: number;
  onSelect: (noteId: string) => void;
  onContextMenu?: (state: NoteContextMenuState) => void;
  draggedId: string | null;
  dropIndicator: DropIndicator | null;
  onDragStart: (noteId: string) => void;
  onDragEnd: () => void;
  onDropZoneChange: (indicator: DropIndicator | null) => void;
  onDrop: (targetNoteId: string, zone: DropZone, parentNoteId: string | null) => void;
}

function NoteTreeNode({
  node,
  activeNoteId,
  depth = 0,
  onSelect,
  onContextMenu,
  draggedId,
  dropIndicator,
  onDragStart,
  onDragEnd,
  onDropZoneChange,
  onDrop,
}: NoteTreeItemProps) {
  const [expanded, setExpanded] = useState(depth < 2);
  const hasChildren = node.children.length > 0;
  const isActive = activeNoteId === node.id;
  const isDragged = draggedId === node.id;

  const handleDragOver = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (!draggedId || draggedId === node.id) return;
      onDropZoneChange({ noteId: node.id, zone: computeZone(e) });
    },
    [draggedId, node.id, onDropZoneChange],
  );

  // Compute zone from event coordinates at drop time — don't rely on state
  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (!draggedId || draggedId === node.id) return;
      const zone = computeZone(e);
      onDrop(node.id, zone, node.parent_note_id);
    },
    [draggedId, node.id, node.parent_note_id, onDrop],
  );

  const isDropTarget = dropIndicator?.noteId === node.id;

  return (
    <>
      <div className="relative">
        {isDropTarget && dropIndicator.zone === "before" && (
          <div className="absolute top-0 left-2 right-2 h-0.5 bg-primary rounded-full z-10 pointer-events-none" />
        )}
        {isDropTarget && dropIndicator.zone === "after" && (
          <div className="absolute bottom-0 left-2 right-2 h-0.5 bg-primary rounded-full z-10 pointer-events-none" />
        )}

        <button
          draggable
          onDragStart={(e) => {
            e.dataTransfer.effectAllowed = "move";
            e.dataTransfer.setData("text/plain", node.id);
            onDragStart(node.id);
          }}
          onDragEnd={onDragEnd}
          onDragOver={handleDragOver}
          onDrop={handleDrop}
          onClick={() => onSelect(node.id)}
          onContextMenu={onContextMenu ? (e) => {
            e.preventDefault();
            e.stopPropagation();
            onContextMenu({ x: e.clientX, y: e.clientY, noteId: node.id, title: node.title });
          } : undefined}
          className={`w-full text-left text-sm px-2 py-1 rounded flex items-center gap-1.5 transition-colors ${
            isDragged
              ? "opacity-40"
              : isDropTarget && dropIndicator.zone === "inside"
                ? "bg-primary/20 ring-1 ring-primary"
                : isActive
                  ? "bg-primary/10 text-primary font-medium"
                  : "hover:bg-muted"
          }`}
          style={depth > 0 ? { paddingLeft: `${depth * 16 + 8}px` } : undefined}
        >
          {hasChildren && (
            <span
              className="flex-shrink-0 cursor-pointer"
              onClick={(e) => {
                e.stopPropagation();
                setExpanded(!expanded);
              }}
            >
              {expanded ? (
                <ChevronDown className="h-3.5 w-3.5" />
              ) : (
                <ChevronRight className="h-3.5 w-3.5" />
              )}
            </span>
          )}
          <BookOpenText className="h-3.5 w-3.5 flex-shrink-0" />
          <Tooltip content={node.title} onlyWhenTruncated>
            <span className="truncate">{node.title}</span>
          </Tooltip>
        </button>
      </div>

      {expanded &&
        hasChildren &&
        node.children.map((child) => (
          <NoteTreeNode
            key={child.id}
            node={child}
            activeNoteId={activeNoteId}
            depth={depth + 1}
            onSelect={onSelect}
            onContextMenu={onContextMenu}
            draggedId={draggedId}
            dropIndicator={dropIndicator}
            onDragStart={onDragStart}
            onDragEnd={onDragEnd}
            onDropZoneChange={onDropZoneChange}
            onDrop={onDrop}
          />
        ))}
    </>
  );
}

interface NoteSidebarProps {
  notes: NoteTreeItem[];
  activeNoteId: string | null;
  onSelect: (noteId: string) => void;
  onCreateNote?: (parentId?: string | null) => void;
  onContextMenu?: (state: NoteContextMenuState) => void;
  onMoveNote?: (noteId: string, parentNoteId: string | null, position: number) => void;
}

export default function NoteSidebarItems({
  notes,
  activeNoteId,
  onSelect,
  onCreateNote,
  onContextMenu,
  onMoveNote,
}: NoteSidebarProps) {
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [dropIndicator, setDropIndicator] = useState<DropIndicator | null>(null);

  const handleDragEnd = useCallback(() => {
    setDraggedId(null);
    setDropIndicator(null);
  }, []);

  // Find a node and its parent in the tree
  const findNode = useCallback(
    (id: string, tree: NoteTreeItem[], parent: NoteTreeItem | null = null): { node: NoteTreeItem; parent: NoteTreeItem | null } | null => {
      for (const n of tree) {
        if (n.id === id) return { node: n, parent };
        const found = findNode(id, n.children, n);
        if (found) return found;
      }
      return null;
    },
    [],
  );

  // Check if nodeId is ancestor of targetId
  const isAncestor = useCallback(
    (nodeId: string, targetId: string): boolean => {
      const found = findNode(nodeId, notes);
      if (!found) return false;
      const check = (children: NoteTreeItem[]): boolean => {
        for (const child of children) {
          if (child.id === targetId) return true;
          if (check(child.children)) return true;
        }
        return false;
      };
      return check(found.node.children);
    },
    [findNode, notes],
  );

  const handleDrop = useCallback(
    (targetNoteId: string, zone: DropZone, targetParentNoteId: string | null) => {
      if (!draggedId || !onMoveNote || draggedId === targetNoteId) return;
      if (isAncestor(draggedId, targetNoteId)) return;

      if (zone === "inside") {
        // Reparent as first child of target
        onMoveNote(draggedId, targetNoteId, 0);
      } else {
        // before / after — insert among target's siblings
        const targetInfo = findNode(targetNoteId, notes);
        if (!targetInfo) return;
        const siblings = targetInfo.parent ? targetInfo.parent.children : notes;

        // Compute position excluding the dragged item
        let pos = 0;
        for (const sib of siblings) {
          if (sib.id === draggedId) continue;
          if (sib.id === targetNoteId) {
            if (zone === "after") pos++;
            break;
          }
          pos++;
        }
        onMoveNote(draggedId, targetParentNoteId, pos);
      }

      setDraggedId(null);
      setDropIndicator(null);
    },
    [draggedId, onMoveNote, notes, findNode, isAncestor],
  );

  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <h3 className="text-sm font-semibold text-muted-foreground">ノート</h3>
        {onCreateNote && (
          <button
            onClick={() => onCreateNote(null)}
            className="p-0.5 hover:bg-muted rounded"
            title="新規ノート"
          >
            <Plus className="h-3.5 w-3.5 text-muted-foreground" />
          </button>
        )}
      </div>
      <div className="space-y-0.5">
        {notes.map((node) => (
          <NoteTreeNode
            key={node.id}
            node={node}
            activeNoteId={activeNoteId}
            onSelect={onSelect}
            onContextMenu={onContextMenu}
            draggedId={draggedId}
            dropIndicator={dropIndicator}
            onDragStart={setDraggedId}
            onDragEnd={handleDragEnd}
            onDropZoneChange={setDropIndicator}
            onDrop={handleDrop}
          />
        ))}
        {notes.length === 0 && (
          <div className="px-2 py-1 text-xs text-muted-foreground">
            ノートはありません
          </div>
        )}
      </div>
    </div>
  );
}
