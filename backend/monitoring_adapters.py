"""Explicit extension boundary for live monitoring sources.

Every adapter feeds the same validation, provenance, and alert path as authorized HTTP push
(MonitoringService.ingest). No adapter scrapes public websites or assumes an endpoint. Register
an enabled pull adapter only for a documented, authorized interface, with a verified field
mapping, declared units, recorded fixtures, and tests.
"""
from typing import Protocol


class AdapterUnavailable(RuntimeError):
    """The source is not authorized or configured; nothing was requested."""


class MonitoringAdapter(Protocol):
    name: str
    transport: str  # 'push': readings arrive over HTTP; 'pull': AgosPH requests them

    def capability(self) -> dict: ...

    def poll(self) -> list[dict]: ...


class AuthorizedPushAdapter:
    name = 'Authorized sensor push'
    transport = 'push'

    def __init__(self, settings):
        self.settings = settings

    def capability(self):
        problem = self.settings.problem
        return {'name': self.name, 'transport': self.transport, 'enabled': not problem, 'detail': problem or 'Accepting authorized readings at POST /api/monitoring/ingest (bearer token).'}

    def poll(self):
        raise AdapterUnavailable('Authorized sensors push readings to POST /api/monitoring/ingest; there is nothing to poll.')


class PagasaAdapter:
    name = 'PAGASA'
    transport = 'pull'
    requirement = ('Requires an authorized endpoint and credentials issued by PAGASA (for example under a data-sharing agreement) '
                   'and a documented field mapping. No endpoint is assumed and public websites are not scraped.')

    def __init__(self, endpoint=None, credentials=None):
        self.endpoint, self.credentials = endpoint, credentials

    def capability(self):
        state = 'Disabled: endpoint and credentials supplied, but no verified field mapping is implemented.' if self.endpoint and self.credentials else 'Disabled.'
        return {'name': self.name, 'transport': self.transport, 'enabled': False, 'detail': f'{state} {self.requirement}'}

    def poll(self):
        raise AdapterUnavailable('PAGASA adapter is disabled. ' + self.requirement)


class MonitoringAdapterRegistry:
    def __init__(self):
        self.adapters: dict[str, MonitoringAdapter] = {}

    def register(self, adapter: MonitoringAdapter):
        if adapter.name in self.adapters:
            raise ValueError('Adapter already registered')
        self.adapters[adapter.name] = adapter

    def get(self, name):
        return self.adapters[name]

    def capabilities(self):
        return [a.capability() for a in self.adapters.values()]
