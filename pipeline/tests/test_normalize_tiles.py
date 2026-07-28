import importlib.util
from pathlib import Path
import tempfile
import unittest


MODULE_PATH = Path(__file__).parents[1] / 'scripts' / 'normalize_tiles.py'
SPEC = importlib.util.spec_from_file_location('normalize_tiles', MODULE_PATH)
NORMALIZER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(NORMALIZER)


class PublishStagingTests(unittest.TestCase):
    def test_replaces_existing_output_without_partial_contents(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            output = root / 'map'
            staging = root / '.map.tmp'
            output.mkdir()
            staging.mkdir()
            (output / 'old.txt').write_text('old', encoding='utf-8')
            (staging / 'new.txt').write_text('new', encoding='utf-8')

            NORMALIZER.publish_staging(staging, output)

            self.assertFalse((output / 'old.txt').exists())
            self.assertEqual((output / 'new.txt').read_text(encoding='utf-8'), 'new')
            self.assertFalse(staging.exists())

    def test_rejects_overlapping_source_and_output(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / 'render'
            source.mkdir()
            with self.assertRaises(SystemExit):
                NORMALIZER.validate_paths(source, source / 'published')


if __name__ == '__main__':
    unittest.main()
