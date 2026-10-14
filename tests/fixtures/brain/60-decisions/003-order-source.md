# 003 — Track where orders come from ourselves; no paid tool yet
**Date** 2026-10-04 · **Status** accepted (M2)

**Context.** We cannot tell which post or ad brought an order. Small budget: no paid tool unless the free route fails.

**Decision.** Save the campaign tags on the first visit, keep the first source per customer, and send
sales back to the ad platforms from the server. Look at a paid tool once the app brings enough orders.

**Consequences.** Ads learn from orders, not clicks; the cookie banner comes first.
