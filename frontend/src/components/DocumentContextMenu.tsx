import { useCallback, useState } from "react";
import { t } from "@/i18n";
import {
  Pencil,
  Download,
  FolderInput,
  Shield,
  Tag as TagIcon,
  RefreshCw,
  Search as SearchIcon,
  Bot,
  Trash2,
  Link,
  Star,
  FileText,
  FolderOutput,
  Plus,
  ChevronRight,
  FolderPlus,
  FilePlus,
  Upload,
} from "lucide-react";
import type { DocumentListItem } from "@/lib/api";

export interface ContextMenuState {
  x: number;
  y: number;
  item: DocumentListItem;
}

export interface DocumentContextMenuProps {
  menu: ContextMenuState;
  selectedCount: number;
  shareEnabled?: boolean;
  isFavorited?: boolean;
  onClose: () => void;
  onAction: (action: string) => void;
}

export function DocumentContextMenu({
  menu,
  selectedCount,
  shareEnabled,
  isFavorited,
  onClose,
  onAction,
}: DocumentContextMenuProps) {
  const [pos, setPos] = useState<{ left: number; top: number }>({ left: menu.x, top: menu.y });
  const [showNewSub, setShowNewSub] = useState(false);
  const [newSubPos, setNewSubPos] = useState<"right" | "left">("right");

  const isMulti = selectedCount > 1;
  const count = Math.max(selectedCount, 1);

  const measureRef = useCallback((node: HTMLDivElement | null) => {
    if (!node) return;
    const rect = node.getBoundingClientRect();
    const top = menu.y + rect.height > window.innerHeight
      ? Math.max(4, menu.y - rect.height)
      : menu.y;
    const left = menu.x + rect.width > window.innerWidth
      ? Math.max(4, menu.x - rect.width)
      : menu.x;
    if (left !== pos.left || top !== pos.top) {
      setPos({ left, top });
    }
  }, [menu.x, menu.y]);

  const btn = "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent hover:text-accent-foreground";
  const sep = "-mx-1 my-1 h-px bg-border";

  return (
    <>
      <div className="fixed inset-0 z-50" onClick={onClose} onContextMenu={(e) => { e.preventDefault(); onClose(); }} />
      <div
        ref={measureRef}
        className="fixed z-50 min-w-[180px] rounded-lg bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10 animate-in fade-in-0 zoom-in-95"
        style={{ left: pos.left, top: pos.top }}
      >
        {isMulti && (
          <div className="px-2 py-1 text-xs text-muted-foreground font-medium">{t("fileExplorer:contextMenu.selected", { count })}</div>
        )}
        {!isMulti && (
          <button className={btn} onClick={() => onAction("rename")}>
            <Pencil className="h-4 w-4" />{t("fileExplorer:contextMenu.rename")}
          </button>
        )}
        {!(menu.item.download_prohibited) && (
          <button className={btn} onClick={() => onAction("download")}>
            <Download className="h-4 w-4" />{isMulti ? t("fileExplorer:contextMenu.downloadMulti", { count }) : t("fileExplorer:contextMenu.download")}
          </button>
        )}
        <div className={sep} />
        <div className="relative" onMouseEnter={(e) => {
          setShowNewSub(true);
          const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
          setNewSubPos(rect.right + 170 > window.innerWidth ? "left" : "right");
        }} onMouseLeave={() => setShowNewSub(false)}>
          <button className={`${btn} justify-between`} onClick={() => setShowNewSub((v) => !v)}>
            <span className="flex items-center gap-2"><Plus className="h-4 w-4" />{t("fileExplorer:contextMenu.newCreate")}</span>
            <ChevronRight className="h-3 w-3 text-muted-foreground" />
          </button>
          {showNewSub && (
            <div className={`absolute top-0 ${newSubPos === "right" ? "left-full" : "right-full"} ml-1 min-w-[170px] rounded-lg bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10 z-50`}>
              <button className={btn} onClick={() => onAction("new_folder")}>
                <FolderPlus className="h-4 w-4" />{t("fileExplorer:contextMenu.newFolder")}
              </button>
              <button className={btn} onClick={() => onAction("new_text")}>
                <FilePlus className="h-4 w-4" />{t("fileExplorer:contextMenu.newText")}
              </button>
              <button className={btn} onClick={() => onAction("new_upload")}>
                <Upload className="h-4 w-4" />{t("fileExplorer:contextMenu.newUpload")}
              </button>
            </div>
          )}
        </div>
        {!isMulti && shareEnabled && !menu.item.share_prohibited && (
          <button className={btn} onClick={() => onAction("share")}>
            <Link className="h-4 w-4" />{t("fileExplorer:contextMenu.shareLink")}
          </button>
        )}
        <div className={sep} />
        <button className={btn} onClick={() => onAction("move_folder")}>
          <FolderInput className="h-4 w-4" />{t("fileExplorer:contextMenu.moveFolder")}
        </button>
        <button className={btn} onClick={() => onAction("permissions")}>
          <Shield className="h-4 w-4" />{t("fileExplorer:contextMenu.permissions")}
        </button>
        <button className={btn} onClick={() => onAction("add_tags")}>
          <TagIcon className="h-4 w-4" />{t("fileExplorer:contextMenu.editTags")}
        </button>
        <button className={btn} onClick={() => onAction("reindex")}>
          <RefreshCw className="h-4 w-4" />{t("fileExplorer:contextMenu.reindex")}
        </button>
        <div className={sep} />
        <button className={btn} onClick={() => onAction("toggle_searchable")}>
          <SearchIcon className="h-4 w-4" />{menu.item.searchable ? t("fileExplorer:contextMenu.searchOff") : t("fileExplorer:contextMenu.searchOn")}
        </button>
        <button className={btn} onClick={() => onAction("toggle_ai")}>
          <Bot className="h-4 w-4" />{menu.item.ai_knowledge ? t("fileExplorer:contextMenu.aiOff") : t("fileExplorer:contextMenu.aiOn")}
        </button>
        {!isMulti && (
          <button className={btn} onClick={() => onAction("toggle_favorite")}>
            <Star className={`h-4 w-4 ${isFavorited ? "fill-current" : ""}`} />{isFavorited ? t("fileExplorer:contextMenu.removeFavorite") : t("fileExplorer:contextMenu.addFavorite")}
          </button>
        )}
        {!isMulti && menu.item.is_note && (
          <button className={btn} onClick={() => onAction("remove_note")}>
            <FolderOutput className="h-4 w-4" />{t("fileExplorer:contextMenu.removeNote")}
          </button>
        )}
        {!isMulti && !menu.item.is_note && menu.item.file_type === "md" && (
          <button className={btn} onClick={() => onAction("convert_to_note")}>
            <FileText className="h-4 w-4" />{t("fileExplorer:contextMenu.addNote")}
          </button>
        )}
        <div className={sep} />
        <button className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-destructive hover:bg-destructive/10" onClick={() => onAction("delete")}>
          <Trash2 className="h-4 w-4" />{isMulti ? t("fileExplorer:contextMenu.moveToTrashMulti", { count }) : t("fileExplorer:contextMenu.moveToTrash")}
        </button>
      </div>
    </>
  );
}
