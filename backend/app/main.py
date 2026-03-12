import asyncio
import logging
import shutil
from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import engine, get_db
from app.deps import get_current_user
from app.models import Base, Chunk, Document, User
from app.routers import auth, chat, documents, folders, groups, roles, search, settings, tags, users

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

_db_initialized = False


async def init_db():
    global _db_initialized
    if _db_initialized:
        return
    logger.info("Initializing database...")

    async with engine.begin() as conn:
        await conn.execute(text("CREATE EXTENSION IF NOT EXISTS vector"))
        logger.info("pgvector extension enabled")

    try:
        async with engine.begin() as conn:
            await conn.execute(text("CREATE EXTENSION IF NOT EXISTS pg_bigm"))
            logger.info("pg_bigm extension enabled")
    except Exception as e:
        logger.warning(f"pg_bigm extension not available: {e}. LIKE queries will work but without GIN acceleration.")

    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)

    # Migrate: add new columns to documents table if they don't exist
    async with engine.begin() as conn:
        await conn.execute(text("ALTER TABLE documents ADD COLUMN IF NOT EXISTS memo TEXT DEFAULT ''"))
        await conn.execute(text("ALTER TABLE documents ADD COLUMN IF NOT EXISTS created_by_id UUID REFERENCES users(id) ON DELETE SET NULL"))
        await conn.execute(text("ALTER TABLE documents ADD COLUMN IF NOT EXISTS updated_by_id UUID REFERENCES users(id) ON DELETE SET NULL"))
        await conn.execute(text("ALTER TABLE documents ADD COLUMN IF NOT EXISTS searchable BOOLEAN DEFAULT TRUE"))
        await conn.execute(text("ALTER TABLE documents ADD COLUMN IF NOT EXISTS ai_knowledge BOOLEAN DEFAULT TRUE"))
        await conn.execute(text("ALTER TABLE users ADD COLUMN IF NOT EXISTS display_name VARCHAR(255) DEFAULT ''"))
        await conn.execute(text("ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_url VARCHAR(1000)"))
        await conn.execute(text("ALTER TABLE documents ADD COLUMN IF NOT EXISTS folder_id UUID REFERENCES folders(id) ON DELETE SET NULL"))
        await conn.execute(text("CREATE INDEX IF NOT EXISTS ix_documents_folder_id ON documents(folder_id)"))
        await conn.execute(text("ALTER TABLE documents ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ"))
        await conn.execute(text("ALTER TABLE documents ADD COLUMN IF NOT EXISTS summary TEXT DEFAULT ''"))
        await conn.execute(text("ALTER TABLE documents ADD COLUMN IF NOT EXISTS processing_status VARCHAR(30) DEFAULT 'done' NOT NULL"))
        logger.info("Document table migration columns verified")

    # Phase 0: Role simplification (Admin/User)
    async with engine.begin() as conn:
        # Ensure 'admin' and 'user' roles exist
        await conn.execute(text(
            "INSERT INTO roles (name, permissions) VALUES ('admin', 'admin') ON CONFLICT (name) DO NOTHING"
        ))
        await conn.execute(text(
            "INSERT INTO roles (name, permissions) VALUES ('user', 'search') ON CONFLICT (name) DO NOTHING"
        ))
        # Migrate editor/viewer users to 'user' role
        user_role_id = (await conn.execute(text(
            "SELECT id FROM roles WHERE name = 'user'"
        ))).scalar()
        if user_role_id:
            old_roles = (await conn.execute(text(
                "SELECT id FROM roles WHERE name IN ('editor', 'viewer')"
            ))).scalars().all()
            for old_id in old_roles:
                # Re-assign users from old role to 'user'
                await conn.execute(text(
                    "UPDATE user_roles SET role_id = :new_id WHERE role_id = :old_id "
                    "AND user_id NOT IN (SELECT user_id FROM user_roles WHERE role_id = :new_id)"
                ), {"new_id": user_role_id, "old_id": old_id})
                # Remove duplicates
                await conn.execute(text(
                    "DELETE FROM user_roles WHERE role_id = :old_id"
                ), {"old_id": old_id})
            # Delete old roles
            await conn.execute(text(
                "DELETE FROM roles WHERE name IN ('editor', 'viewer')"
            ))
        logger.info("Role simplification (Admin/User) done")

    # Phase 1: Unix permissions migration
    async with engine.begin() as conn:
        # Document Unix permission columns
        await conn.execute(text("ALTER TABLE documents ADD COLUMN IF NOT EXISTS group_id UUID REFERENCES groups(id) ON DELETE SET NULL"))
        await conn.execute(text("ALTER TABLE documents ADD COLUMN IF NOT EXISTS group_read BOOLEAN DEFAULT FALSE"))
        await conn.execute(text("ALTER TABLE documents ADD COLUMN IF NOT EXISTS group_write BOOLEAN DEFAULT FALSE"))
        await conn.execute(text("ALTER TABLE documents ADD COLUMN IF NOT EXISTS others_read BOOLEAN DEFAULT TRUE"))
        await conn.execute(text("ALTER TABLE documents ADD COLUMN IF NOT EXISTS others_write BOOLEAN DEFAULT FALSE"))

        # Folder Unix permission columns
        await conn.execute(text("ALTER TABLE folders ADD COLUMN IF NOT EXISTS owner_id UUID REFERENCES users(id) ON DELETE SET NULL"))
        await conn.execute(text("ALTER TABLE folders ADD COLUMN IF NOT EXISTS group_id UUID REFERENCES groups(id) ON DELETE SET NULL"))
        await conn.execute(text("ALTER TABLE folders ADD COLUMN IF NOT EXISTS group_read BOOLEAN DEFAULT FALSE"))
        await conn.execute(text("ALTER TABLE folders ADD COLUMN IF NOT EXISTS group_write BOOLEAN DEFAULT FALSE"))
        await conn.execute(text("ALTER TABLE folders ADD COLUMN IF NOT EXISTS others_read BOOLEAN DEFAULT TRUE"))
        await conn.execute(text("ALTER TABLE folders ADD COLUMN IF NOT EXISTS others_write BOOLEAN DEFAULT FALSE"))

        # Migrate is_public → others_read
        # Check if is_public column exists before migrating
        col_check = await conn.execute(text(
            "SELECT column_name FROM information_schema.columns "
            "WHERE table_name = 'documents' AND column_name = 'is_public'"
        ))
        if col_check.scalar_one_or_none():
            await conn.execute(text("UPDATE documents SET others_read = is_public WHERE others_read != is_public"))
            await conn.execute(text("ALTER TABLE documents DROP COLUMN IF EXISTS is_public"))
            logger.info("Migrated is_public → others_read and dropped is_public column")

        # Set owner_id from created_by_id for existing documents
        await conn.execute(text(
            "UPDATE documents SET owner_id = created_by_id WHERE owner_id IS NULL AND created_by_id IS NOT NULL"
        ))

        # Drop document_permissions table (no longer needed)
        await conn.execute(text("DROP TABLE IF EXISTS document_permissions"))
        logger.info("Unix permissions migration done")

    async with engine.begin() as conn:
        try:
            await conn.execute(
                text(
                    "CREATE INDEX IF NOT EXISTS ix_chunks_content_bigm "
                    "ON chunks USING gin (content gin_bigm_ops)"
                )
            )
        except Exception:
            pass

    _db_initialized = True
    logger.info("Database tables created/verified")


