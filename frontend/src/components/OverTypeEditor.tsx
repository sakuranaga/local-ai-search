import { useEffect, useRef } from "react";
import OverType from "overtype";

export function OverTypeEditor({
  value,
  onChange,
  readOnly = false,
}: {
  value: string;
  onChange?: (value: string) => void;
  readOnly?: boolean;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<InstanceType<typeof OverType> | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    // Use 16px on mobile to prevent iOS Safari auto-zoom on focus
    const isMobile = window.matchMedia("(max-width: 767px)").matches;

    const instances = new OverType(el, {
      value,
      toolbar: !readOnly,
      statsBar: false,
      placeholder: readOnly ? "" : "テキストを編集...",
      fontSize: isMobile ? "16px" : "14px",
    } as any);

    // OverType constructor may return a single instance or array
    const editor = Array.isArray(instances) ? instances[0] : instances;
    if (!editor) return;

    editorRef.current = editor as any;

    if (!readOnly && onChange) {
      const textarea = editor.textarea;
      if (textarea) {
        const handler = () => {
          onChangeRef.current?.(editor.getValue());
        };
        textarea.addEventListener("input", handler);
        return () => {
          textarea.removeEventListener("input", handler);
          editor.destroy();
          editorRef.current = null;
        };
      }
    }

    return () => {
      editor.destroy();
      editorRef.current = null;
    };
  }, []);

  // Sync external value changes (e.g. version restore) into the editor
  useEffect(() => {
    const editor = editorRef.current as any;
    if (!editor) return;
    if (editor.getValue() !== value) {
      editor.setValue(value);
    }
  }, [value]);

  return (
    <div
      ref={containerRef}
      className="h-full w-full [&_.ot-container]:!h-full [&_.ot-container]:!max-h-none [&_.ot-container]:!border-0 [&_.ot-container]:!rounded-none"
    />
  );
}
