# Product-history EXPLAIN on isolated test data

Production query, default planner settings, after ANALYZE. Fixture: 12,000 direct events, 1,200 small bulk events and a 5,000-product bulk event.

```text
Limit (actual time=6.394..6.501 rows=3.00 loops=1)
  Buffers: shared hit=352
  ->  Sort (actual time=6.381..6.469 rows=3.00 loops=1)
        Sort Key: "*SELECT* 1".created_at DESC, "*SELECT* 1".id DESC
        Sort Method: quicksort  Memory: 17kB
        Buffers: shared hit=352
        ->  Hash Left Join (actual time=0.224..6.421 rows=3.00 loops=1)
              Hash Cond: (("*SELECT* 1".tenant_id = u.tenant_id) AND ("*SELECT* 1".actor_id = u.id))
              Buffers: shared hit=352
              ->  Append (actual time=0.112..6.244 rows=3.00 loops=1)
                    Buffers: shared hit=351
                    ->  Subquery Scan on "*SELECT* 1" (actual time=0.104..0.131 rows=1.00 loops=1)
                          Buffers: shared hit=3
                          ->  Limit (actual time=0.095..0.112 rows=1.00 loops=1)
                                Buffers: shared hit=3
                                ->  Index Scan using audit_events_tenant_entity_time_idx on audit_events e (actual time=0.084..0.090 rows=1.00 loops=1)
                                      Index Cond: ((tenant_id = '7f5c5a6f-c265-4269-9b53-10e964c57a24'::uuid) AND (entity_id = 'b0497369-ae43-42ce-8d3d-60236e2d790f'::uuid))
                                      Filter: (action ~~ 'product.%'::text)
                                      Index Searches: 1
                                      Buffers: shared hit=3
                    ->  Subquery Scan on "*SELECT* 2" (actual time=3.459..3.496 rows=1.00 loops=1)
                          Buffers: shared hit=55
                          ->  Limit (actual time=3.452..3.478 rows=1.00 loops=1)
                                Buffers: shared hit=55
                                ->  Sort (actual time=3.446..3.461 rows=1.00 loops=1)
                                      Sort Key: e_1.created_at DESC, e_1.id DESC
                                      Sort Method: quicksort  Memory: 17kB
                                      Buffers: shared hit=55
                                      ->  Bitmap Heap Scan on audit_events e_1 (actual time=3.407..3.422 rows=1.00 loops=1)
                                            Recheck Cond: (((details -> 'changes'::text) @> '[["b0497369-ae43-42ce-8d3d-60236e2d790f"]]'::jsonb) AND (action = 'pricing.bulk_applied'::text))
                                            Filter: (tenant_id = '7f5c5a6f-c265-4269-9b53-10e964c57a24'::uuid)
                                            Heap Blocks: exact=1
                                            Buffers: shared hit=55
                                            ->  Bitmap Index Scan on audit_events_bulk_changes_gin_idx (actual time=1.884..1.887 rows=1.00 loops=1)
                                                  Index Cond: ((details -> 'changes'::text) @> '[["b0497369-ae43-42ce-8d3d-60236e2d790f"]]'::jsonb)
                                                  Index Searches: 1
                                                  Buffers: shared hit=27
                    ->  Subquery Scan on "*SELECT* 3" (actual time=2.544..2.573 rows=1.00 loops=1)
                          Buffers: shared hit=293
                          ->  Limit (actual time=2.536..2.556 rows=1.00 loops=1)
                                Buffers: shared hit=293
                                ->  Sort (actual time=2.528..2.538 rows=1.00 loops=1)
                                      Sort Key: e_2.created_at DESC, e_2.id DESC
                                      Sort Method: quicksort  Memory: 17kB
                                      Buffers: shared hit=293
                                      ->  Seq Scan on audit_events e_2 (actual time=0.034..2.501 rows=1.00 loops=1)
                                            Filter: ((action ~~ 'upload.%'::text) AND (tenant_id = '7f5c5a6f-c265-4269-9b53-10e964c57a24'::uuid))
                                            Rows Removed by Filter: 13220
                                            Buffers: shared hit=293
              ->  Hash (actual time=0.054..0.062 rows=3.00 loops=1)
                    Buckets: 1024  Batches: 1  Memory Usage: 5kB
                    Buffers: shared hit=1
                    ->  Seq Scan on users u (actual time=0.024..0.035 rows=3.00 loops=1)
                          Buffers: shared hit=1
Planning:
  Buffers: shared hit=65
Planning Time: 1.954 ms
Execution Time: 6.911 ms
```

Measured test GIN size: **221184 bytes**.

This proves indexed lookup on this synthetic fixture. It does not establish production PostgreSQL timings or disk requirements. No demo data was used.
