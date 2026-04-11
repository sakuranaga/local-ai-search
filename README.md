# LAS — Local AI Search

**Self-hosted file search server powered by full-text search, vector search, and AI agents. Your data never leaves your network.**

[日本語版 README](README_ja.md)

As files pile up, finding the right document becomes impossible. Filename matching has its limits, and vague queries like "that report from last week" return nothing.

LAS combines full-text search with vector search (semantic search) so you can find documents even when your keywords don't exactly match. PDFs and images are automatically OCR'd and made searchable. All data stays on your local network — zero cloud dependency.

## Security

LAS is designed with security as a top priority.

### Data stays local

LAS runs entirely within your **LAN** and is never exposed to the internet. Files, search indices, and all AI processing run locally. Zero data is sent to cloud services. LLM, Embedding, and OCR all run on local GPUs.

### Defense in depth

| Layer | Protection |
|-------|-----------|
| **Antivirus** | ClamAV (3.6M+ signatures) auto-scans uploads. Infected files are immediately deleted |
| **Unix permissions** | Per-document and per-folder owner / group / others read / write control |
| **Authentication** | JWT access + refresh tokens. API keys are folder-scoped with permission restrictions |
| **Resumable uploads** | tus protocol for safe large file transfers with resume-on-failure |

### Secure external sharing

Share files with external users without exposing LAS itself.

```
LAN (private)                    Internet (public)
┌──────────┐   file transfer    ┌──────────────┐
│   LAS    │ ────────────────→  │ Share Server │ ← external users access here
│          │   (one-way only)   │ (standalone)  │
└──────────┘                    └──────────────┘
```

- **One-way transfer**: LAS → Share Server only. No reverse access path exists
- **If Share Server is compromised, LAS data remains unreachable**
- **Mandatory expiration (max 30 days)**: expired files are auto-deleted
- **Password protection**: optional password on share links
- **Independent deployment**: separate server/network from LAS. Go binary + SQLite, minimal footprint

## Features

### Search & AI

- **Hybrid search** — pg_bigm full-text + pgvector vector search in parallel, merged via RRF (Reciprocal Rank Fusion)
- **Japanese morphological analysis** — Janome for automatic query tokenization
- **AI search agent** — ReAct-style autonomous agent using search / grep / read_document tools
- **SSE streaming** — Real-time AI responses and tool execution status
- **Filters** — By file type, date range, uploader

### File management

- **File explorer** — Folder hierarchy, tags, drag & drop organization
- **Resumable uploads** — tus protocol, resume on interruption, real-time progress
- **Folder upload** — Drag & drop folders to auto-create hierarchy. Hidden directories (.git, etc.) auto-excluded
- **Upload queue** — Up to 1000 files with 3 concurrent uploads. Batch progress panel, bulk cancel, error skip
- **ClamAV antivirus** — Auto-scan on upload, infected files immediately deleted
- **All file types** — Text extraction (MD/PDF/DOCX/XLSX/CSV/HTML/PPTX/RTF/image OCR), video/audio browser preview, metadata search for everything else
- **Document preview** — LibreOffice headless converts PPTX/DOCX/DOC/RTF → PDF → page images. Excel/CSV rendered as HTML tables
- **Video player** — video.js v10 for mp4/mov/mkv/avi (seek, playback speed, PiP, fullscreen)
- **Audio player** — mp3/wav/ogg/m4a/flac/aac in-browser playback
- **Text editing** — OverType WYSIWYG editor for correcting OCR errors (auto re-chunk & re-vectorize)
- **AI summaries** — LLM auto-generates document summaries on upload
- **External sharing** — Share files via independent Share Server. Password protection, expiration (max 30 days), auto-cleanup
- **Bulk operations** — Multi-select for tag editing, folder move, permission changes, delete, zip download
- **Trash** — Soft delete + restore + permanent delete
- **Favorites** — Star documents for quick access from sidebar
- **Version control** — Auto-creates v1 on upload. Auto-versions on text edit / file overwrite. Restore to any version
- **Notes (Wiki)** — BlockNote WYSIWYG editor, tree structure, drag & drop reorder, Yjs real-time collaboration

### Security & permissions

- **Unix-style permissions** — Per-document/folder owner / group / others read / write
- **Admin / regular users** — Admin-only management (users, roles, settings, API keys, groups)
- **Group management** — Assign users to groups for group-based access control
- **JWT authentication** — Access + refresh tokens
- **API keys** — For external integrations, folder-scoped with permission restrictions

