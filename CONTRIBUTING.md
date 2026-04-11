# Contributing to LAS

Thank you for your interest in contributing to LAS! This guide will help you get started.

## Development Setup

### Prerequisites

- Docker & Docker Compose
- Node.js 20+
- A local LLM server (e.g., Ollama, vLLM) for AI features
- A local embedding server for vector search

### Getting Started

```bash
# 1. Clone the repository
git clone https://github.com/sakuranaga/local-ai-search.git
cd local-ai-search

# 2. Copy environment file and configure
cp .env.example .env
# Edit .env with your settings (see .env.example for descriptions)

# 3. Start backend services
docker compose up -d

# 4. Build the frontend
cd frontend
npm ci
npx vite build
cd ..

# 5. Restart nginx to serve the frontend
docker compose restart nginx
```

The application will be available at `http://localhost:3002`.

### Development Workflow

**Backend changes:**

```bash
docker compose up -d --build backend
docker compose restart nginx
```

**Frontend changes:**

```bash
cd frontend
npx vite build
docker compose restart nginx
```

For frontend development with hot reload:

```bash
cd frontend
npx vite dev
```

### OCR Server (optional)

The OCR server runs on the host machine with GPU access. See [ocr-server/README.md](ocr-server/README.md) for setup instructions.

## Making Changes

### Branch Naming

- `feature/description` — new features
- `fix/description` — bug fixes
- `docs/description` — documentation changes

### Code Style

- **UI text**: Japanese (i18n is planned for the future)
- **Commit messages**: English
- **Frontend**: React + TypeScript. Use existing patterns and components
- **Backend**: Python (FastAPI). Follow existing code structure

### Commit Messages

Write clear, concise commit messages in English:

```
Add folder permission check to delete endpoint

Fix search results not updating after document rebuild
```

### Database Migrations

LAS does not use Alembic. Migrations are written as `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` statements in `backend/app/main.py` `init_db()`. This ensures idempotent schema updates on every startup.

## Pull Requests

1. Fork the repository and create your branch from `main`
2. Make your changes and test them locally
3. Ensure the frontend builds without errors: `cd frontend && npx vite build`
4. Submit a PR with a clear description of the changes

### PR Description

- What the change does and why
- How to test it
- Screenshots for UI changes

## Reporting Issues

- Use the [bug report template](.github/ISSUE_TEMPLATE/bug_report.md) for bugs
- Use the [feature request template](.github/ISSUE_TEMPLATE/feature_request.md) for ideas
- Search existing issues before creating a new one

## Architecture Overview

```
frontend/          React 19 + TypeScript + Vite
backend/           FastAPI (Python 3.12), runs in Docker
  app/
    routers/       API endpoints
    services/      Business logic (search, parsing, AI)
    models.py      SQLAlchemy models
    config.py      Pydantic settings
    worker.py      Background job processor
ocr-server/        Surya OCR server (runs on host with GPU)
share-server/      External file sharing server (Go)
discord-las-bot/   Discord integration (Go)
integration/       Third-party integrations (Notion sync, etc.)
nginx/             Reverse proxy configuration
db/                PostgreSQL + pgvector + pg_bigm
scripts/           Utility scripts (backup, release)
```

## License

By contributing, you agree that your contributions will be licensed under the [AGPL-3.0 License](LICENSE).
