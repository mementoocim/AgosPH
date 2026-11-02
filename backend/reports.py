import base64
import csv
import io
from datetime import datetime, timedelta, timezone
from html import escape
from PIL import Image as PILImage
from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle, Image
from .config import DISCLAIMER
from .datasets import now


def csv_bytes(rows, columns=()):
    buffer = io.StringIO(newline='')
    # Declared columns keep an empty export self-describing.
    fields = list(dict.fromkeys([*columns, *(key for row in rows for key in row)])) or ['status']
    writer = csv.DictWriter(buffer, fieldnames=fields)
    writer.writeheader()
    for row in rows:
        safe = {}
        for key, value in row.items():
            if isinstance(value, (dict, list)):
                import json
                value = json.dumps(value)
            # Prevent spreadsheet formula execution in exported user-supplied strings.
            if isinstance(value, str) and value.lstrip().startswith(('=', '+', '-', '@')):
                value = "'" + value
            safe[key] = value
        writer.writerow(safe)
    return buffer.getvalue().encode('utf-8-sig')


def pht(value):
    try:
        return datetime.fromisoformat(value).astimezone(timezone(timedelta(hours=8))).strftime('%Y-%m-%d %H:%M PHT')
    except (OverflowError, ValueError):
        return value  # A hand-edited, out-of-range time is shown as stored rather than failing the report.


