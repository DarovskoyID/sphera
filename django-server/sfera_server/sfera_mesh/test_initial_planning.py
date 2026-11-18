from dataclasses import replace
import copy
from hashlib import sha256
import unittest
from .initial_planning import plan_initial_clusters, initial_batch
from .storage import canonical
from .topology import Candidate, choose_cluster


def node(identity, zone, modules=()):
    return Candidate(identity,zone,frozenset(modules),grant_verified=True,grant_expires_at=2000)


class InitialPlanningTests(unittest.TestCase):
    def test_existing_cluster_id_is_skipped_even_after_original_members_leave(self):
        from .placements import cluster_id
        nodes=[node(str(i),str(i)) for i in range(4)]
        old=cluster_id('lab',['0','1','2'])
        plan=plan_initial_clusters(nodes,1,now=1000,network='lab',existing_clusters={old})
        self.assertEqual([[n.node_id for n in group] for group in plan],[['0','1','3']])
        self.assertEqual(plan_initial_clusters(nodes[:3],1,now=1000,network='lab',existing_clusters={old}),())
        with self.assertRaisesRegex(ValueError,'network_required'):
            plan_initial_clusters(nodes,1,now=1000,existing_clusters={old})

    def test_directory_skips_historical_cluster_without_excluding_its_free_nodes(self):
        fixture,_=self.batch_fixture()
        first=fixture.directory.initial_plan(1)['groups'][0]
        from .placements import cluster_id
        old=cluster_id('lab',first)
        fixture.state['placements'][old]={'record':{'body':{'members':['retired-a','retired-b','retired-c'],'epoch':4}}}
        plan=fixture.directory.initial_plan(1)
        self.assertTrue(plan['complete'])
        self.assertNotEqual(plan['groups'][0],first)
        self.assertTrue(set(first)&set(plan['groups'][0]))

    def test_joint_search_finds_two_triples_when_greedy_choice_blocks_second(self):
        nodes=[node('a1','A',['office']),node('a2','A',['office']),node('a3','A',['office']),
               node('b1','B'),node('b2','B',['office']),node('c','C'),node('d','D')]
        greedy=choose_cluster(nodes,now=1000)
        self.assertEqual([n.node_id for n in greedy],['b1','c','d'])
        self.assertEqual(choose_cluster([n for n in nodes if n not in greedy],now=1000),())
        plan=plan_initial_clusters(nodes,2,now=1000)
        self.assertEqual(len(plan),2)
        self.assertEqual(len({n.node_id for group in plan for n in group}),6)
        self.assertTrue(all(len({n.failure_domain for n in group})==3 for group in plan))
        self.assertEqual(plan_initial_clusters(reversed(nodes),2,now=1000),plan)

    def test_module_similarity_optimized_jointly_with_canonical_ties(self):
        nodes=[node(str(i),str(i),['office'] if i<3 else ['planner']) for i in range(7)]
        plan=plan_initial_clusters(nodes,2,now=1000)
        self.assertEqual([[n.node_id for n in group] for group in plan],[['0','1','2'],['3','4','5']])
        self.assertEqual(plan_initial_clusters(nodes,1,now=1000)[0],choose_cluster(nodes,now=1000))

    def test_expired_unverified_assigned_and_unfit_nodes_are_not_initial_spares(self):
        base=[node(str(i),str(i)) for i in range(6)]
        for changed in (replace(base[0],grant_expires_at=1000),replace(base[0],grant_expires_at=None),
                        replace(base[0],grant_verified=False),replace(base[0],capacity_ok=False),
                        replace(base[0],memberships=frozenset({'existing'}))):
            self.assertEqual(plan_initial_clusters([changed,*base[1:]],2,now=1000),())

    def test_search_exhaustion_never_returns_a_partial_plan(self):
        nodes=[node(str(i),str(i)) for i in range(6)]
        with self.assertRaisesRegex(ValueError,'search_budget_exceeded'):
            plan_initial_clusters(nodes,2,now=1000,max_states=2)
        with self.assertRaisesRegex(ValueError,'duplicate'):
            plan_initial_clusters([*nodes,nodes[0]],1,now=1000)
        with self.assertRaisesRegex(ValueError,'laboratory_limit'):
            plan_initial_clusters([node(str(i),str(i)) for i in range(65)],1,now=1000)

    def test_sixty_four_candidates_use_high_bits_without_changing_exact_ties(self):
        nodes=[node(f'{i:02}', 'a' if i<60 else 'b' if i<62 else 'c') for i in range(64)]
        plan=plan_initial_clusters(nodes,2,now=1000)
        self.assertEqual([[n.node_id for n in group] for group in plan],[['00','60','62'],['01','61','63']])
        self.assertEqual(plan_initial_clusters(reversed(nodes),2,now=1000),plan)
        self.assertEqual([[n.node_id for n in group] for group in plan_initial_clusters(nodes,1,now=1000)],[['00','60','62']])

    def test_four_primary_triples_do_not_consume_the_same_node_twice(self):
        nodes=[node(f'{i:02}',f'zone-{i}') for i in range(12)]
        plan=plan_initial_clusters(nodes,4,now=1000)
        self.assertEqual(len(plan),4)
        self.assertEqual(len({n.node_id for group in plan for n in group}),12)

    def test_directory_binds_plan_to_verified_candidate_and_resource_heads(self):
        from . import test_replacement
        fixture=test_replacement.ReplacementTests(); fixture.setUp()
        self.addCleanup(fixture.doCleanups)
        fixture.state['placements'].clear()
        for identity, head in fixture.state['resources'].items():
            head['record']['body']['capacity_slots']=2
            head['digest']=identity
        plan=fixture.directory.initial_plan(1)
        self.assertEqual(len(plan['groups']),1)
        for identity in plan['groups'][0]:
            self.assertEqual(plan['candidates'][identity],fixture.state['candidates'][identity]['digest'])
            self.assertEqual(plan['resources'][identity],identity)
        self.assertEqual(fixture.state['placements'],{})

    def batch_fixture(self):
        from . import test_replacement
        fixture=test_replacement.ReplacementTests(); fixture.setUp()
        self.addCleanup(fixture.doCleanups)
        record=copy.deepcopy(fixture.state['placements'][fixture.cluster]['record'])
        fixture.state['placements'].clear()
        for identity, head in fixture.state['resources'].items():
            head['record']['body']['capacity_slots']=2
            head['digest']=identity
        return fixture,record

    def test_batch_binds_exact_signed_placements_and_requires_complete_plan(self):
        fixture,record=self.batch_fixture()
        plan=fixture.directory.initial_plan(1)
        batch=initial_batch(plan,[record])
        self.assertEqual(batch['body']['placements_hash'],sha256(canonical([record])).hexdigest())
        self.assertEqual(batch['body']['pool_hash'],plan['pool_hash'])
        with self.assertRaises(ValueError): initial_batch({**plan,'complete':False},[record])
        with self.assertRaises(ValueError): initial_batch(plan,[])
        changed={**plan,'groups':list(reversed(plan['groups'][0]))}
        with self.assertRaises(ValueError): initial_batch(changed,[record])

    def test_pool_hash_includes_unselected_free_candidates(self):
        fixture,_=self.batch_fixture()
        before=fixture.directory.initial_plan(1)
        unused=next(identity for identity in fixture.fixture.ids if identity not in before['groups'][0])
        fixture.state['resources'][unused]['digest']='f'*64
        after=fixture.directory.initial_plan(1)
        self.assertEqual(before['groups'],after['groups'])
        self.assertEqual(before['resources'],after['resources'])
        self.assertNotEqual(before['pool_hash'],after['pool_hash'])

    def test_batch_receipt_verified_from_historical_placements(self):
        from .placements import validate_history
        fixture,record=self.batch_fixture()
        plan=fixture.directory.initial_plan(1); batch=initial_batch(plan,[record])
        cluster=record['body']['cluster']; at=fixture.state['block_time']
        head={'record':record,'digest':sha256(canonical(record)).hexdigest(),'accepted_at':at}
        fixture.state.update(placements={cluster:head},placement_history={cluster:[head]},
                             placement_assessors=fixture.directory.placement_assessors,block_time=at+1000)
        receipt={'body':copy.deepcopy(batch['body']),'clusters':[cluster],'accepted_at':at}
        fixture.state['initial_batches']={sha256(canonical(batch)).hexdigest():receipt}
        validate_history(fixture.state,'lab',trusted_issuers=fixture.fixture.trusted)
        receipt['body']['pool_hash']='0'*64
        with self.assertRaisesRegex(ValueError,'receipt_hash_mismatch'):
            validate_history(fixture.state,'lab',trusted_issuers=fixture.fixture.trusted)
