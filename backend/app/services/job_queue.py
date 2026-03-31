"""Generic DB-based job queue service.

Jobs are stored in PostgreSQL. Workers claim jobs via
SELECT ... FOR UPDATE SKIP LOCKED for safe concurrent access.
"""

import logging
import uuid
from datetime import datetime, timezone

from sqlalchemy import select, update, func
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Job

logger = logging.getLogger(__name__)


async def create_job(
    db: AsyncSession,
    job_type: str,
    payload: dict,
    *,
    max_attempts: int = 3,
) -> Job:
    """Insert a new job. Caller must commit."""
    job = Job(
        job_type=job_type,
        payload=payload,
        status="pending",
        max_attempts=max_attempts,
    )
    db.add(job)
    await db.flush()
    return job


async def create_jobs_bulk(
    db: AsyncSession,
    job_type: str,
    payloads: list[dict],
    *,
    max_attempts: int = 3,
) -> list[Job]:
    """Insert multiple jobs. Caller must commit."""
    jobs = []
    for payload in payloads:
        job = Job(
            job_type=job_type,
            payload=payload,
            status="pending",
            max_attempts=max_attempts,
        )
        db.add(job)
        jobs.append(job)
    await db.flush()
    return jobs


async def claim_job(
    db: AsyncSession,
    job_types: list[str] | None = None,
) -> Job | None:
    """Claim the oldest pending job using FOR UPDATE SKIP LOCKED.

    Returns None if no work is available.
    Caller should NOT wrap this in an outer transaction — the function
    commits internally so the lock is released promptly.
    """
    query = (
        select(Job)
        .where(Job.status == "pending")
        .where(Job.scheduled_at <= func.now())
        .order_by(Job.scheduled_at)
        .limit(1)
        .with_for_update(skip_locked=True)
    )
    if job_types:
        query = query.where(Job.job_type.in_(job_types))

    result = await db.execute(query)
    job = result.scalar_one_or_none()
    if job is None:
        return None

    job.status = "running"
    job.started_at = datetime.now(timezone.utc)
    job.attempts += 1
    await db.commit()
    return job


async def update_progress(db: AsyncSession, job_id: uuid.UUID, progress: str):
    """Update the progress label for a running job."""
    await db.execute(
        update(Job)
        .where(Job.id == job_id)
        .values(progress=progress, updated_at=func.now())
    )
    await db.commit()


async def complete_job(
    db: AsyncSession,
    job_id: uuid.UUID,
    result_data: dict | None = None,
):
    """Mark job as completed."""
    r = await db.execute(select(Job).where(Job.id == job_id))
    job = r.scalar_one_or_none()
    if not job:
        return
    job.status = "completed"
    job.progress = None
    job.result = result_data
    job.completed_at = datetime.now(timezone.utc)
    await db.commit()


async def fail_job(db: AsyncSession, job_id: uuid.UUID, error: str):
    """Mark job as failed. Retries if attempts < max_attempts."""
    result = await db.execute(select(Job).where(Job.id == job_id))
    job = result.scalar_one_or_none()
    if not job:
        return

    if job.attempts < job.max_attempts:
        job.status = "pending"
        job.error = error
        job.started_at = None
        logger.info(
            "Job %s will retry (attempt %d/%d)", job_id, job.attempts, job.max_attempts
        )
    else:
        job.status = "failed"
        job.error = error
        job.completed_at = datetime.now(timezone.utc)
        logger.error("Job %s failed permanently: %s", job_id, error)

    await db.commit()


async def get_job(db: AsyncSession, job_id: uuid.UUID) -> Job | None:
    result = await db.execute(select(Job).where(Job.id == job_id))
    return result.scalar_one_or_none()


async def get_jobs_by_ids(db: AsyncSession, job_ids: list[uuid.UUID]) -> list[Job]:
    result = await db.execute(select(Job).where(Job.id.in_(job_ids)))
    return list(result.scalars().all())
