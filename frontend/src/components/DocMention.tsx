/**
 * Custom BlockNote inline content for @-mentioning documents/notes.
 *
 * Uses a fully custom dropdown (not BlockNote's SuggestionMenu) to support
 * Japanese IME composition correctly.
 */
import { useState, useEffect, useCallback, useRef } from "react";
import {
  BlockNoteSchema,
  defaultInlineContentSpecs,
  type InlineContentSchemaFromSpecs,
  type BlockSchemaFromSpecs,
  type StyleSchemaFromSpecs,
  type BlockNoteEditor,
  defaultBlockSpecs,
  defaultStyleSpecs,
} from "@blocknote/core";
import { createReactInlineContentSpec } from "@blocknote/react";
import { FileText, BookOpenText, AlertTriangle } from "lucide-react";
import { getDocuments, resolveTitles } from "@/lib/api";
import type { DocumentListItem } from "@/lib/api/types";
import { t } from "@/i18n";

// ---------------------------------------------------------------------------
// 1. Custom inline content spec: "docMention"
// ---------------------------------------------------------------------------

export const DocMention = createReactInlineContentSpec(
  {
    type: "docMention" as const,
    propSchema: {
      documentId: { default: "" },
      displayText: { default: "" },
    },
    content: "none",
  },
  {
    render: (props) => {
      const { documentId, displayText } = props.inlineContent.props;
      const [resolved, setResolved] = useState<{ title: string; is_note: boolean; deleted: boolean } | null>(null);

      useEffect(() => {
        if (!documentId) return;
        if (displayText) return;
        let cancelled = false;
        resolveTitles([documentId]).then((map) => {
          if (cancelled) return;
          const info = map[documentId];
          if (info) setResolved(info);
          else setResolved({ title: t("editor:unknownDocument"), is_note: false, deleted: true });
        }).catch(() => {});
        return () => { cancelled = true; };
      }, [documentId, displayText]);

      const label = displayText || resolved?.title || documentId.slice(0, 8) + "...";
      const isDeleted = resolved?.deleted ?? false;
      const isNote = resolved?.is_note ?? false;

      const Icon = isDeleted ? AlertTriangle : isNote ? BookOpenText : FileText;

      const handleClick = () => {
        if (isDeleted || !documentId) return;
        window.dispatchEvent(new CustomEvent("doc-mention-click", {
          detail: { documentId, isNote },
        }));
      };

      return (
        <span
          className={`inline-flex items-center gap-0.5 rounded px-1 py-0.5 text-sm font-medium cursor-pointer align-baseline ${
            isDeleted
              ? "bg-muted text-muted-foreground line-through"
              : "bg-primary/10 text-primary hover:bg-primary/20"
          }`}
          contentEditable={false}
          onClick={handleClick}
        >
          <Icon className="h-3 w-3 flex-shrink-0" />
          {label}
        </span>
      );
    },
  },
);

// ---------------------------------------------------------------------------
// 2. Schema with docMention registered
// ---------------------------------------------------------------------------

export const docMentionSchema = BlockNoteSchema.create({
  inlineContentSpecs: {
    ...defaultInlineContentSpecs,
    docMention: DocMention,
  },
});

export type DocMentionSchemaType = typeof docMentionSchema;

type EditorType = BlockNoteEditor<
  BlockSchemaFromSpecs<typeof defaultBlockSpecs>,
  InlineContentSchemaFromSpecs<typeof docMentionSchema.inlineContentSpecs>,
  StyleSchemaFromSpecs<typeof defaultStyleSpecs>
>;

// ---------------------------------------------------------------------------
// 3. Custom @mention dropdown (IME-safe)
//
// Instead of using BlockNote's SuggestionMenu (which breaks with IME),
// we watch the editor text for "@query" pattern and show our own dropdown.
// ---------------------------------------------------------------------------

interface MentionState {
  query: string;
  atPos: number;   // position of @ in the doc
  curPos: number;   // current cursor position
  top: number;
  left: number;
}

