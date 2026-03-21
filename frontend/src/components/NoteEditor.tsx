import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BlockNoteEditor } from "@blocknote/core";
import { useCreateBlockNote } from "@blocknote/react";
import { BlockNoteView } from "@blocknote/shadcn";
import * as Y from "yjs";
import { WebsocketProvider } from "y-websocket";
import { updateNote } from "@/lib/api/notes";
import { Save, Loader2 } from "lucide-react";
import "@blocknote/shadcn/style.css";

interface NoteEditorProps {
  noteId: string;
  title: string;
  initialContent: unknown;
  wsUrl?: string;
  userName?: string;
  userColor?: string;
  onTitleChange?: (title: string) => void;
  onSaved?: () => void;
  onDirtyChange?: (dirty: boolean) => void;
}

export default function NoteEditor({
  noteId,
  title,
  initialContent,
  wsUrl,
  userName = "User",
  userColor = "#3b82f6",
  onTitleChange,
  onSaved,
  onDirtyChange,
}: NoteEditorProps) {
  const [saving, setSaving] = useState(false);
  const [editTitle, setEditTitle] = useState(title);
  const editorRef = useRef<BlockNoteEditor | null>(null);

  // Yjs document and provider
  const { ydoc, provider } = useMemo(() => {
    if (!wsUrl) return { ydoc: null, provider: null };
    const doc = new Y.Doc();
    const prov = new WebsocketProvider(wsUrl, `note:${noteId}`, doc);
    prov.awareness.setLocalStateField("user", {
      name: userName,
      color: userColor,
    });
    return { ydoc: doc, provider: prov };
  }, [noteId, wsUrl, userName, userColor]);

  // Cleanup provider on unmount
  useEffect(() => {
    return () => {
      provider?.disconnect();
      ydoc?.destroy();
    };
  }, [provider, ydoc]);

  // Create BlockNote editor
  const editor = useCreateBlockNote(
    {
      ...(ydoc && provider
        ? {
            collaboration: {
              provider,
              fragment: ydoc.getXmlFragment("blocknote"),
              user: { name: userName, color: userColor },
            },
          }
        : {
            initialContent:
              initialContent && Array.isArray(initialContent) && initialContent.length > 0
                ? (initialContent as never)
                : undefined,
          }),
    },
    [noteId],
  );

  editorRef.current = editor;

  // Track unsaved changes
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);

  // Manual save
  const handleSave = useCallback(async () => {
    if (!editorRef.current) return;
    setSaving(true);
    try {
      const blocks = editorRef.current.document;
      await updateNote(noteId, {
        title: editTitle,
        note_content: blocks,
      });
      setDirty(false);
      onTitleChange?.(editTitle);
      onSaved?.();
    } catch {
      // ignore
    } finally {
      setSaving(false);
    }
  }, [noteId, editTitle, onTitleChange, onSaved]);

  // Save title on blur
  const handleTitleBlur = useCallback(async () => {
    if (editTitle !== title) {
      try {
        await updateNote(noteId, { title: editTitle });
        onTitleChange?.(editTitle);
      } catch {
        // ignore
      }
    }
  }, [noteId, editTitle, title, onTitleChange]);

  // Ctrl+S to save
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "s") {
        e.preventDefault();
        handleSave();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [handleSave]);

  // Warn before leaving with unsaved changes
  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (dirty) {
        e.preventDefault();
      }
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [dirty]);

  return (
    <div className="flex flex-col h-full">
      {/* Title bar */}
      <div className="flex items-center gap-2 px-4 py-2 border-b">
        <input
          className="flex-1 text-lg font-semibold bg-transparent outline-none"
          value={editTitle}
          onChange={(e) => setEditTitle(e.target.value)}
          onBlur={handleTitleBlur}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              (e.target as HTMLInputElement).blur();
            }
          }}
          placeholder="無題のノート"
        />
        <button
          onClick={handleSave}
          disabled={saving}
          className={`flex items-center gap-1 px-3 py-1 text-sm rounded-md disabled:opacity-50 ${
            dirty ? "bg-primary text-primary-foreground hover:bg-primary/90" : "bg-muted text-muted-foreground"
          }`}
        >
          {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
          {dirty ? "保存" : "保存済み"}
        </button>
      </div>

      {/* Editor */}
      <div className="flex-1 overflow-auto">
        <BlockNoteView
          editor={editor}
          onChange={() => setDirty(true)}
          theme="light"
        />
      </div>
    </div>
  );
}
