from conftest import upload_raster


def tile_index(level, lon=121.89, lat=17.13):
    """Cesium geographic tiling: 2 x 1 tiles at level 0."""
    return int((lon + 180) / 360 * 2 ** (level + 1)), int((90 - lat) / 180 * 2 ** level)


def test_terrain_tiles_serve_deep_zoom_levels(client):
    """Zooming close to the ground must not turn into terrain errors."""
    dem = upload_raster(client, [[10, 11], [12, 13]], role='terrain').json()
    for level in (19, 22, 24):
        x, y = tile_index(level)
        tile = client.get(f"/api/terrain/{dem['id']}/{level}/{x}/{y}")
        assert tile.status_code == 200, (level, tile.text)
        assert len(tile.json()['heights']) == 65 * 65 and tile.json()['valid_samples'] > 0
    assert client.get(f"/api/terrain/{dem['id']}/25/0/0").status_code == 422
