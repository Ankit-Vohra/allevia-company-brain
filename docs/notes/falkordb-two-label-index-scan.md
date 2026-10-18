# FalkorDB 6.0.2: two range-indexed labels in one pattern return no rows

Found 18 October 2026 while writing the weekly roll-up (src/graph/compact.ts), on a copy of the aamdani brain and then on
a three-node graph (tests/graph/two-label-index.test.ts).

## What happens

Every Allevia node carries `Entity` (range index on `id`), and an Observation also carries `Observation` (range indexes on
`asOf`, `subject`, `metric`, `metricKey`). When one pattern names both labels and the query filters on an indexed property
of each, the server returns **no rows**, with no error:

```
MATCH (o:Entity:Observation {id:'obs:sessions:channel:web:2026-10-01'}) RETURN count(o)                          -- 1
MATCH (o:Entity:Observation {id:'obs:sessions:channel:web:2026-10-01'}) WHERE o.asOf = '2026-10-01' RETURN count(o)  -- 0
MATCH (o:Entity:Observation) WHERE o.id > '' AND o.asOf < '2026-10-04' RETURN count(o)   -- 0 (500 match)
MATCH (o:Entity:Observation) WHERE o.id > '' AND o.value > -1 RETURN count(o)            -- 1682 (value is not indexed)
```

The plan is a single `Node By Index Scan | (o:Observation:Entity)`. The planner seems to fold both filters into one index
scan on one label, which then cannot match the other label's property.

## What the code does about it

- Anchor on one label only:
  - by id with `Entity` alone, and test the type as a label: `MATCH (o:Entity {id:$id}) WHERE o:Observation AND o.asOf = $d`;
  - or by the property with `Observation` alone, paging on the internal id: `MATCH (o:Observation) WHERE id(o) > $after AND o.asOf < $cut`.
- `twoLabelIndexFilters` in tests/helpers/cypher-lint.ts flags the shape, and tests/graph/cypher-sources.test.ts holds every
  query in src/ to it. On 18 October no product query had the shape; only the first draft of the roll-up did.
- tests/graph/two-label-index.test.ts pins the bug. When it fails, the server is fixed and the lint rule can go.

## Not yet done

- Reported upstream? No. It belongs with the reports in falkordb-upstream-report.md.
- Checked on 4.x? No. The live server and the tests run 6.0.2 only.
