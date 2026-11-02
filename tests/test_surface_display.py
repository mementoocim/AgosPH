import io

import numpy as np
from PIL import Image


def png(response):
    assert response.status_code == 200, response.text
    with Image.open(io.BytesIO(response.content)) as im:
        return np.array(im.convert('RGBA'))


def surface(client, metric='depth', smooth=None, frame=4, version=''):
    query = f'frame={frame}&metric={metric}'
    if smooth is not None:
        query += f'&smooth={smooth}'
    if version:
        query += f'&v={version}'
    return client.get(f'/api/scenarios/demo-standard/surface.png?{query}')


def test_model_cell_display_keeps_the_native_grid(client):
    assert png(surface(client)).shape[:2] == (32, 32)
    assert png(surface(client, smooth=0)).shape[:2] == (32, 32)


def test_smooth_display_interpolates_edges_at_higher_resolution(client):
    cells, smooth = png(surface(client, smooth=0)), png(surface(client, smooth=1))
    assert smooth.shape[0] >= 2 * cells.shape[0] and smooth.shape[1] >= 2 * cells.shape[1]
    # Bilinear depth gives intermediate values, so more distinct colors than the class palette alone.
    wet = smooth[smooth[..., 3] > 0][:, :3]
    assert len(np.unique(wet, axis=0)) >= 3


def test_flow_direction_is_never_interpolated(client):
    # Averaging angles across 0/360 degrees would invent directions.
    assert png(surface(client, metric='direction', smooth=1)).shape[:2] == (32, 32)


def test_transparent_pixels_carry_the_edge_color_to_avoid_dark_fringes(client):
    image = png(surface(client, smooth=1))
    clear = image[image[..., 3] == 0][:, :3]
    assert len(clear) and not np.any(np.all(clear == 0, axis=1))


def test_versioned_surface_requests_are_cacheable(client):
    version = client.get('/api/scenarios/demo-standard').json()['updated_at']
    assert 'max-age' in surface(client, smooth=1, version=version).headers.get('cache-control', '')
    assert 'max-age' not in surface(client, smooth=1).headers.get('cache-control', '')
