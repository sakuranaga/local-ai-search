"""Virus scanning service using ClamAV.

Scans uploaded files via clamd network socket. If ClamAV is unavailable,
scanning is skipped with a warning (non-blocking).
"""

import logging

import pyclamd

logger = logging.getLogger(__name__)

CLAMAV_HOST = "clamav"
CLAMAV_PORT = 3310
CLAMAV_TIMEOUT = 120


async def scan_file(file_path: str) -> tuple[str, str]:
    """Scan a file with ClamAV.

    Returns (status, message) where status is one of:
      - "clean": No virus detected
      - "infected": Virus detected (message contains virus name)
      - "skipped": ClamAV unavailable
      - "error": Scan error
    """
    try:
        cd = pyclamd.ClamdNetworkSocket(
            host=CLAMAV_HOST, port=CLAMAV_PORT, timeout=CLAMAV_TIMEOUT
        )
        # Test connection
        if not cd.ping():
            logger.warning("ClamAV not responding, skipping virus scan")
            return "skipped", "ClamAV unavailable"

        result = cd.scan_file(file_path)

        if result is None:
            return "clean", "OK"

        # result format: {'/path/to/file': ('FOUND', 'VirusName')}
        for path, (status, virus_name) in result.items():
            if status == "FOUND":
                logger.warning("Virus detected in %s: %s", file_path, virus_name)
                return "infected", virus_name

        return "clean", "OK"

    except pyclamd.ConnectionError:
        logger.warning("ClamAV connection failed, skipping virus scan")
        return "skipped", "ClamAV unavailable"
    except Exception as e:
        logger.exception("Virus scan error for %s", file_path)
        return "error", str(e)