### Administration

- **Admin panel** — User, role, group, API key, system settings, email notifications, audit log management
- **Email notifications** — Login, upload, update, delete notifications via SMTP / SendGrid / Resend / AWS SES. Per-recipient event selection. Bulk operations auto-aggregated into single email
- **Audit log** — Records all operations. Filter by user, action type, date. CSV export
- **System settings** — Configure LLM/Embedding endpoints, search parameters from the UI

## Architecture

```
 LAN (private)
┌──────────────┐     ┌─────────┐     ┌──────────────────────┐
│   Browser    │────▶│  Nginx  │────▶│  FastAPI Backend      │
│  (React SPA) │◀────│  :3002  │◀────│  (Gunicorn + Uvicorn) │
└──────────────┘     └────┬────┘     └──────────┬───────────┘
                          │                      │
                     ┌────▼────┐    ┌────────────┼────────────────────┐
                     │  tusd   │    │            │                    │
                     │  (tus)  │    ▼            ▼                   ▼
                     └─────────┘  ┌──────────┐ ┌───────┐ ┌──────────────────┐
                                  │PostgreSQL│ │Valkey │ │   llama.cpp      │
                     ┌─────────┐  │ pgvector │ │       │ │ LLM + Embedding  │
                     │ ClamAV  │  │ pg_bigm  │ │       │ │                  │
                     └─────────┘  └──────────┘ └───────┘ └──────────────────┘

                     ┌──────────────────┐
                     │  Surya OCR       │  ← GPU (ROCm/CUDA) recommended
                     │  :8090           │
                     └──────────────────┘

                                        │ file transfer (sharing only)
                                        ▼
 Internet (public)      ┌──────────────────┐
                        │  Share Server     │  ← deployed separately
                        │  Go + SQLite      │
                        └──────────┬───────┘
                                   ↑
                             external users
```

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | React 19 + TypeScript, Vite 7, shadcn/ui, Tailwind CSS 4 |
| Backend | Python 3.12, FastAPI, Gunicorn + Uvicorn (4 workers) |
| Database | PostgreSQL 18 + pgvector (vector search) + pg_bigm (fast Japanese full-text search) |
| Cache | Valkey 8 (Redis-compatible, BSD-3-Clause) |
| Upload | tusd (tus protocol — resumable uploads) |
| Antivirus | ClamAV (3.6M+ signatures, auto-updating definitions) |
| Share Server | Go + SQLite (WAL) — external sharing, independent deployment |
| Document Preview | LibreOffice headless + PyMuPDF — PPTX/DOCX/DOC/RTF → PDF → PNG |
| OCR | Surya OCR — GPU-accelerated (ROCm/CUDA), image & scanned PDF text extraction |
| Text Editor | OverType (91KB, zero-dependency WYSIWYG markdown editor) |
| Note Editor | BlockNote (ProseMirror-based WYSIWYG block editor) |
| Collaboration | Yjs + y-websocket (CRDT real-time co-editing, LevelDB persistence) |
| Video Player | video.js v10 (@videojs/react) |
| LLM | llama.cpp (OpenAI-compatible API) |
| Embedding | llama.cpp (OpenAI-compatible API) |
| Proxy | Nginx (SPA + API + tus reverse proxy) |
| Container | Docker Compose |

## Setup

### Prerequisites

- Docker + Docker Compose
- 2x llama.cpp servers (LLM + Embedding)
- Node.js 20+ (for frontend build)
- OCR server (optional, required for image/scanned PDF support)

### Starting llama.cpp servers

**LLM server (port 8081)**

```bash
llama-server \
  -m <model.gguf> \
  --host 0.0.0.0 --port 8081 \
  -ngl 99 -c 32768 --parallel 4 --reasoning-budget 0
```

**Embedding server (port 8082)**

```bash
llama-server \
  -m <embedding-model.gguf> \
  --host 0.0.0.0 --port 8082 \
  --embedding -ngl 99 -c 32768 --parallel 4
```

### OCR server (optional)

Surya OCR server for image and scanned PDF text extraction. GPU (ROCm/CUDA) recommended.

```bash
cd ocr-server

# Create venv and install dependencies
python -m venv venv
source venv/bin/activate
pip install -r requirements.txt

# Start (default: port 8090, GPU)
./start.sh

# CPU mode
TORCH_DEVICE=cpu ./start.sh
```