export function DocMentionMenu({ editor }: { editor: EditorType }) {
  const [state, setState] = useState<MentionState | null>(null);
  const [items, setItems] = useState<DocumentListItem[]>([]);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [loading, setLoading] = useState(false);
  const fetchIdRef = useRef(0);
  const menuRef = useRef<HTMLDivElement>(null);

  // Check text before cursor for @query pattern
  const checkMention = useCallback(() => {
    const tt = (editor as any)._tiptapEditor;
    if (!tt || !tt.view) return;
    const { from, to } = tt.state.selection;
    // Only when cursor (no range selection)
    if (from !== to) { setState(null); return; }

    const $pos = tt.state.doc.resolve(from);
    const blockStart = $pos.start();
    const textBefore = tt.state.doc.textBetween(blockStart, from);

    // Match @query at end of text (query = non-whitespace, non-@ chars)
    const match = textBefore.match(/@([^\s@]*)$/);
    if (!match) { setState(null); return; }

    const query = match[1];
    const atPos = from - query.length - 1; // position of @

    // Get screen coordinates for positioning
    const coords = tt.view.coordsAtPos(atPos);

    setState({ query, atPos, curPos: from, top: coords.bottom + 4, left: coords.left });
  }, [editor]);

  // Subscribe to editor changes
  useEffect(() => {
    const tt = (editor as any)._tiptapEditor;
    if (!tt) return;
    const onUpdate = () => checkMention();
    const onSelection = () => checkMention();
    tt.on("update", onUpdate);
    tt.on("selectionUpdate", onSelection);
    return () => {
      tt.off("update", onUpdate);
      tt.off("selectionUpdate", onSelection);
    };
  }, [editor, checkMention]);

  // Fetch items when query changes
  useEffect(() => {
    if (!state) { setItems([]); return; }
    const id = ++fetchIdRef.current;
    setLoading(true);
    getDocuments({ q: state.query || undefined, per_page: 8, sort_by: "updated_at" })
      .then((resp) => {
        if (id !== fetchIdRef.current) return;
        setItems(resp.items);
        setSelectedIdx(0);
        setLoading(false);
      })
      .catch(() => {
        if (id !== fetchIdRef.current) return;
        setItems([]);
        setLoading(false);
      });
  }, [state?.query]);

  // Insert selected document as docMention
  const selectItem = useCallback((doc: DocumentListItem) => {
    if (!state) return;
    const tt = (editor as any)._tiptapEditor;
    if (!tt) return;

    // Delete @query text
    tt.chain().focus().deleteRange({ from: state.atPos, to: state.curPos }).run();

    // Insert docMention inline content
    editor.insertInlineContent([
      {
        type: "docMention" as const,
        props: { documentId: doc.id, displayText: doc.title },
      },
      " ",
    ]);

    setState(null);
  }, [editor, state]);

  // Keyboard navigation
  useEffect(() => {
    if (!state || items.length === 0) return;
    const handler = (e: KeyboardEvent) => {
      // Don't intercept during IME composition
      if (e.isComposing || e.keyCode === 229) return;

      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedIdx((i) => (i + 1) % items.length);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedIdx((i) => (i - 1 + items.length) % items.length);
      } else if (e.key === "Enter") {
        e.preventDefault();
        selectItem(items[selectedIdx]);
      } else if (e.key === "Escape") {
        e.preventDefault();
        setState(null);
      }
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [state, items, selectedIdx, selectItem]);

  // Close on click outside
  useEffect(() => {
    if (!state) return;
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setState(null);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [state]);

  if (!state || (items.length === 0 && !loading)) return null;

  return (
    <div
      ref={menuRef}
      className="fixed z-50 w-72 rounded-md border bg-popover shadow-md overflow-hidden"
      style={{ top: state.top, left: state.left }}
    >
      {loading && items.length === 0 && (
        <div className="px-3 py-2 text-sm text-muted-foreground">{t("editor:searching")}</div>
      )}
      {items.map((doc, idx) => (
        <div
          key={doc.id}
          className={`flex items-center gap-2 px-3 py-1.5 text-sm cursor-pointer ${
            idx === selectedIdx ? "bg-accent text-accent-foreground" : "hover:bg-muted"
          }`}
          onMouseEnter={() => setSelectedIdx(idx)}
          onMouseDown={(e) => { e.preventDefault(); selectItem(doc); }}
        >
          {doc.is_note
            ? <BookOpenText className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
            : <FileText className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
          }
          <span className="truncate">{doc.title}</span>
          <span className="ml-auto text-xs text-muted-foreground flex-shrink-0">{doc.file_type}</span>
        </div>
      ))}
      {items.length === 0 && !loading && (
        <div className="px-3 py-2 text-sm text-muted-foreground">{t("editor:notFound")}</div>
      )}
    </div>
  );
}
