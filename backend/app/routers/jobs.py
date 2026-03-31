"""Job status API endpoints."""

import uuid

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_db
from app.deps import get_current_user
from app.models import User
from app.services.job_queue import get_job, get_jobs_by_ids

router = APIRouter(tags=["jobs"], redirect_slashes=False)


def _job_to_dict(job) -> dict:
    return {
        "id": str(job.id),
        "job_type": job.job_type,
        "status": job.status,
        "progress": job.progress,
        "error": job.error,
        "created_at": job.created_at.isoformat() if job.created_at else None,
        "started_at": job.started_at.isoformat() if job.started_at else None,
        "completed_at": job.completed_at.isoformat() if job.completed_at else None,
    }


@router.get("/{job_id}")
async def get_job_status(
    job_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    job = await get_job(db, job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    return _job_to_dict(job)


@router.get("")
async def get_jobs_status(
    ids: str = Query(..., description="Comma-separated job UUIDs"),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    job_ids = [uuid.UUID(x.strip()) for x in ids.split(",") if x.strip()]
    jobs = await get_jobs_by_ids(db, job_ids)
    return {"jobs": [_job_to_dict(j) for j in jobs]}
