import { useCreateBlockNote } from "@blocknote/react";
import { BlockNoteView } from "@blocknote/shadcn";
import { useTheme } from "next-themes";
import { docMentionSchema } from "@/components/DocMention";
import "@blocknote/shadcn/style.css";

interface NoteReadonlyViewProps {
  initialContent: unknown;
}

export default function NoteReadonlyView({ initialContent }: NoteReadonlyViewProps) {
  const { resolvedTheme } = useTheme();

  const parsedInitial =
    initialContent && Array.isArray(initialContent) && initialContent.length > 0
      ? (initialContent as never)
      : undefined;

  const editor = useCreateBlockNote({
    schema: docMentionSchema,
    initialContent: parsedInitial,
  });

  return (
    <BlockNoteView
      editor={editor}
      editable={false}
      theme={resolvedTheme === "dark" ? "dark" : "light"}
    />
  );
}
