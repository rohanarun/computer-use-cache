import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
tmp = tempfile.TemporaryDirectory()
os.environ['CACHE_DB_PATH'] = str(Path(tmp.name) / 'cache.sqlite3')
import server


class JevIntegration(unittest.TestCase):
    def test_reuse_and_isolation(self):
        client = server.app.test_client()
        generated = Mock(status_code=200)
        generated.json.return_value = {'choices': [{'message': {'content': 'cached result'}}]}
        judged = Mock()
        judged.json.return_value = {'answers': {'reuse': {'type': 'choice', 'choice': 'candidate_0', 'confidence': 1}}}
        def ask(text, key='key-one', **extra):
            return client.post('/v1/chat/completions', json={
                'model': 'test', 'messages': [{'role': 'user', 'content': text}], **extra
            }, headers={'Authorization': f'Bearer {key}'})
        with patch.object(server, 'TYPESAFE_API_KEY', 'judge-key'), patch.object(server, 'UPSTREAM_API_KEY', ''), \
                patch.object(server, 'upstream_json_response', return_value=generated) as generation, \
                patch.object(server.requests, 'post', return_value=judged) as judge:
            self.assertEqual(ask('first').headers['X-Code-Model-Cache'], 'MISS')
            self.assertEqual(ask('first').headers['X-Computer-Use-Cache-Match'], 'exact')
            judge.assert_not_called()
            self.assertEqual(ask('paraphrase').headers['X-Computer-Use-Cache-Match'], 'jev')
            self.assertEqual(generation.call_count, 1)
            call = judge.call_args.kwargs
            self.assertEqual(call['headers']['Authorization'], 'Bearer judge-key')
            self.assertEqual(call['json']['model'], 'jev-latest')
            self.assertIn('none', call['json']['questions']['reuse']['criteria'])
            before = judge.call_count
            self.assertEqual(ask('other user', key='key-two').headers['X-Code-Model-Cache'], 'MISS')
            self.assertEqual(ask('bypass', cache=False).headers['X-Code-Model-Cache'], 'BYPASS')
            self.assertEqual(judge.call_count, before)
            for i, answer in enumerate([
                {'type': 'choice', 'choice': 'none', 'confidence': 1},
                {'type': 'choice', 'choice': 'candidate_0', 'confidence': 0.1},
                {'type': 'choice', 'choice': 'candidate_999', 'confidence': 1},
                {'type': 'choice', 'choice': 'candidate_0', 'confidence': '1'},
            ]):
                judged.json.return_value = {'answers': {'reuse': answer}}
                self.assertEqual(ask(f'reject {i}').headers['X-Code-Model-Cache'], 'MISS')
            judge.side_effect = server.requests.Timeout()
            self.assertEqual(ask('timeout').headers['X-Code-Model-Cache'], 'MISS')

    def test_no_key_or_oversize_skips_judge(self):
        with patch.object(server.requests, 'post') as judge:
            with patch.object(server, 'TYPESAFE_API_KEY', ''):
                self.assertIsNone(server.select_reusable_entry({}, [{}]))
            with patch.object(server, 'TYPESAFE_API_KEY', 'key'), patch.object(server, 'JEV_MAX_INPUT_CHARS', 1):
                self.assertIsNone(server.select_reusable_entry({}, [{'request': {}, 'response': {}}]))
            judge.assert_not_called()


if __name__ == '__main__':
    try:
        unittest.main()
    finally:
        tmp.cleanup()