If the OCR server is not running, image text extraction and scanned PDF OCR are skipped (text-embedded PDFs work without OCR).

#### systemd service (recommended)

Enable auto-restart on crash:

```bash
mkdir -p ~/.config/systemd/user
ln -sf "$(pwd)/ocr-server/ocr-server.service" ~/.config/systemd/user/ocr-server.service
systemctl --user daemon-reload
systemctl --user enable --now ocr-server
```

Management commands:

```bash
systemctl --user status ocr-server      # status
systemctl --user restart ocr-server     # restart
journalctl --user -u ocr-server -f      # logs
```

See [ocr-server/README.md](ocr-server/README.md) for details.

### Quick start

```bash
git clone <repository-url>
cd local-ai-search

# Configure environment
cp .env.example .env
# Edit .env: change POSTGRES_PASSWORD, JWT_SECRET

# Build frontend
cd frontend && npm install && npm run build && cd ..

# Start
docker compose up -d
```

### Services

| Service | Description | Port |
|---------|-------------|------|
| db | PostgreSQL 18 (pgvector + pg_bigm) | internal |
| redis | Valkey 8 (Redis-compatible) | internal |
| backend | FastAPI application | internal 8000 |
| queue-worker | Background job processing | internal |
| tusd | tus upload server | internal 8080 |
| clamav | ClamAV antivirus scanner | internal 3310 |
| y-websocket | Yjs WebSocket server (collaboration) | internal 1234 |
| nginx | Reverse proxy + SPA serving | **3002** |
| ocr-server | Surya OCR (host, systemd recommended) | 8090 |

### First login

Access `http://localhost:3002`.

- Username: `admin`
- Password: `admin`

**Change the password immediately after first login.**

### LLM / Embedding configuration

Configure in Admin > Settings:

| Key | Default | Description |
|-----|---------|-------------|
| `llm_url` | `http://host.docker.internal:8081/v1` | LLM server URL |
| `llm_model` | `qwen3.5-35b-a3b` | LLM model name |
| `embed_url` | `http://host.docker.internal:8082/v1` | Embedding server URL |
| `embed_model` | `bge-m3` | Embedding model name |

## How search works

### Hybrid search (RRF)

1. **Full-text search** (pg_bigm) — Janome morphological analysis, noun extraction, GIN index for fast LIKE
2. **Vector search** (pgvector) — Query embedded as vector, cosine similarity search
3. **RRF merge** — `score = 1/(k+rank)` merges both results, per-document deduplication

### AI agent (ReAct)

The LLM autonomously uses tools to gather information and generate answers:

| Tool | Description |
|------|-------------|
| `search` | Keyword + semantic search (RRF) |
| `grep` | Text pattern partial matching |
| `search_by_title` | Title / filename search |
| `read_document` | Retrieve full document by ID |
| `count_results` | Check search hit count |

## Upload pipeline

