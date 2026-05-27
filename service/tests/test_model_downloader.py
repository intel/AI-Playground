import os
import sys
import unittest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

import utils


class TestHFChunkHttpOk(unittest.TestCase):
    def test_fresh_expect_200_only(self):
        self.assertTrue(utils.hf_chunk_http_ok(200, 0))
        self.assertFalse(utils.hf_chunk_http_ok(206, 0))

    def test_resume_accepts_200_and_206(self):
        self.assertTrue(utils.hf_chunk_http_ok(200, 1))
        self.assertTrue(utils.hf_chunk_http_ok(206, 1))
        self.assertFalse(utils.hf_chunk_http_ok(404, 1))


if __name__ == "__main__":
    unittest.main()
