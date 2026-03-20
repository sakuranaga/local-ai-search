import { useCallback, useState } from "react";
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
          <div className="px-2 py-1 text-xs text-muted-foreground font-medium">{count}件選択中</div>
        )}
        {!isMulti && (
          <button className={btn} onClick={() => onAction("rename")}>
            <Pencil className="h-4 w-4" />名前変更
          </button>
        )}
        {!(menu.item.download_prohibited) && (
          <button className={btn} onClick={() => onAction("download")}>
            <Download className="h-4 w-4" />ダウンロード{isMulti ? ` (${count}件)` : ""}
          </button>
        )}
        {!isMulti && shareEnabled && !menu.item.share_prohibited && (
          <>
            <div className={sep} />
            <button className={btn} onClick={() => onAction("share")}>
              <Link className="h-4 w-4" />共有リンク作成
            </button>
          </>
        )}
        <div className={sep} />
        <button className={btn} onClick={() => onAction("move_folder")}>
          <FolderInput className="h-4 w-4" />フォルダ移動
        </button>
        <button className={btn} onClick={() => onAction("permissions")}>
          <Shield className="h-4 w-4" />権限設定
        </button>
        <button className={btn} onClick={() => onAction("add_tags")}>
          <TagIcon className="h-4 w-4" />タグ編集
        </button>
        <button className={btn} onClick={() => onAction("reindex")}>
          <RefreshCw className="h-4 w-4" />ベクトル再構築
        </button>
        <div className={sep} />
        <button className={btn} onClick={() => onAction("toggle_searchable")}>
          <SearchIcon className="h-4 w-4" />検索 {menu.item.searchable ? "OFF" : "ON"}
        </button>
        <button className={btn} onClick={() => onAction("toggle_ai")}>
          <Bot className="h-4 w-4" />AI {menu.item.ai_knowledge ? "OFF" : "ON"}
        </button>
        {!isMulti && (
          <button className={btn} onClick={() => onAction("toggle_favorite")}>
            <Star className={`h-4 w-4 ${isFavorited ? "fill-current" : ""}`} />{isFavorited ? "お気に入り解除" : "お気に入り追加"}
          </button>
        )}
        <div className={sep} />
        <button className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-destructive hover:bg-destructive/10" onClick={() => onAction("delete")}>
          <Trash2 className="h-4 w-4" />ゴミ箱に移動{isMulti ? ` (${count}件)` : ""}
        </button>
      </div>
    </>
  );
}