[tus protocol](https://tus.io/) resumable uploads:

1. File split into 5MB chunks and uploaded
2. Resume from interruption (even after browser restart)
3. Upload complete → ClamAV virus scan
4. Clean → text extraction (Tier 1) → chunking → vectorization → summary generation
5. Video/audio (Tier 2/3) skip processing, complete immediately (searchable by metadata)
6. Infection detected → file deleted immediately, error logged

API keys also support tus uploads (curl, Python, etc.).

## Operations

```bash
# Rebuild backend
docker compose up -d --build backend

# Rebuild frontend
cd frontend && npm run build

# View logs
docker compose logs backend --tail 50
docker compose logs -f backend  # real-time

# ClamAV definition update status
docker compose logs clamav | grep "database"

# Run tests
docker compose exec backend python -m pytest tests/ -v
```

### Backup

`scripts/backup-s3.sh` backs up PostgreSQL dump + uploaded files to S3-compatible storage:

```bash
# Manual run
./scripts/backup-s3.sh

# Cron example (daily at 3:00 AM)
0 3 * * * /home/user/local-ai-search/scripts/backup-s3.sh
```

Backup contents:
- **DB dump** — `pg_dump` of all tables, gzipped and uploaded to S3
- **Uploaded files** — `data/uploads/` synced to S3 (`aws s3 sync`)

Configure `ENDPOINT`, `BUCKET`, `PROFILE` variables in the script. Requires pre-configured AWS CLI profile.

### Integrations

| Integration | Directory | Description |
|-------------|-----------|-------------|
| Notion | `integration/notion/` | Sync documents from Notion workspace |
| Discord | `discord-las-bot/` | Search and register documents from Discord bot |

Both use the `POST /api/ingest/content` API as optional integrations.

## API

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/auth/login` | Login |
| GET | `/api/auth/me` | Current user info |
| GET | `/api/search?q=...` | Hybrid search |
| GET | `/api/search/documents?q=...` | Search results as document list |
| POST | `/api/chat/stream` | AI chat (SSE) |
| GET | `/api/documents` | Document list (with filters) |
| GET | `/api/documents/{id}` | Document details |
| PATCH | `/api/documents/{id}` | Update document (including text edit) |
| GET | `/api/documents/{id}/versions` | Version list |
| POST | `/api/documents/{id}/versions/{n}/restore` | Restore version |
| DELETE | `/api/documents/{id}` | Delete document (soft delete) |
| POST | `/api/documents/bulk-action` | Bulk operations |
| POST | `/api/documents/download-zip` | Multi-file zip download |
| GET | `/api/documents/filter-options` | Filter options (types, uploaders) |
| GET | `/api/favorites` | Favorites list |
| POST | `/api/favorites/{id}` | Add favorite |
| DELETE | `/api/favorites/{id}` | Remove favorite |
| GET | `/api/folders` | Folder list |
| POST | `/api/folders/bulk` | Bulk create folder hierarchy |
| GET | `/api/tags` | Tag list |
| POST | `/api/ingest/tus-hook` | tus upload completion hook |
| GET | `/api/users` | User list (admin) |
| GET | `/api/settings` | System settings (admin) |
| GET | `/api/api-keys` | API key list (admin) |
| GET | `/api/groups` | Group list |
| GET | `/api/admin/mail/recipients` | Email recipients (admin) |
| POST | `/api/admin/mail/recipients` | Add email recipient (admin) |
| PATCH | `/api/admin/mail/recipients/{id}` | Update email recipient (admin) |
| DELETE | `/api/admin/mail/recipients/{id}` | Delete email recipient (admin) |
| POST | `/api/admin/mail/test` | Send test email (admin) |
| GET | `/api/admin/audit-logs` | Audit log list (admin) |
| GET | `/api/admin/audit-logs/export` | Export audit logs as CSV (admin) |
| GET | `/api/notes` | Note tree |
| POST | `/api/notes` | Create note |
| GET | `/api/notes/{id}` | Note details |
| PATCH | `/api/notes/{id}` | Update note (title, content) |
| PATCH | `/api/notes/{id}/move` | Move / reorder note |
| POST | `/api/notes/from-document/{id}` | Convert .md file to note |
| POST | `/api/notes/{id}/remove` | Remove note (file remains) |
| POST | `/api/notes/{id}/delete-with-file` | Delete note and file |

### API key integration

```bash
# tus resumable upload
# Step 1: Create upload
curl -X POST https://your-server/tusd/ \
  -H "Tus-Resumable: 1.0.0" \
  -H "Upload-Length: $(wc -c < file.pdf)" \
  -H "Upload-Metadata: filename $(echo -n 'file.pdf' | base64),api_key $(echo -n 'las_xxx' | base64)"

# Step 2: Send data (to the URL from Location header)
curl -X PATCH https://your-server/tusd/<upload-id> \
  -H "Tus-Resumable: 1.0.0" \
  -H "Upload-Offset: 0" \
  -H "Content-Type: application/offset+octet-stream" \
  --data-binary @file.pdf
```

#### File upload

```bash
curl -X POST https://your-server/api/ingest/upload \
  -H "X-API-Key: las_xxx" \
  -F "file=@document.pdf" \
  -F "folder_id=FOLDER_UUID"  # optional
```

#### Content ingestion (for n8n / Zapier integration)

```bash
curl -X POST https://your-server/api/ingest/content \
  -H "X-API-Key: las_xxx" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Title",
    "content": "Body text (Markdown supported)",
    "source": "notion",
    "external_id": "page-id-123",
    "external_url": "https://notion.so/...",
    "folder": "Notion/ProjectA",
    "tags": ["notion", "sync"],
    "memo": "Memo",
    "mode": "append",
    "version": true
  }'
