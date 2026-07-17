// Real PostgreSQL integration suite. It never migrates a database: provision a
// disposable database with 0001-0011 already applied and set PG_INTEGRATION_URL.
import assert from "node:assert";
import { Client } from "pg";

const url = process.env.PG_INTEGRATION_URL;
if (!url) {
  console.log("slip-postgres integration skipped: PG_INTEGRATION_URL is unset");
  process.exit(0);
}

const db = new Client({ connectionString: url });
await db.connect();
const extraClients: Client[] = [];
const ids = { slots: [] as string[], bookings: [] as string[], orders: [] as string[] };

async function client(): Promise<Client> {
  const c = new Client({ connectionString: url });
  await c.connect();
  extraClients.push(c);
  return c;
}

try {
  const database = String((await db.query("select current_database() as name")).rows[0]?.name ?? "");
  assert.match(database, /(^|[_-])(test|ci)([_-]|$)/i,
    "PG_INTEGRATION_URL must target a disposable test database");
  const objects = await db.query(`select
    to_regprocedure('public.confirm_slip_payment(uuid,text,text,timestamp with time zone,integer,text,text,jsonb)') as confirm_fn,
    to_regprocedure('public.approve_manual_review_payment(uuid)') as approve_fn,
    to_regprocedure('public.create_slip_payment_order(uuid,text,integer,text)') as order_fn`);
  assert.ok(objects.rows[0].confirm_fn && objects.rows[0].approve_fn && objects.rows[0].order_fn,
    "test DB must have the current 0011 already applied");

  await db.query("drop trigger if exists mohjaew_test_claim_overlap on public.payment_transactions");
  await db.query("drop function if exists public.mohjaew_test_claim_overlap()");
  await db.query("alter table public.notification_deliveries drop constraint if exists mohjaew_test_force_outbox_failure");
  const fixtureBookings = "select b.id from public.bookings b join public.booking_slots s on s.id=b.slot_id where s.label='PG integration'";
  await db.query(`delete from public.notification_deliveries where booking_id in (${fixtureBookings})`);
  await db.query(`delete from public.payment_slip_verifications where booking_id in (${fixtureBookings})`);
  await db.query(`delete from public.payment_transactions where booking_id in (${fixtureBookings})`);
  await db.query(`delete from public.payment_orders where booking_id in (${fixtureBookings})`);
  await db.query(`delete from public.bookings where id in (${fixtureBookings})`);
  await db.query("delete from public.booking_slots where label='PG integration'");

  async function booking() {
    const slot = await db.query(`insert into public.booking_slots(booking_date,start_time,end_time,label,capacity,is_open)
      values (current_date + 400 + $1::int, '09:00', '10:00', 'PG integration', 10, true) returning id`,
    [ids.slots.length]);
    const slotId = slot.rows[0].id as string;
    ids.slots.push(slotId);
    const row = await db.query(`insert into public.bookings(slot_id,source,nickname,phone,consultation_topic,birth_date_text,preferred_time,status,queue_number,hold_expires_at)
      values ($1,'website','pg-test','0800000000','integration','2000-01-01','PG integration','pending_payment',1,now() + interval '30 minutes') returning id`,
    [slotId]);
    const id = row.rows[0].id as string;
    ids.bookings.push(id);
    return id;
  }

  async function order(bookingId: string, suffix: string) {
    const result = await db.query(
      "select (public.create_slip_payment_order($1,$2,99900,'profile-test')).id as id",
      [bookingId, `pg:${suffix}`],
    );
    const id = result.rows[0].id as string;
    ids.orders.push(id);
    return id;
  }

  async function confirmWith(
    c: Client,
    orderId: string,
    ref: string,
    opts: { at?: Date; amount?: number; currency?: string; profile?: string | null } = {},
  ) {
    return (await c.query(
      `select public.confirm_slip_payment($1,'promptpay_slip',$2,coalesce($3::timestamptz,now()),$4,$5,$6,'{}'::jsonb) as result`,
      [orderId, ref, opts.at?.toISOString() ?? null, opts.amount ?? 99900,
        opts.currency ?? "THB", opts.profile === undefined ? "profile-test" : opts.profile],
    )).rows[0].result;
  }

  const first = await order(await booking(), "one");
  assert.equal((await confirmWith(db, first, "REF one")).result, "ok");
  assert.equal((await confirmWith(db, first, "REF one")).result, "already_paid");
  const replay = await order(await booking(), "two");
  assert.deepEqual(await confirmWith(db, replay, "REF one"),
    { result: "rejected", reason: "duplicate_tx" });

  const late = await order(await booking(), "late");
  const lateResult = await confirmWith(db, late, "REF late", { at: new Date(Date.now() - 60_000) });
  assert.equal(lateResult.result, "manual_review");
  assert.equal(lateResult.reason, "timestamp_out_of_window");
  assert.equal((await db.query(
    "select resolution from public.payment_transactions where payment_order_id=$1", [late],
  )).rows[0].resolution, "manual_review");

  const currencyOrder = await order(await booking(), "currency");
  const currencyResult = await confirmWith(db, currencyOrder, "REF currency", { currency: "USD" });
  assert.deepEqual(currencyResult, { result: "manual_review", reason: "currency_mismatch" });

  // Controlled real concurrency: distinct backend sessions wait behind one
  // exclusive advisory lock, acquire compatible shared locks together, then
  // enter a test-only 300ms BEFORE INSERT delay at the same time.
  await db.query(`create or replace function public.mohjaew_test_claim_overlap()
    returns trigger language plpgsql as $$ begin
      if new.normalized_tx_ref = 'REFCONCURRENT' then perform pg_sleep(0.3); end if;
      return new; end $$`);
  await db.query(`create trigger mohjaew_test_claim_overlap before insert on public.payment_transactions
    for each row execute function public.mohjaew_test_claim_overlap()`);
  const concurrentA = await order(await booking(), "concurrent-a");
  const concurrentB = await order(await booking(), "concurrent-b");
  const coordinator = await client();
  const workerA = await client();
  const workerB = await client();
  const coordinatorPid = Number((await coordinator.query("select pg_backend_pid() pid")).rows[0].pid);
  const workerAPid = Number((await workerA.query("select pg_backend_pid() pid")).rows[0].pid);
  const workerBPid = Number((await workerB.query("select pg_backend_pid() pid")).rows[0].pid);
  assert.equal(new Set([coordinatorPid, workerAPid, workerBPid]).size, 3);
  const barrierKey = 1_107_004;
  await coordinator.query("select pg_advisory_lock($1)", [barrierKey]);
  const gateA = workerA.query("select pg_advisory_lock_shared($1)", [barrierKey]);
  const gateB = workerB.query("select pg_advisory_lock_shared($1)", [barrierKey]);
  await new Promise((resolve) => setTimeout(resolve, 100));
  const waiters = await db.query(`select count(*)::int n from pg_stat_activity
    where pid = any($1::int[]) and wait_event_type = 'Lock' and wait_event = 'advisory'`,
  [[workerAPid, workerBPid]]);
  assert.equal(waiters.rows[0].n, 2, "both independent backends reached the start barrier");
  await coordinator.query("select pg_advisory_unlock($1)", [barrierKey]);
  await Promise.all([gateA, gateB]);
  const started = Date.now();
  const [a, b] = await Promise.all([
    confirmWith(workerA, concurrentA, "REF concurrent"),
    confirmWith(workerB, concurrentB, "REF concurrent"),
  ]);
  const elapsed = Date.now() - started;
  await workerA.query("select pg_advisory_unlock_shared($1)", [barrierKey]);
  await workerB.query("select pg_advisory_unlock_shared($1)", [barrierKey]);
  assert.ok(elapsed < 575, `claims did not overlap (elapsed ${elapsed}ms)`);
  assert.deepEqual(new Set([a.result, b.result]), new Set(["ok", "rejected"]));
  assert.equal((await db.query(
    "select count(*)::int n from public.payment_transactions where normalized_tx_ref='REFCONCURRENT'",
  )).rows[0].n, 1);
  await db.query("drop trigger mohjaew_test_claim_overlap on public.payment_transactions");
  await db.query("drop function public.mohjaew_test_claim_overlap()");

  // manual_review -> approval, then automatic replay against another booking.
  const manualBooking = await booking();
  const manualOrder = await order(manualBooking, "manual-approve");
  assert.equal((await confirmWith(db, manualOrder, "REF manual approve", { profile: null })).result,
    "manual_review");
  assert.equal((await db.query(
    "select public.approve_manual_review_payment($1) result", [manualBooking],
  )).rows[0].result.result, "ok");
  const manualReplay = await order(await booking(), "manual-replay");
  assert.deepEqual(await confirmWith(db, manualReplay, "REF manual approve"),
    { result: "rejected", reason: "duplicate_tx" });

  // Automatic replay and manual approval race on the same claim. Both calls
  // use distinct PostgreSQL connections and converge on one confirmed claim.
  const raceBooking = await booking();
  const raceOrder = await order(raceBooking, "manual-race");
  assert.equal((await confirmWith(db, raceOrder, "REF manual-race", { profile: null })).result,
    "manual_review");
  const autoClient = await client();
  const manualClient = await client();
  const [auto, manual] = await Promise.all([
    confirmWith(autoClient, raceOrder, "REF manual-race"),
    manualClient.query("select public.approve_manual_review_payment($1) result", [raceBooking]),
  ]);
  assert.ok(auto.result === "manual_review" || auto.result === "already_paid");
  assert.ok(["ok", "already_paid"].includes(manual.rows[0].result.result));
  assert.equal((await db.query("select status from public.bookings where id=$1", [raceBooking])).rows[0].status,
    "confirmed");
  assert.equal((await db.query(
    "select count(*)::int n from public.payment_transactions where normalized_tx_ref='REFMANUAL-RACE' and resolution='confirmed'",
  )).rows[0].n, 1);

  const expiredOrder = await order(await booking(), "expired-order");
  await db.query("update public.payment_orders set expires_at=now()-interval '1 second' where id=$1", [expiredOrder]);
  assert.equal((await confirmWith(db, expiredOrder, "REF expired-order")).result, "manual_review");
  const expiredHoldBooking = await booking();
  const expiredHold = await order(expiredHoldBooking, "expired-hold");
  await db.query("update public.bookings set hold_expires_at=now()-interval '1 second' where id=(select booking_id from public.payment_orders where id=$1)", [expiredHold]);
  assert.equal((await confirmWith(db, expiredHold, "REF expired-hold")).result, "manual_review");
  await assert.rejects(
    () => db.query("select public.approve_manual_review_payment($1) result", [expiredHoldBooking]),
    /hold_expired/,
    "an expired manual-review hold must never be approved",
  );
  assert.equal((await db.query("select status from public.bookings where id=$1", [expiredHoldBooking])).rows[0].status, "pending_payment");
  assert.equal((await db.query(
    "select count(*)::int n from public.notification_deliveries where booking_id=$1 and event_type='booking_confirmed'",
    [expiredHoldBooking],
  )).rows[0].n, 0);

  // Approval that starts while the hold is live but waits behind the booking
  // lock must re-read wall-clock expiry after acquiring that lock.
  const expiryRaceBooking = await booking();
  const expiryRaceOrder = await order(expiryRaceBooking, "expiry-race");
  assert.equal((await confirmWith(db, expiryRaceOrder, "REF expiry-race", { profile: null })).result, "manual_review");
  await db.query("update public.bookings set hold_expires_at=clock_timestamp()+interval '600 milliseconds' where id=$1", [expiryRaceBooking]);
  const expiryBlocker = await client();
  const expiryApprover = await client();
  await expiryBlocker.query("begin");
  await expiryBlocker.query("select id from public.bookings where id=$1 for update", [expiryRaceBooking]);
  const approvalOutcome = expiryApprover
    .query("select public.approve_manual_review_payment($1) result", [expiryRaceBooking])
    .then((result) => ({ result, error: null as unknown }), (error: unknown) => ({ result: null, error }));
  await new Promise((resolve) => setTimeout(resolve, 800));
  await expiryBlocker.query("commit");
  const raced = await approvalOutcome;
  assert.match(String((raced.error as Error | null)?.message ?? ""), /hold_expired/);
  assert.equal(raced.result, null);
  assert.equal((await db.query("select status from public.bookings where id=$1", [expiryRaceBooking])).rows[0].status, "pending_payment");

  // Even a still-live hold cannot be approved if every slot seat is already
  // occupied by another booking. The slot lock makes this check atomic with
  // create_booking and other transitions.
  const fullSlotBooking = await booking();
  const fullSlotOrder = await order(fullSlotBooking, "manual-full-slot");
  assert.equal((await confirmWith(db, fullSlotOrder, "REF manual-full-slot", { profile: null })).result, "manual_review");
  const fullSlotId = (await db.query("select slot_id from public.bookings where id=$1", [fullSlotBooking])).rows[0].slot_id as string;
  await db.query("update public.booking_slots set capacity=1 where id=$1", [fullSlotId]);
  const occupant = (await db.query(`insert into public.bookings(
      slot_id,source,nickname,phone,consultation_topic,birth_date_text,
      preferred_time,status,queue_number,hold_expires_at
    ) values ($1,'website','slot-occupant','0800000009','integration','2000-01-01',
      'PG integration','confirmed',2,null) returning id`, [fullSlotId])).rows[0].id as string;
  ids.bookings.push(occupant);
  await assert.rejects(
    () => db.query("select public.approve_manual_review_payment($1) result", [fullSlotBooking]),
    /slot_full/,
  );
  assert.equal((await db.query("select status from public.bookings where id=$1", [fullSlotBooking])).rows[0].status, "pending_payment");
  assert.equal((await db.query(
    "select count(*)::int n from public.notification_deliveries where booking_id=$1 and event_type='booking_confirmed'",
    [fullSlotBooking],
  )).rows[0].n, 0);

  // service_role itself cannot mutate immutable payment-order trust fields.
  const immutableBooking = await booking();
  const immutableOrder = await order(immutableBooking, "immutable");
  const otherBooking = await booking();
  const service = await client();
  await service.query("set role service_role");
  for (const [sql, value] of [
    ["update public.payment_orders set provider=$1 where id=$2", "other-provider"],
    ["update public.payment_orders set currency=$1 where id=$2", "USD"],
    ["update public.payment_orders set amount_satang=$1 where id=$2", 100],
    ["update public.payment_orders set receiver_profile=$1 where id=$2", "other-profile"],
    ["update public.payment_orders set booking_id=$1 where id=$2", otherBooking],
  ] as const) {
    await assert.rejects(() => service.query(sql, [value, immutableOrder]),
      /payment_order_trust_fields_immutable/);
  }
  await service.query("reset role");

  const rollbackOrder = await order(await booking(), "rollback");
  await db.query("alter table public.notification_deliveries add constraint mohjaew_test_force_outbox_failure check (event_type <> 'payment_received') not valid");
  await assert.rejects(() => confirmWith(db, rollbackOrder, "REF rollback"));
  await db.query("alter table public.notification_deliveries drop constraint mohjaew_test_force_outbox_failure");
  assert.equal((await db.query(
    "select count(*)::int n from public.payment_transactions where payment_order_id=$1", [rollbackOrder],
  )).rows[0].n, 0);
  assert.equal((await db.query("select status from public.payment_orders where id=$1", [rollbackOrder])).rows[0].status,
    "created");

  await db.query("set role authenticated");
  await assert.rejects(() => db.query(
    "select public.confirm_slip_payment(gen_random_uuid(),'promptpay_slip','x',now(),1,'THB','profile-test','{}'::jsonb)",
  ));
  await assert.rejects(() => db.query("select public.approve_manual_review_payment(gen_random_uuid())"));
  await db.query("reset role");
  console.log(`slip-postgres integration passed; controlled concurrency ${elapsed}ms; backends ${workerAPid}/${workerBPid}`);
} finally {
  if (extraClients[0]) {
    try { await extraClients[0].query("select pg_advisory_unlock_all()"); } catch { /* disconnected */ }
  }
  for (const c of extraClients) {
    try { await c.query("rollback"); } catch { /* already closed/idle */ }
  }
  try { await db.query("drop trigger if exists mohjaew_test_claim_overlap on public.payment_transactions"); } catch { /* absent */ }
  try { await db.query("drop function if exists public.mohjaew_test_claim_overlap()"); } catch { /* absent */ }
  try { await db.query("alter table public.notification_deliveries drop constraint if exists mohjaew_test_force_outbox_failure"); } catch { /* absent */ }
  if (ids.orders.length) await db.query("delete from public.notification_deliveries where payment_order_id=any($1::uuid[])", [ids.orders]);
  if (ids.orders.length) await db.query("delete from public.payment_slip_verifications where payment_order_id=any($1::uuid[])", [ids.orders]);
  if (ids.orders.length) await db.query("delete from public.payment_transactions where payment_order_id=any($1::uuid[])", [ids.orders]);
  if (ids.orders.length) await db.query("delete from public.payment_orders where id=any($1::uuid[])", [ids.orders]);
  if (ids.bookings.length) await db.query("delete from public.bookings where id=any($1::uuid[])", [ids.bookings]);
  if (ids.slots.length) await db.query("delete from public.booking_slots where id=any($1::uuid[])", [ids.slots]);
  for (const c of extraClients) await c.end().catch(() => undefined);
  await db.end();
}
