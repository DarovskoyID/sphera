import copy
import unittest
from .membership_origins import borrowed_memberships


def entry(cluster, epoch, members, at):
    return {'record': {'body': {'cluster': cluster, 'epoch': epoch, 'members': members}},
            'digest': f'{cluster}-{epoch}', 'accepted_at': at}


class MembershipOriginTests(unittest.TestCase):
    def setUp(self):
        a = [entry('a', 1, ['node', 'a1', 'a2'], 10)]
        b = [entry('b', 1, ['b0', 'b1', 'b2'], 11),
             entry('b', 2, ['node', 'b1', 'b2'], 20)]
        self.state = {'placements': {'a': a[-1], 'b': b[-1]},
                      'placement_history': {'a': a, 'b': b}}

    def test_order_independent_and_bound_to_entry_records(self):
        expected = [{'node_id': 'node', 'home_cluster': 'a', 'borrowed_cluster': 'b',
                     'home_entry_hash': 'a-1', 'borrowed_entry_hash': 'b-2'}]
        self.assertEqual(borrowed_memberships(self.state), expected)
        self.state['placements'] = dict(reversed(list(self.state['placements'].items())))
        self.assertEqual(borrowed_memberships(self.state), expected)

    def test_ambiguous_or_legacy_time_does_not_authorize_return(self):
        for timestamp in (10, 0, None, True):
            state = copy.deepcopy(self.state)
            state['placement_history']['b'][-1]['accepted_at'] = timestamp
            self.assertEqual(borrowed_memberships(state), [])

    def test_second_initial_allocation_is_not_a_loan(self):
        self.state['placement_history']['b'] = [entry('b', 1, ['node', 'b1', 'b2'], 20)]
        self.state['placements']['b'] = self.state['placement_history']['b'][-1]
        self.assertEqual(borrowed_memberships(self.state), [])

    def test_leave_and_rejoin_resets_origin_and_removal_ends_loan(self):
        history = self.state['placement_history']['a']
        history.extend([entry('a', 2, ['a0', 'a1', 'a2'], 30),
                        entry('a', 3, ['node', 'a1', 'a2'], 40)])
        self.state['placements']['a'] = history[-1]
        result = borrowed_memberships(self.state)
        self.assertEqual(result[0]['home_cluster'], 'b')
        self.assertEqual(result[0]['borrowed_entry_hash'], 'a-3')
        history.append(entry('a', 4, ['a0', 'a1', 'a2'], 50))
        self.state['placements']['a'] = history[-1]
        self.assertEqual(borrowed_memberships(self.state), [])

    def test_missing_history_is_rejected(self):
        del self.state['placement_history']['b']
        with self.assertRaises(ValueError):
            borrowed_memberships(self.state)