```

Upserts when `source` + `external_id` match an existing document.

| Parameter | Required | Description |
|-----------|----------|-------------|
| `title` | Yes | Document title (`.md` auto-appended) |
| `content` | Yes | Body text (Markdown format) |
| `source` | Yes | Source identifier (e.g., `discord`, `jira`, `notion`) |
| `external_id` | | External service unique ID (upsert key) |
| `external_url` | | External service URL |
| `folder` | | Folder name (auto-created). Use `/` for subfolders (e.g., `Parent/Child`) |
| `tags` | | Array of tag names (auto-created) |
| `memo` | | Memo |
| `mode` | | `"append"`: append to existing document. Default: full replace |
| `version` | | `true`: save version on update. Default `false` |

#### Other endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/ingest/status/{id}` | Check processing status |
| DELETE | `/api/ingest/{id}` | Delete document (`delete` permission required) |
| GET | `/api/ingest/list` | Document list |

## Design docs

- [Share links](docs/share-links.md) — Share Server architecture, API spec
- [Universal file upload](docs/universal-file-upload.md) — tus, ClamAV, all file types
- [Future features](docs/future-features.md) — Version control, AI auto-organize, storage quotas, S3
- [File and content design](docs/file-content-design.md) — Immutable source file principle, .md special handling
- [Notes design](docs/design-notes.md) — Notes feature, Yjs collaboration
- [Refactoring](REFACTOR.md) — Permission model review, remaining tasks

## Share Server

Independent server for sharing LAN files with external users. Built with Go + SQLite, deployed separately from LAS.

### Setup

```bash
cd share-server

# Configure environment
cp .env.example .env
# Edit .env: set SHARE_BASE_URL, SHARE_JWT_SECRET

# Start
docker compose up -d
```

### Create API key

Create an API key for communication with LAS:

```bash
docker compose exec share share-server key create --name "Office LAS"
# => Key: sk_xxxxx (set this in LAS Admin > Settings > share_server_api_key)
```

### CLI commands

```bash
# API key management
docker compose exec share share-server key create --name "name"
docker compose exec share share-server key list
docker compose exec share share-server key revoke <id>

# Share link management
docker compose exec share share-server links
docker compose exec share share-server links delete <token>

# Status
docker compose exec share share-server status

# Manual cleanup of expired files
docker compose exec share share-server cleanup
```

### Connecting to LAS

1. Create an API key on Share Server
2. In LAS Admin > Settings, configure:
   - `share_server_url`: Share Server URL (e.g., `https://share.example.com`)
   - `share_server_api_key`: the API key created above
3. Click "Test Connection" → sharing features auto-enabled on success

### Sharing flow

1. Right-click a document in LAS → "Create share link"
2. Set expiration (1 hour – 30 days) and optional password
3. LAS transfers the file to Share Server, gets a share URL
4. Send the URL to external users
5. External users access the URL → download
6. Expired files are auto-deleted by Share Server

## License

**AGPL-3.0** — [LICENSE](LICENSE)

This software is provided under the GNU Affero General Public License v3.0. Source code disclosure is required even when providing the software as a network service.

For commercial licensing (support, SLA, customization), please contact us separately.

### Dependency licenses

All dependencies are compatible with AGPL-3.0:

| Category | Library | License | Notes |
|----------|---------|---------|-------|
| Web framework | FastAPI, Uvicorn, Gunicorn | MIT / BSD | |
| Database | SQLAlchemy, asyncpg, pgvector, pg_bigm | MIT / Apache-2.0 / PostgreSQL | |
| Cache | Valkey | BSD-3-Clause | Redis-compatible OSS fork |
| PDF parsing | PyMuPDF | AGPL-3.0 | Same license family |
| OCR | surya-ocr | GPL-3.0+ | Compatible with AGPL-3.0 |
| Antivirus | ClamAV | GPL-2.0 | Runs as separate process |
| Document conversion | LibreOffice | MPL-2.0 | Runs as separate process |
| Frontend | React, Vite, Tailwind CSS | MIT | |
| Editor | BlockNote | MPL-2.0 | Compatible via MPL-2.0 §3.3 |
| Collaboration | Yjs, y-websocket | MIT | |
| Video | video.js | Apache-2.0 | v7.0+ |
| LLM / Embedding | llama.cpp | MIT | Model weights have separate licenses |

> **Note**: LLM, Embedding, and OCR **model weights** each have their own licenses (e.g., Meta Llama Community License, Mistral Apache-2.0). Please verify the license of the specific models you use.