def pdf_report(scenario, exposure, monitoring, alerts, screenshot=None, incidents=()):
    buffer = io.BytesIO()
    doc = SimpleDocTemplate(buffer, pagesize=A4, title='AgosPH local scenario report', author='AgosPH', rightMargin=40, leftMargin=40)
    styles = getSampleStyleSheet()
    story = []
    def paragraph(text, style='BodyText'):
        story.append(Paragraph(escape(str(text)), styles[style]))
        story.append(Spacer(1, 7))
    paragraph('AgosPH | Flood intelligence', 'Title')
    paragraph(DISCLAIMER, 'Heading2')
    paragraph('Generated: ' + now())
    paragraph(scenario['name'], 'Heading1')
    for label, value in [('Data mode', scenario['mode'].upper()), ('Validation', scenario['validation_label']), ('Source', scenario['source']), ('Model', scenario['model']), ('Model version', scenario['model_version'] or 'Not supplied'), ('Evidence notes', scenario['validation_notes'] or 'No independent scientific validation'), ('Description', scenario['description']), ('Assumptions (not recomputed outputs)', scenario['assumptions'])]:
        paragraph(f'{label}: {value}')
    if screenshot:
        if not screenshot.startswith('data:image/png;base64,') or len(screenshot) > 12_000_000:
            raise ValueError('Screenshot must be a PNG data URL below 9 MB')
        raw = base64.b64decode(screenshot.split(',', 1)[1], validate=True)
        with PILImage.open(io.BytesIO(raw)) as im:
            if im.width * im.height > 16_000_000:
                raise ValueError('Screenshot exceeds 16 million pixels')
            im.verify()
        image = Image(io.BytesIO(raw))
        image.drawHeight = min(260, 510 * image.imageHeight / image.imageWidth)
        image.drawWidth = image.drawHeight * image.imageWidth / image.imageHeight
        story.append(image)
        paragraph('Map capture supplied by local browser; geographic and demonstration layers retain their stated provenance.')
    paragraph('Hazard and geographic exposure', 'Heading2')
    if exposure:
        paragraph(f"Simulation timestamp: {exposure['timestamp']} | Inundation: {exposure['inundation_area_m2'] / 1_000_000:.4f} km² | Maximum depth: {exposure['maximum_depth_m']} m")
        paragraph(f"Hazard data mode: {exposure['mode']} | Reference geography: {exposure['reference_geography']}")
        if exposure['mode'] == 'demonstration' and exposure['reference_geography'] == 'imported':
            paragraph('ILLUSTRATIVE hazard intersected with imported reference geography. Named areas and assets are not an impact assessment.')
        paragraph(exposure['method'])
        for role, count in exposure['counts'].items():
            total = exposure.get('totals', {}).get(role)
            paragraph(f"{role}: {'unavailable' if count is None else f'{count} intersecting of {total}'}")
        for source in exposure['sources']:
            paragraph(f"Geographic source: {source['name']} | {source['source']} | {source['mode']}")
        for missing in exposure['unavailable']:
            paragraph('Unavailable: ' + missing)

        def inundated(row):
            if row['inundation_area_m2'] is not None:
                return f"{row['inundation_area_m2'] / 1_000_000:.3f} km² ({row.get('inundated_share', 0) * 100:.0f}%)"
            if row['inundated_length_m'] is not None:
                return f"{row['inundated_length_m']:.0f} m length"
            return 'Flooded point'
        table_rows = [['Area / asset', 'Role', 'Inundated', 'Max depth (m)', 'Flooded buildings']]
        for row in exposure['features'][:100]:
            buildings = row.get('flooded_buildings')
            table_rows.append([Paragraph(escape(row['name']), styles['BodyText']), row['role'], inundated(row), str(round(row['maximum_depth_m'], 2)) if row['maximum_depth_m'] is not None else 'N/A', 'N/A' if buildings is None else str(buildings)])
        table = Table(table_rows, colWidths=[170, 70, 120, 75, 80], repeatRows=1)
        table.setStyle(TableStyle([('BACKGROUND', (0, 0), (-1, 0), colors.HexColor('#e2eef2')), ('VALIGN', (0, 0), (-1, -1), 'TOP'), ('GRID', (0, 0), (-1, -1), .3, colors.lightgrey), ('FONTSIZE', (0, 0), (-1, -1), 9)]))
        story.append(table)
        if len(exposure['features']) > 100:
            paragraph('First 100 intersecting features shown; export CSV for all rows.')
    else:
        paragraph('No computed outputs: scenario is pending a model run.')
    paragraph('Monitoring summary', 'Heading2')
    paragraph(monitoring['label'] + ' | ' + str(monitoring['timestamp']))
    for station in monitoring['stations']:
        latest = station['latest'] or {}
        paragraph(f"{station['name']}: {latest.get('water_level_m', 'unavailable')} m | Rainfall: {latest.get('rainfall_mm', 'unavailable')} mm per interval | {station['severity']} | timestamp: {latest.get('timestamp', 'unavailable')} | Source: {station['source']}")
    live = monitoring.get('live') or {}
    paragraph('Live telemetry (authorized ingestion only)', 'Heading3')
    if not live.get('stations'):
        paragraph('No authorized live readings received. ' + (live.get('ingest') or {}).get('detail', ''))
    for station in live.get('stations', []):
        latest = station['latest']
        paragraph(f"{station['freshness'].upper()} | {station['name']}: {latest.get('water_level_m', 'unavailable')} m | Rainfall: {latest.get('rainfall_mm', 'unavailable')} mm per interval | observed: {latest['timestamp']} | received: {station['received_at']} | Source: {station['source']}")
    paragraph('Local alert history: TEST exercises and LIVE threshold alerts', 'Heading2')
    for alert in sorted(alerts, key=lambda a: a['created_at'])[-50:]:
        paragraph(f"{alert['label']} | {alert['created_at']} | {alert['station_name']} | {alert['severity']} | {alert['status']} | Source: {alert['source']}")
    exercise = scenario['mode'] == 'demonstration'
    label = ('EXERCISE · DEMONSTRATION MODE · drill entries typed by an operator, not real incidents' if exercise
             else 'OPERATOR LOG · USER-ENTERED field reports · "verified" is the operator\'s own confirmation, not an independent one')
    paragraph('Exercise incident log' if exercise else 'Operator incident log', 'Heading2')
    paragraph(label)
    if incidents:
        small = ParagraphStyle('IncidentCell', parent=styles['BodyText'], fontSize=8, leading=10)
        cell = lambda text: Paragraph(text, small)
        # The label row repeats with the column headers on every page the table spans.
        rows = [[cell(f'<b>{escape(label)}</b>'), '', '', '', '', ''], ['Reported', 'Type', 'Severity', 'Status', 'Barangay', 'Incident']]
        for incident in incidents[:100]:
            location = f"{incident['latitude']:.5f}, {incident['longitude']:.5f}" if incident['latitude'] is not None else 'No map location'
            barangay = incident['barangay'] or 'Not stated'
            if incident['barangay'] and not incident['barangay_validated']:
                barangay += ' (unchecked)'
            description = incident['description'][:280] + ('…' if len(incident['description']) > 280 else '')
            details = '<br/>'.join(escape(x) for x in (incident['title'], description, f"Reported by {incident['reporter']} · {location}") if x)
            rows.append([cell(pht(incident['reported_at'])), cell(incident['type'].replace('_', ' ')), cell(incident['severity']),
                         cell(f"{incident['status']}<br/>{pht(incident['history'][-1]['at'])}"), cell(escape(barangay)), cell(details)])
        table = Table(rows, colWidths=[78, 62, 50, 72, 78, 175], repeatRows=2)
        table.setStyle(TableStyle([('SPAN', (0, 0), (-1, 0)), ('BACKGROUND', (0, 0), (-1, 0), colors.HexColor('#f6ead8')), ('BACKGROUND', (0, 1), (-1, 1), colors.HexColor('#e2eef2')), ('VALIGN', (0, 0), (-1, -1), 'TOP'), ('GRID', (0, 0), (-1, -1), .3, colors.lightgrey), ('FONTSIZE', (0, 0), (-1, -1), 8)]))
        story.append(table)
        if len(incidents) > 100:
            paragraph('Latest 100 incidents shown; export the incident CSV for all records.')
    else:
        paragraph('No incidents logged in this data mode.')
    paragraph('Simulation frame metadata', 'Heading2')
    frame_rows = [['Timestamp (ISO 8601)', 'Depth dataset ID', 'Velocity dataset ID']]
    frame_rows.extend([[f['timestamp'], f['depth'], f.get('velocity') or 'unavailable'] for f in scenario['frames'][:100]])
    if scenario['frames']:
        frame_table = Table(frame_rows, colWidths=[150, 180, 180], repeatRows=1)
        frame_table.setStyle(TableStyle([('BACKGROUND', (0, 0), (-1, 0), colors.HexColor('#e2eef2')), ('GRID', (0, 0), (-1, -1), .3, colors.lightgrey), ('FONTNAME', (0, 0), (-1, -1), 'Helvetica'), ('FONTSIZE', (0, 0), (-1, -1), 7), ('VALIGN', (0, 0), (-1, -1), 'TOP')]))
        story.append(frame_table)
    if len(scenario['frames']) > 100:
        paragraph('First 100 frames shown; export metadata CSV for the complete timeline.')
    def footer(canvas, doc):
        canvas.saveState()
        canvas.setFont('Helvetica', 8)
        canvas.setFillColor(colors.HexColor('#687c87'))
        canvas.drawString(40, 24, 'AgosPH local evaluation | NOT FOR OPERATIONAL FLOOD FORECASTING')
        canvas.drawRightString(A4[0] - 40, 24, f'Page {doc.page}')
        canvas.restoreState()
    doc.build(story, onFirstPage=footer, onLaterPages=footer)
    return buffer.getvalue()
