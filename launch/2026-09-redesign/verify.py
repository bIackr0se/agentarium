"""Check the actual film composition, including intermediate animation frames."""
import json
import unittest

import render
from PIL import Image


def failures(layers):
    if not layers:
        return ['No rendered layers']
    errors = []
    for layer in layers:
        left, top, right, bottom = layer['bounds']
        if not (0 <= left < right <= render.W and 0 <= top < bottom <= render.H):
            errors.append(f"Clipped {layer['label']}: {layer['bounds']}")
    for index, first in enumerate(layers):
        for second in layers[index + 1:]:
            if 'text' not in (first['kind'], second['kind']):
                continue
            a, b = first['bounds'], second['bounds']
            if max(a[0], b[0]) < min(a[2], b[2]) and max(a[1], b[1]) < min(a[3], b[3]):
                errors.append(f"Overlap: {first['label']} / {second['label']}")
    return errors


class CompositionTests(unittest.TestCase):
    def test_export_matches_inputs(self):
        receipt = json.loads((render.OUT / 'export.json').read_text())
        self.assertEqual(receipt, render.export_receipt(), 'Film inputs changed: render and review a new export')
    def test_oracle(self):
        text = {'kind': 'text', 'label': 'caption', 'bounds': (10, 10, 90, 40)}
        panel = {'kind': 'screen', 'label': 'different scene', 'bounds': (90, 10, 180, 80)}
        self.assertEqual(failures([text, panel]), [])  # Touching is not overlap.
        self.assertTrue(failures([text, {**panel, 'bounds': (89, 10, 180, 80)}]))
        self.assertTrue(failures([{**text, 'bounds': (-1, 10, 90, 40)}]))
        self.assertTrue(failures([]))

    def test_reported_caption_collision(self):
        render.frame(4)
        original = [dict(layer) for layer in render.layout]
        for layer in original:
            if layer['kind'] == 'screen':
                layer['bounds'] = (418, 228, 1502, 841)
        self.assertTrue(any('Overlap' in error for error in failures(original)))
        self.assertEqual(failures(render.layout), [])

    def test_opaque_scene_is_rejected(self):
        canvas = Image.new('RGB', (render.W, render.H), render.SEA)
        original = render.scaled_art['village']
        try:
            render.scaled_art['village'] = original.convert('RGB').convert('RGBA')
            with self.assertRaisesRegex(ValueError, 'transparency'):
                render.island(canvas, 'village', 0, 0)
        finally:
            render.scaled_art['village'] = original
        render.island(canvas, 'village', 0, 0)

    def test_every_frame(self):
        destination = render.ROOT / 'output/film-verification'
        destination.mkdir(parents=True, exist_ok=True)
        problems = []
        scenes = {1, 4, 8, 12, 17, 22, 23, 27, 31, 34}
        for index in range(render.FPS * render.DURATION):
            frame = render.frame(index / render.FPS)
            errors = failures(render.layout)
            if errors:
                problems.append({'frame': index, 'errors': errors})
            if index % render.FPS == 0 and index // render.FPS in scenes:
                for width in (480, 960):
                    frame.resize((width, round(width * render.H / render.W))).save(
                        destination / f'scene-{index // render.FPS:02d}-{width}.png')
        (destination / 'geometry.json').write_text(json.dumps({
            'frames': render.FPS * render.DURATION, 'failures': problems,
        }, indent=2) + '\n')
        self.assertEqual(problems, [], str(problems[:5]))


if __name__ == '__main__':
    unittest.main()
