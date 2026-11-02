from datetime import datetime, timedelta, timezone
from typing import Literal
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

Mode = Literal['demonstration', 'imported']
Metric = Literal['depth', 'velocity', 'direction', 'wse', 'maximum', 'arrival', 'duration', 'extent']


class Frame(BaseModel):
    model_config = ConfigDict(extra='forbid')
    timestamp: datetime
    depth: str
    velocity: str | None = None
    direction: str | None = None
    wse: str | None = None

    @field_validator('timestamp')
    @classmethod
    def timezone_required(cls, value):
        if value.tzinfo is None:
            raise ValueError('Timestamp must include a UTC offset')
        return value


class ScenarioInput(BaseModel):
    model_config = ConfigDict(extra='forbid')
    name: str = Field(min_length=1, max_length=100)
    description: str = Field(default='', max_length=3000)
    mode: Mode = 'imported'
    status: Literal['illustrative', 'unvalidated', 'validated', 'pending'] = 'pending'
    source: str = Field(min_length=1, max_length=1000)
    model: str = Field(default='Imported georeferenced results', max_length=200)
    model_version: str = Field(default='', max_length=100)
    validation_notes: str = Field(default='', max_length=3000)
    assumptions: dict = Field(default_factory=dict)
    frames: list[Frame] = Field(default_factory=list, max_length=1000)
    settings: dict = Field(default_factory=dict)

    @model_validator(mode='after')
    def scientific_status(self):
        if self.mode == 'demonstration' and self.status != 'illustrative':
            raise ValueError('Demonstration scenarios must be illustrative')
        if self.status == 'validated' and not self.validation_notes.strip():
            raise ValueError('User-asserted validation requires evidence notes')
        if self.status == 'pending' and self.frames:
            raise ValueError('Pending model runs cannot contain computed outputs')
        if self.status != 'pending' and not self.frames:
            raise ValueError('Result scenarios require at least one depth frame')
        return self


class Thresholds(BaseModel):
    watch: float = Field(ge=0, le=1000)
    warning: float = Field(ge=0, le=1000)
    critical: float = Field(ge=0, le=1000)

    @model_validator(mode='after')
    def ordered(self):
        if not self.watch < self.warning < self.critical:
            raise ValueError('Thresholds must increase: watch < warning < critical')
        return self


class AlertUpdate(BaseModel):
    status: Literal['acknowledged', 'resolved']


class ReplayStep(BaseModel):
    mode: Mode = 'demonstration'
    rainfall_scenario: Literal['steady', 'intense'] = 'steady'


class AlertExercise(BaseModel):
    mode: Mode = 'demonstration'


class ConnectionInput(BaseModel):
    station_id: str
    connected: bool


class SettingsInput(BaseModel):
    model_config = ConfigDict(extra='forbid')
    terrain_url: str = ''
    imagery_url: str = ''
    imagery_attribution: str = ''
    terrain_dataset: str = ''
    # With no explicit provider, render the first imported DEM unless disabled.
    terrain_auto: bool = True
    exaggeration: float = Field(default=1, ge=1, le=8)
    cameras: list[dict] = Field(default_factory=list, max_length=30)
    layers: dict = Field(default_factory=dict)
    opacity: float = Field(default=.72, ge=0, le=1)
    active_scenario: str = ''
    data_mode: Mode = 'demonstration'

    @field_validator('terrain_url', 'imagery_url')
    @classmethod
    def safe_url(cls, value):
        if value and not value.startswith(('https://', 'http://localhost', 'http://127.0.0.1', '/api/')):
            raise ValueError('Use HTTPS or a local provider URL')
        return value


IncidentType = Literal['flooding', 'landslide', 'road_closure', 'rescue_request', 'evacuation', 'other']
IncidentSeverity = Literal['low', 'moderate', 'high', 'critical']
IncidentStatus = Literal['reported', 'verified', 'responding', 'resolved']


class IncidentInput(BaseModel):
    model_config = ConfigDict(extra='forbid', str_strip_whitespace=True)
    type: IncidentType
    title: str = Field(min_length=1, max_length=120)
    description: str = Field(default='', max_length=3000)
    severity: IncidentSeverity
    barangay: str = Field(default='', max_length=100)
    longitude: float | None = Field(default=None, ge=-180, le=180)
    latitude: float | None = Field(default=None, ge=-90, le=90)
    reporter: str = Field(min_length=1, max_length=200)
    reported_at: datetime | None = None
    # A record that does not declare its mode is an exercise, never a real report.
    mode: Mode = 'demonstration'

    @field_validator('reported_at')
    @classmethod
    def reported_time(cls, value):
        if value is not None and value.tzinfo is None:
            raise ValueError('Reported time must include a UTC offset')
        if value is not None and value > datetime.now(timezone.utc) + timedelta(minutes=5):
            raise ValueError('Reported time cannot be in the future')
        # Catches year typos such as 0026; aware comparisons never overflow.
        if value is not None and value < datetime(2000, 1, 1, tzinfo=timezone.utc):
            raise ValueError('Reported time is before 2000; check the year')
        return value

    @model_validator(mode='after')
    def location_pair(self):
        if (self.longitude is None) != (self.latitude is None):
            raise ValueError('Supply both longitude and latitude, or neither')
        return self


class IncidentUpdate(BaseModel):
    status: IncidentStatus
