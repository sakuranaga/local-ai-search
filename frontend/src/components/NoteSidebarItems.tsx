import { useState } from "react";
import {
  BookOpenText,
  Plus,
  ChevronRight,
  ChevronDown,
  Trash2,
} from "lucide-react";
import { Tooltip } from "@/components/ui/tooltip";
import type { NoteTreeItem } from "@/lib/api/types";

export interface NoteContextMenuState {
  x: number;
  y: number;
  noteId: string;
  title: string;
}

interface NoteTreeItemProps {
  node: NoteTreeItem;
  activeNoteId: string | null;
  depth?: number;
  onSelect: (noteId: string) => void;
  onContextMenu: (state: NoteContextMenuState) => void;
}

function NoteTreeNode({
  node,
  activeNoteId,
  depth = 0,
  onSelect,
  onContextMenu,
}: NoteTreeItemProps) {
  const [expanded, setExpanded] = useState(depth < 2);
  const hasChildren = node.children.length > 0;
  const isActive = activeNoteId === node.id;

  return (
    <>
      <button
        onClick={() => onSelect(node.id)}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onContextMenu({ x: e.clientX, y: e.clientY, noteId: node.id, title: node.title });
        }}
        className={`w-full text-left text-sm px-2 py-1 rounded flex items-center gap-1.5 transition-colors ${
          isActive ? "bg-primary/10 text-primary font-medium" : "hover:bg-muted"
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
          />
        ))}
    </>
  );
}

interface NoteSidebarProps {
  notes: NoteTreeItem[];
  activeNoteId: string | null;
  onSelect: (noteId: string) => void;
  onCreateNote: (parentId?: string | null) => void;
  onContextMenu: (state: NoteContextMenuState) => void;
}

export default function NoteSidebarItems({
  notes,
  activeNoteId,
  onSelect,
  onCreateNote,
  onContextMenu,
}: NoteSidebarProps) {
  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <h3 className="text-sm font-semibold text-muted-foreground">ノート</h3>
        <button
          onClick={() => onCreateNote(null)}
          className="p-0.5 hover:bg-muted rounded"
          title="新規ノート"
        >
          <Plus className="h-3.5 w-3.5 text-muted-foreground" />
        </button>
      </div>
      <div className="space-y-0.5">
        {notes.map((node) => (
          <NoteTreeNode
            key={node.id}
            node={node}
            activeNoteId={activeNoteId}
            onSelect={onSelect}
            onContextMenu={onContextMenu}
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
