import { useState } from 'react';
import { Bell, Check, CheckCheck, FlaskConical } from 'lucide-react';
import { useApp } from '../store';
import { dateTime, json, request } from '../api';
import type { AlertRecord } from '../types';
import { Badge, Button, Empty, Modal } from './ui';
export function AlertCenter({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { alerts, refresh, notify, mode } = useApp();
  const [status, setStatus] = useState('all'),
    [severity, setSeverity] = useState('all'),
    [busy, setBusy] = useState('');
  const filtered = alerts
    .filter(
      (a) =>
        (status === 'all' || a.status === status) &&
        (severity === 'all' || a.severity === severity),
    )
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
  async function act(alert: AlertRecord, value: 'acknowledged' | 'resolved') {
    const kind = alert.mode === 'live' ? 'Live alert' : 'Test alert';
    setBusy(alert.id);
    try {
      await request(`/alerts/${alert.id}`, json('PATCH', { status: value }));
      await refresh();
      notify(`${kind} ${value} and saved.`);
    } catch (e) {
      notify((e as Error).message);
    } finally {
      setBusy('');
    }
  }
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Local warning center"
      description="TEST alerts are local exercises. LIVE alerts come only from authorized sensor readings crossing saved station thresholds. No public warning, SMS, or government notification is sent."
      wide
    >
      <div className="button-row">
        <select
          aria-label="Filter alert status"
          value={status}
          onChange={(e) => setStatus(e.target.value)}
        >
          {['all', 'active', 'acknowledged', 'resolved'].map((s) => (
            <option key={s} value={s}>
              {s === 'all' ? 'All statuses' : s}
            </option>
          ))}
        </select>
        <select
          aria-label="Filter alert severity"
          value={severity}
          onChange={(e) => setSeverity(e.target.value)}
        >
          {['all', 'watch', 'warning', 'critical'].map((s) => (
            <option key={s} value={s}>
              {s === 'all' ? 'All severities' : s}
            </option>
          ))}
        </select>
        <Button
          onClick={async () => {
            try {
              await request('/alerts/test', json('POST', { mode }));
              await refresh();
              notify('Local test notification generated.');
            } catch (e) {
              notify((e as Error).message);
            }
          }}
        >
          <FlaskConical size={14} />
          Generate test alert
        </Button>
      </div>
      <div className="alert-list">
        {filtered.length ? (
          filtered.map((a) => (
            <article className="alert-record" key={a.id}>
              <div className="section-heading">
                <Badge tone={a.mode === 'live' ? 'red' : 'orange'}>{a.label}</Badge>
                <Badge tone={a.severity === 'critical' ? 'red' : 'orange'}>{a.severity}</Badge>
              </div>
              <h3>
                <Bell size={15} />
                {a.station_name}
              </h3>
              <p>{a.message}</p>
              <div className="detail-row">
                <span>{dateTime(a.created_at)}</span>
                <span className="capitalize">{a.status}</span>
              </div>
              <small className="muted">
                Measurement: {dateTime(a.measurement_timestamp)} · {a.water_level_m ?? '—'} m
                {a.threshold_m != null && ` · threshold ${a.threshold_m} m`}
                {a.received_at && ` · received ${dateTime(a.received_at)}`}
              </small>
              <small className="muted alert-source">Source: {a.source}</small>
              <div className="button-row">
                {a.status === 'active' && (
                  <Button
                    size="sm"
                    disabled={busy === a.id}
                    onClick={() => void act(a, 'acknowledged')}
                  >
                    <Check size={13} />
                    Acknowledge
                  </Button>
                )}
                {a.status !== 'resolved' && (
                  <Button
                    size="sm"
                    disabled={busy === a.id}
                    onClick={() => void act(a, 'resolved')}
                  >
                    <CheckCheck size={13} />
                    {a.mode === 'live' ? 'Resolve alert' : 'Resolve test alert'}
                  </Button>
                )}
              </div>
            </article>
          ))
        ) : (
          <Empty title="No matching alerts">
            Replay monitoring data across a threshold or generate a test notification.
          </Empty>
        )}
      </div>
    </Modal>
  );
}
