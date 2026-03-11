"""Lightweight OCR server powered by Surya.

Accepts image or PDF files and returns extracted text.
Runs on the host with GPU (ROCm/CUDA) for fast inference.
"""

import io
import logging
import time
from contextlib import asynccontextmanager

import pypdfium2 as pdfium
from fastapi import FastAPI, File, UploadFile
from PIL import Image
from pydantic import BaseModel
from surya.detection import DetectionPredictor
from surya.foundation import FoundationPredictor
from surya.recognition import RecognitionPredictor

logger = logging.getLogger("ocr-server")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

# Global predictors (loaded once at startup)
det_predictor: DetectionPredictor | None = None
rec_predictor: RecognitionPredictor | None = None

# Warmup image: one large image is enough when RECOGNITION_BATCH_SIZE is fixed,
# since all batches will have the same tensor shape.
_WARMUP_SIZES = [
    (3000, 4000),   # typical phone photo / large document
]


def _make_text_image(w: int, h: int) -> Image.Image:
    """Create a dummy image with text lines to trigger recognition kernels."""
    from PIL import ImageDraw

    img = Image.new("RGB", (w, h), "white")
    draw = ImageDraw.Draw(img)
    y = 20
    line_height = 30
    while y + line_height < h:
        draw.text((20, y), f"Warmup line at y={y} ABCDEFG 0123456789", fill="black")
        y += line_height
    return img


def _warmup(det: DetectionPredictor, rec: RecognitionPredictor):
    """Run dummy OCR at various resolutions to pre-compile ROCm kernels.

    Uses text-filled images so both detection AND recognition kernels
    are compiled during startup.
    """
    logger.info("Warming up with %d image sizes (ROCm kernel compilation)...", len(_WARMUP_SIZES))
    for i, (w, h) in enumerate(_WARMUP_SIZES):
        t0 = time.time()
        dummy = _make_text_image(w, h)
        rec([dummy], det_predictor=det)
        elapsed = time.time() - t0
        logger.info("  Warmup %d/%d (%dx%d): %.1fs", i + 1, len(_WARMUP_SIZES), w, h, elapsed)
    logger.info("Warmup complete.")


@asynccontextmanager
async def lifespan(app: FastAPI):
    global det_predictor, rec_predictor
    logger.info("Loading Surya OCR models...")
    foundation = FoundationPredictor()
    det_predictor = DetectionPredictor()
    rec_predictor = RecognitionPredictor(foundation)
    logger.info("Surya OCR models loaded.")
    _warmup(det_predictor, rec_predictor)
    yield
    logger.info("Shutting down OCR server.")


app = FastAPI(title="OCR Server", lifespan=lifespan)


class OCRResult(BaseModel):
    text: str
    pages: int


def _images_from_pdf(data: bytes, dpi: int = 300) -> list[Image.Image]:
    """Render PDF pages to PIL images."""
    pdf = pdfium.PdfDocument(data)
    images = []
    scale = dpi / 72
    for page in pdf:
        bitmap = page.render(scale=scale)
        images.append(bitmap.to_pil())
    pdf.close()
    return images


def _ocr_images(images: list[Image.Image]) -> str:
    """Run Surya OCR on a list of images and return combined text."""
    predictions = rec_predictor(images, det_predictor=det_predictor)
    parts: list[str] = []
    for page in predictions:
        lines = [line.text for line in page.text_lines if line.text.strip()]
        parts.append("\n".join(lines))
    return "\n\n".join(parts)


@app.post("/ocr", response_model=OCRResult)
async def ocr(file: UploadFile = File(...)):
    """Accept an image or PDF and return OCR text."""
    data = await file.read()
    content_type = file.content_type or ""
    filename = (file.filename or "").lower()

    if content_type == "application/pdf" or filename.endswith(".pdf"):
        images = _images_from_pdf(data)
    else:
        images = [Image.open(io.BytesIO(data)).convert("RGB")]

    logger.info("OCR: processing %d page(s) from %s", len(images), file.filename)
    t0 = time.time()
    text = _ocr_images(images)
    elapsed = time.time() - t0
    logger.info("OCR: extracted %d chars in %.1fs", len(text), elapsed)

    return OCRResult(text=text, pages=len(images))


@app.get("/health")
async def health():
    return {"status": "ok", "model_loaded": rec_predictor is not None}
