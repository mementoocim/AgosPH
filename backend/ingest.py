"""HTTP push boundary for authorized sensors and loggers. Validation lives in MonitoringService.ingest."""
import hmac
import json

from fastapi import APIRouter, HTTPException, Request
from starlette.concurrency import run_in_threadpool

from .monitoring import PUSH_CHANNEL

MAX_BODY_BYTES = 1024 * 1024


def ingest_router(monitoring):
    router = APIRouter()

    @router.post('/api/monitoring/ingest')
    async def ingest(request: Request):
        """Accept {"readings": [...]} with `Authorization: Bearer <AGOS_INGEST_TOKEN>`. See docs/DATA_CONTRACTS.md."""
        # Authenticate before reading the body, so unauthorized clients learn nothing about the contract.
        if problem := monitoring.live.problem:
            raise HTTPException(503, problem)
        scheme, _, supplied = request.headers.get('authorization', '').partition(' ')
        if scheme.lower() != 'bearer' or not hmac.compare_digest(supplied.strip().encode(), monitoring.live.token.encode()):
            raise HTTPException(401, 'A valid bearer token is required for live ingestion', headers={'WWW-Authenticate': 'Bearer'})
        if int(request.headers.get('content-length') or 0) > MAX_BODY_BYTES:
            raise HTTPException(413, 'Ingestion requests are limited to 1 MiB; send smaller batches')
        body = bytearray()
        async for chunk in request.stream():
            body += chunk
            if len(body) > MAX_BODY_BYTES:
                raise HTTPException(413, 'Ingestion requests are limited to 1 MiB; send smaller batches')
        try:
            payload = json.loads(body)
        except ValueError:
            raise ValueError('Request body must be JSON: {"readings": [...]}') from None
        return await run_in_threadpool(monitoring.ingest, payload, PUSH_CHANNEL, request.client.host if request.client else None)

    return router
