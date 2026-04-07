import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { ZoomIn, ZoomOut } from "lucide-react";

interface AvatarCropperProps {
  file: File;
  onCropped: (blob: Blob) => void;
  onCancel: () => void;
  /** Output size in pixels (square). Default 256. */
  size?: number;
}

export function AvatarCropper({ file, onCropped, onCancel, size = 256 }: AvatarCropperProps) {
  const VIEWPORT = 220; // visible circle diameter
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);

  const [imgSrc, setImgSrc] = useState<string | null>(null);
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const dragStart = useRef({ x: 0, y: 0, ox: 0, oy: 0 });

  // Load image
  useEffect(() => {
    const url = URL.createObjectURL(file);
    setImgSrc(url);
    const img = new Image();
    img.onload = () => {
      imgRef.current = img;
      // Fit image so shortest side fills viewport
      const minDim = Math.min(img.width, img.height);
      const initialScale = VIEWPORT / minDim;
      setScale(initialScale);
      setOffset({
        x: (VIEWPORT - img.width * initialScale) / 2,
        y: (VIEWPORT - img.height * initialScale) / 2,
      });
    };
    img.src = url;
    return () => URL.revokeObjectURL(url);
  }, [file]);

  // Draw preview
  useEffect(() => {
    const canvas = canvasRef.current;
    const img = imgRef.current;
    if (!canvas || !img) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    canvas.width = VIEWPORT;
    canvas.height = VIEWPORT;

    ctx.clearRect(0, 0, VIEWPORT, VIEWPORT);

    // Clip to circle
    ctx.save();
    ctx.beginPath();
    ctx.arc(VIEWPORT / 2, VIEWPORT / 2, VIEWPORT / 2, 0, Math.PI * 2);
    ctx.clip();

    ctx.drawImage(img, offset.x, offset.y, img.width * scale, img.height * scale);
    ctx.restore();

    // Draw circle border
    ctx.beginPath();
    ctx.arc(VIEWPORT / 2, VIEWPORT / 2, VIEWPORT / 2 - 1, 0, Math.PI * 2);
    ctx.strokeStyle = "rgba(255,255,255,0.5)";
    ctx.lineWidth = 2;
    ctx.stroke();
  }, [scale, offset]);

  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    setDragging(true);
    dragStart.current = { x: e.clientX, y: e.clientY, ox: offset.x, oy: offset.y };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }, [offset]);

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    if (!dragging) return;
    setOffset({
      x: dragStart.current.ox + (e.clientX - dragStart.current.x),
      y: dragStart.current.oy + (e.clientY - dragStart.current.y),
    });
  }, [dragging]);

  const handlePointerUp = useCallback(() => {
    setDragging(false);
  }, []);

  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    const img = imgRef.current;
    if (!img) return;

    const minDim = Math.min(img.width, img.height);
    const minScale = VIEWPORT / Math.max(img.width, img.height);
    const maxScale = (VIEWPORT / minDim) * 4;

    const delta = e.deltaY > 0 ? -0.02 : 0.02;
    setScale((prev) => {
      const next = Math.max(minScale, Math.min(maxScale, prev + delta));
      // Zoom towards center
      const cx = VIEWPORT / 2;
      const cy = VIEWPORT / 2;
      setOffset((o) => ({
        x: cx - ((cx - o.x) / prev) * next,
        y: cy - ((cy - o.y) / prev) * next,
      }));
      return next;
    });
  }, []);

  function adjustScale(delta: number) {
    const img = imgRef.current;
    if (!img) return;
    const minDim = Math.min(img.width, img.height);
    const minScale = VIEWPORT / Math.max(img.width, img.height);
    const maxScale = (VIEWPORT / minDim) * 4;

    setScale((prev) => {
      const next = Math.max(minScale, Math.min(maxScale, prev + delta));
      const cx = VIEWPORT / 2;
      const cy = VIEWPORT / 2;
      setOffset((o) => ({
        x: cx - ((cx - o.x) / prev) * next,
        y: cy - ((cy - o.y) / prev) * next,
      }));
      return next;
    });
  }

  function handleCrop() {
    const img = imgRef.current;
    if (!img) return;

    const out = document.createElement("canvas");
    out.width = size;
    out.height = size;
    const ctx = out.getContext("2d");
    if (!ctx) return;

    // Map viewport coords to output size
    const ratio = size / VIEWPORT;
    ctx.drawImage(
      img,
      offset.x * ratio,
      offset.y * ratio,
      img.width * scale * ratio,
      img.height * scale * ratio,
    );

    out.toBlob(
      (blob) => {
        if (blob) onCropped(blob);
      },
      "image/png",
      0.95,
    );
  }

  if (!imgSrc) return null;

  return (
    <div className="flex flex-col items-center gap-4">
      <p className="text-sm text-muted-foreground">ドラッグで位置調整、スクロールでズーム</p>
      <div
        className="relative rounded-full overflow-hidden bg-muted"
        style={{ width: VIEWPORT, height: VIEWPORT, cursor: dragging ? "grabbing" : "grab", touchAction: "none" }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onWheel={handleWheel}
      >
        <canvas ref={canvasRef} width={VIEWPORT} height={VIEWPORT} className="block" />
      </div>
      <div className="flex items-center gap-2">
        <Button type="button" variant="ghost" size="icon" onClick={() => adjustScale(-0.05)}>
          <ZoomOut className="h-4 w-4" />
        </Button>
        <input
          type="range"
          min={0}
          max={100}
          value={(() => {
            const img = imgRef.current;
            if (!img) return 50;
            const minDim = Math.min(img.width, img.height);
            const minScale = VIEWPORT / Math.max(img.width, img.height);
            const maxScale = (VIEWPORT / minDim) * 4;
            return ((scale - minScale) / (maxScale - minScale)) * 100;
          })()}
          onChange={(e) => {
            const img = imgRef.current;
            if (!img) return;
            const minDim = Math.min(img.width, img.height);
            const minScale = VIEWPORT / Math.max(img.width, img.height);
            const maxScale = (VIEWPORT / minDim) * 4;
            const next = minScale + (Number(e.target.value) / 100) * (maxScale - minScale);
            const cx = VIEWPORT / 2;
            const cy = VIEWPORT / 2;
            setOffset((o) => ({
              x: cx - ((cx - o.x) / scale) * next,
              y: cy - ((cy - o.y) / scale) * next,
            }));
            setScale(next);
          }}
          className="w-32"
        />
        <Button type="button" variant="ghost" size="icon" onClick={() => adjustScale(0.05)}>
          <ZoomIn className="h-4 w-4" />
        </Button>
      </div>
      <div className="flex gap-2">
        <Button type="button" variant="outline" onClick={onCancel}>
          キャンセル
        </Button>
        <Button type="button" onClick={handleCrop}>
          決定
        </Button>
      </div>
    </div>
  );
}
