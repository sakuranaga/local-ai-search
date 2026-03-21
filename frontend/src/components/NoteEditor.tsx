import { memo, useCallback, useEffect, useRef, useState } from "react";
import { BlockNoteEditor } from "@blocknote/core";
import { useCreateBlockNote } from "@blocknote/react";
import { BlockNoteView } from "@blocknote/shadcn";
import * as Y from "yjs";
import { WebsocketProvider } from "y-websocket";
import { updateNote } from "@/lib/api/notes";
import { Save, Loader2, Wifi, WifiOff } from "lucide-react";
import { useTheme } from "next-themes";
import "@blocknote/shadcn/style.css";

interface NoteEditorProps {
  noteId: string;
  title: string;
  initialContent: unknown;
  userName?: string;
  userColor?: string;
  onTitleChange?: (title: string) => void;
  onSaved?: () => void;
  onDirtyChange?: (dirty: boolean) => void;
}

type ConnMode = "connecting" | "collaborative" | "local";

const SYNC_TIMEOUT_MS = 3000;

// Derive WebSocket URL from current page location
function getWsUrl() {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}/yjs`;
}

// ---------------------------------------------------------------------------
// Outer wrapper: probes Yjs connection, then renders inner editor
// ---------------------------------------------------------------------------

export default function NoteEditor(props: NoteEditorProps) {
  const [mode, setMode] = useState<ConnMode>("connecting");
  const [needsPopulate, setNeedsPopulate] = useState(false);
  const ydocRef = useRef<Y.Doc | null>(null);
  const providerRef = useRef<WebsocketProvider | null>(null);

  const { noteId, userName = "User", userColor = "#3b82f6" } = props;
  const userNameRef = useRef(userName);
  const userColorRef = useRef(userColor);
  userNameRef.current = userName;
  userColorRef.current = userColor;

  useEffect(() => {
    const doc = new Y.Doc();
    const provider = new WebsocketProvider(getWsUrl(), `note:${noteId}`, doc);
    provider.awareness.setLocalStateField("user", {
      name: userNameRef.current,
      color: userColorRef.current,
    });
    ydocRef.current = doc;
    providerRef.current = provider;

    let settled = false;

    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        provider.disconnect();
        provider.destroy();
        doc.destroy();
        ydocRef.current = null;
        providerRef.current = null;
        setMode("local");
      }
    }, SYNC_TIMEOUT_MS);

    const onSync = (synced: boolean) => {
      if (synced && !settled) {
        settled = true;
        clearTimeout(timeout);
        const fragment = doc.getXmlFragment("blocknote");
        setNeedsPopulate(fragment.length === 0);
        setMode("collaborative");
      }
    };
    provider.on("sync", onSync);

    return () => {
      settled = true;
      clearTimeout(timeout);
      provider.off("sync", onSync);
      provider.disconnect();
      provider.destroy();
      doc.destroy();
    };
  }, [noteId]);

  if (mode === "connecting") {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground gap-2">
        <Loader2 className="h-4 w-4 animate-spin" />
        接続中...
      </div>
    );
  }

  return (
    <NoteEditorInner
      {...props}
      ydoc={mode === "collaborative" ? ydocRef.current : null}
      provider={mode === "collaborative" ? providerRef.current : null}
      needsPopulate={needsPopulate}
      collaborative={mode === "collaborative"}
    />
  );
}

// ---------------------------------------------------------------------------
// Isolated title input — memo'd to prevent re-renders during IME composition
// ---------------------------------------------------------------------------

const TitleInput = memo(function TitleInput({
  defaultValue,
  onBlurRef,
  onInputRef,
  placeholder,
}: {
  defaultValue: string;
  onBlurRef: React.RefObject<((value: string) => void) | null>;
  onInputRef: React.RefObject<((value: string) => void) | null>;
  placeholder: string;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const composingRef = useRef(false);

  // Sync value from outside when not focused (e.g. after save updates title prop)
  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    if (document.activeElement === input) return;
    if (input.value !== defaultValue) {
      input.value = defaultValue;
    }
  }, [defaultValue]);

  return (
    <input
      ref={inputRef}
      className="flex-1 text-lg font-semibold bg-transparent outline-none"
      defaultValue={defaultValue}
      onCompositionStart={(e) => {
        composingRef.current = true;
        e.stopPropagation();
      }}
      onCompositionEnd={(e) => {
        composingRef.current = false;
        e.stopPropagation();
      }}
      onCompositionUpdate={(e) => e.stopPropagation()}
      onInput={(e) => onInputRef.current?.((e.target as HTMLInputElement).value)}
      onBlur={(e) => onBlurRef.current?.(e.currentTarget.value)}
      onKeyDown={(e) => {
        if (composingRef.current || e.nativeEvent.isComposing || e.keyCode === 229) {
          return;
        }
        if (e.key === "Enter") {
          e.preventDefault();
          (e.target as HTMLInputElement).blur();
        }
      }}
      placeholder={placeholder}
    />
  );
});

// ---------------------------------------------------------------------------
// Inner editor: creates BlockNote with resolved mode (collab or local)
// ---------------------------------------------------------------------------

interface InnerProps extends NoteEditorProps {
  ydoc: Y.Doc | null;
  provider: WebsocketProvider | null;
  needsPopulate: boolean;
  collaborative: boolean;
}

function NoteEditorInner({
  noteId,
  title,
  initialContent,
  userName = "User",
  userColor = "#3b82f6",
  onTitleChange,
  onSaved,
  onDirtyChange,
  ydoc,
  provider,
  needsPopulate,
  collaborative,
}: InnerProps) {
  const { resolvedTheme } = useTheme();
  const [saving, setSaving] = useState(false);
  const editorRef = useRef<BlockNoteEditor | null>(null);
  const titleRef = useRef(title);

  const parsedInitial =
    initialContent && Array.isArray(initialContent) && initialContent.length > 0
      ? (initialContent as never)
      : undefined;

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
            initialContent: parsedInitial,
          }),
    },
    [noteId],
  );

  editorRef.current = editor;

  // Suppress onChange during initialization (Yjs sync + replaceBlocks)
  const initializingRef = useRef(true);

  // Populate empty Yjs doc from DB content
  useEffect(() => {
    if (needsPopulate && parsedInitial) {
      requestAnimationFrame(() => {
        try {
          editor.replaceBlocks(editor.document, parsedInitial as never);
        } catch {
          // ignore if editor not ready
        }
        // Allow a tick for onChange to fire from replaceBlocks, then clear flag
        setTimeout(() => { initializingRef.current = false; }, 100);
      });
    } else {
      // No populate needed — still wait for initial Yjs sync onChange
      setTimeout(() => { initializingRef.current = false; }, 500);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [needsPopulate]);

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
        title: titleRef.current,
        note_content: blocks,
      });
      setDirty(false);
      onTitleChange?.(titleRef.current);
      onSaved?.();
    } catch {
      // ignore
    } finally {
      setSaving(false);
    }
  }, [noteId, onTitleChange, onSaved]);

  // Track title changes in real-time (via ref to avoid re-rendering TitleInput)
  const titleInputRef = useRef<((value: string) => void) | null>(null);
  titleInputRef.current = (value: string) => {
    titleRef.current = value;
    if (value !== title) {
      setDirty(true);
    }
  };

  // Also sync on blur
  const titleBlurRef = useRef<((value: string) => void) | null>(null);
  titleBlurRef.current = (value: string) => {
    titleRef.current = value;
  };

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
        <TitleInput
          defaultValue={title}
          onBlurRef={titleBlurRef}
          onInputRef={titleInputRef}
          placeholder="無題のノート"
        />
        {collaborative ? (
          <Wifi className="w-4 h-4 text-green-500 flex-shrink-0" title="共同編集: 接続中" />
        ) : (
          <WifiOff className="w-4 h-4 text-muted-foreground flex-shrink-0" title="オフラインモード" />
        )}
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

      {/* Editor — isolate composition events to prevent ProseMirror from interfering with title input IME */}
      <div
        className="flex-1 overflow-auto"
        onCompositionStart={(e) => e.stopPropagation()}
        onCompositionEnd={(e) => e.stopPropagation()}
        onCompositionUpdate={(e) => e.stopPropagation()}
      >
        <BlockNoteView
          editor={editor}
          onChange={() => { if (!initializingRef.current) setDirty(true); }}
          theme={resolvedTheme === "dark" ? "dark" : "light"}
        />
      </div>
    </div>
  );
}