@asynccontextmanager
async def lifespan(app: FastAPI):
    await init_db()
    yield
    await engine.dispose()
    logger.info("Database connections closed")


app = FastAPI(
    title="Local AI Search",
    description="Self-hosted AI-powered document search with RAG",
    version="0.1.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(auth.router, prefix="/api")
app.include_router(users.router, prefix="/api")
app.include_router(search.router, prefix="/api")
app.include_router(documents.router, prefix="/api")
app.include_router(settings.router, prefix="/api")
app.include_router(roles.router, prefix="/api")
app.include_router(chat.router, prefix="/api")
app.include_router(folders.router, prefix="/api")
app.include_router(groups.router, prefix="/api")
app.include_router(tags.router, prefix="/api")


@app.get("/api/health")
async def health():
    return {"status": "ok", "service": "local-ai-search"}


@app.get("/api/stats")
async def stats(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    doc_count = await db.scalar(select(func.count()).select_from(Document).where(Document.deleted_at.is_(None)))
    chunk_count = await db.scalar(select(func.count()).select_from(Chunk))

    from app.config import settings
    usage = shutil.disk_usage(settings.STORAGE_PATH)

    return {
        "total_documents": doc_count or 0,
        "total_chunks": chunk_count or 0,
        "disk_used_bytes": usage.used,
        "disk_total_bytes": usage.total,
    }
