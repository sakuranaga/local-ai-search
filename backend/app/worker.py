"""Standalone job queue worker.

Polls the jobs table, claims work via FOR UPDATE SKIP LOCKED,
dispatches to registered handlers.

Usage:
    python -m app.worker [--concurrency 2] [--poll-interval 1.0]
"""

import asyncio
import argparse
import logging
import signal
import traceback
import uuid
from datetime import datetime, timedelta, timezone

from sqlalchemy import update

from app.db import async_session, engine
from app.models import Job
from app.services.job_queue import claim_job, complete_job, fail_job

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Handler registry
# ---------------------------------------------------------------------------

HANDLERS: dict[str, "Callable"] = {}


def register_handler(job_type: str):
    """Decorator to register a job handler."""
    def decorator(func):
        HANDLERS[job_type] = func
        return func
    return decorator


# ---------------------------------------------------------------------------
# Built-in handlers
# ---------------------------------------------------------------------------

@register_handler("document_processing")
async def handle_document_processing(job: Job):
    """Run the document processing pipeline."""
    from app.services.document_processing import process_document_job

    payload = job.payload
    await process_document_job(
        job_id=job.id,
        doc_id=uuid.UUID(payload["doc_id"]),
        storage_path=payload["storage_path"],
        file_type=payload["file_type"],
        filename=payload["filename"],
        session_factory=async_session,
    )


# ---------------------------------------------------------------------------
# Stale job recovery
# ---------------------------------------------------------------------------

async def recover_stale_jobs(timeout_minutes: int = 10):
    """Reset jobs stuck in 'running' status (e.g. worker crashed)."""
    async with async_session() as db:
        cutoff = datetime.now(timezone.utc) - timedelta(minutes=timeout_minutes)
        result = await db.execute(
            update(Job)
            .where(Job.status == "running", Job.started_at < cutoff)
            .values(status="pending", started_at=None)
            .returning(Job.id)
        )
        recovered = result.all()
        if recovered:
            logger.info("Recovered %d stale jobs", len(recovered))
        await db.commit()


# ---------------------------------------------------------------------------
# Worker loop
# ---------------------------------------------------------------------------

_shutdown = False


async def worker_loop(worker_id: int, poll_interval: float):
    """Single worker coroutine that polls for jobs."""
    logger.info("Worker %d started", worker_id)
    while not _shutdown:
        try:
            async with async_session() as db:
                job = await claim_job(db)

            if job is None:
                await asyncio.sleep(poll_interval)
                continue

            handler = HANDLERS.get(job.job_type)
            if handler is None:
                async with async_session() as db:
                    await fail_job(db, job.id, f"No handler for job type: {job.job_type}")
                continue

            logger.info(
                "Worker %d processing job %s [%s]", worker_id, job.id, job.job_type
            )
            try:
                await handler(job)
                async with async_session() as db:
                    await complete_job(db, job.id)
                logger.info("Worker %d completed job %s", worker_id, job.id)
            except Exception as e:
                tb = traceback.format_exc()
                logger.error("Worker %d job %s failed: %s", worker_id, job.id, e)
                async with async_session() as db:
                    await fail_job(db, job.id, f"{e}\n{tb}")

        except Exception as e:
            logger.error("Worker %d unexpected error: %s", worker_id, e)
            await asyncio.sleep(poll_interval)

    logger.info("Worker %d shutting down", worker_id)


async def main(concurrency: int, poll_interval: float):
    global _shutdown

    def handle_signal(*_):
        global _shutdown
        _shutdown = True
        logger.info("Shutdown signal received")

    loop = asyncio.get_event_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, handle_signal)

    await recover_stale_jobs()

    logger.info(
        "Starting %d queue workers (poll interval: %.1fs)", concurrency, poll_interval
    )
    workers = [
        asyncio.create_task(worker_loop(i, poll_interval))
        for i in range(concurrency)
    ]
    await asyncio.gather(*workers)
    await engine.dispose()
    logger.info("All workers stopped")


if __name__ == "__main__":
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    )
    parser = argparse.ArgumentParser(description="Job queue worker")
    parser.add_argument("--concurrency", type=int, default=2)
    parser.add_argument("--poll-interval", type=float, default=1.0)
    args = parser.parse_args()
    asyncio.run(main(args.concurrency, args.poll_interval))
