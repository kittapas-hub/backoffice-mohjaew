// Real PostgreSQL integration suite for 0012_booking_confirmed_notification.sql.
// It never migrates a database: provision a disposable database with
// 0001-0012 already applied and set PG_INTEGRATION_URL. Skips cleanly
// (exit 0) when unset — same convention as
// src/lib/payments/slip/slip-postgres.integration.test.ts.
//
// Scope: DB-level behaviour only (enqueue-on-confirm, dedup, race
// serialization, payload shape, recipient_type). Actual LINE delivery
// (correct group id used, text+image, missing-image-text-only, retry on
// LINE failure, fail-closed on missing config) is TS/worker-layer and is
// covered by src/lib/notifications/delivery-worker.test.ts and
// src/lib/line.test.ts, which run under plain `npm test` without a database.
import assert from "node:assert";
import { Client } from "pg";

const url = process.env.PG_INTEGRATION_URL;
if (!url) {
  console.log("booking-confirmed-notification integration skipped: PG_INTEGRATION_URL is unset");
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
    to_regprocedure('public.transition_slot_booking(uuid,text)') as transition_fn,
    to_regprocedure('public.confirm_slip_payment(uuid,text,text,timestamp with time zone,integer,text,text,jsonb)') as confirm_fn,
    to_regprocedure('public.approve_manual_review_payment(uuid)') as approve_fn`);
  assert.ok(
    objects.rows[0].transition_fn && objects.rows[0].confirm_fn && objects.rows[0].approve_fn,
    "test DB must have 0001-0012 already applied",
  );

  const fixtureBookings =
    "select b.id from public.bookings b join public.booking_slots s on s.id=b.slot_id where s.label='PG integration booking_confirmed'";
  await db.query(`delete from public.notification_deliveries where booking_id in (${fixtureBookings})`);
  await db.query(`delete from public.payment_slip_verifications where booking_id in (${fixtureBookings})`);
  await db.query(`delete from public.payment_transactions where booking_id in (${fixtureBookings})`);
  await db.query(`delete from public.payment_orders where booking_id in (${fixtureBookings})`);
  await db.query(`delete from public.booking_images where booking_id in (${fixtureBookings})`);
  await db.query(`delete from public.bookings where id in (${fixtureBookings})`);
  await db.query("delete from public.booking_slots where label='PG integration booking_confirmed'");

  async function booking(opts: { withImage?: boolean } = {}) {
    const slot = await db.query(`insert into public.booking_slots(booking_date,start_time,end_time,label,capacity,is_open)
      values (current_date + 400 + $1::int, '09:00', '10:00', 'PG integration booking_confirmed', 10, true) returning id`,
    [ids.slots.length]);
    const slotId = slot.rows[0].id as string;
    ids.slots.push(slotId);
    const row = await db.query(`insert into public.bookings(slot_id,source,nickname,phone,consultation_topic,birth_date_text,preferred_time,status,queue_number,hold_expires_at)
      values ($1,'website','pg-notify-test','0800000001','integration-topic','1995-05-05','PG integration booking_confirmed','pending_payment',1,now() + interval '30 minutes') returning id`,
    [slotId]);
    const id = row.rows[0].id as string;
    ids.bookings.push(id);
    if (opts.withImage) {
      await db.query(
        "insert into public.booking_images(booking_id, storage_path) values ($1, $2)",
        [id, `pg-integration/${id}.jpg`],
      );
    }
    return id;
  }

  async function order(bookingId: string, suffix: string) {
    const result = await db.query(
      "select (public.create_slip_payment_order($1,$2,99900,'profile-test')).id as id",
      [bookingId, `notif:${suffix}`],
    );
    const id = result.rows[0].id as string;
    ids.orders.push(id);
    return id;
  }

  async function confirmedNotifications(bookingId: string) {
    return (await db.query(
      `select id, recipient_type, channel, idempotency_key, payload, line_retry_key, image_retry_key
         from public.notification_deliveries
        where booking_id = $1 and event_type = 'booking_confirmed'`,
      [bookingId],
    )).rows;
  }

  function assertSummaryPayload(payload: Record<string, unknown>, bookingId: string, expectedMethod: string, expectedImagePath: string | null) {
    assert.equal(payload.booking_id, bookingId);
    assert.equal(payload.reference_code, bookingId.slice(0, 8).toUpperCase());
    assert.equal(payload.customer_name, "pg-notify-test");
    assert.equal(payload.birth_date, "1995-05-05");
    assert.equal(payload.consultation_topic, "integration-topic");
    assert.equal(payload.phone, "0800000001");
    assert.equal(payload.session_time, "PG integration booking_confirmed");
    assert.equal(payload.queue_number, 1);
    assert.equal(payload.confirmation_method, expectedMethod);
    assert.ok(payload.booking_date);
    assert.ok(payload.updated_at);
    assert.equal(payload.image_storage_path, expectedImagePath);
  }

  // =========================================================================
  // Path 1: admin non-payment override (transition_slot_booking), with image.
  // =========================================================================
  {
    const id = await booking({ withImage: true });
    await db.query("select public.transition_slot_booking($1,'confirmed')", [id]);
    const rows = await confirmedNotifications(id);
    assert.equal(rows.length, 1, "admin override must enqueue exactly one booking_confirmed notification");
    assert.equal(rows[0].recipient_type, "team");
    assert.equal(rows[0].channel, "line");
    assert.equal(rows[0].idempotency_key, `booking:confirmed:team:${id}`);
    assertSummaryPayload(rows[0].payload, id, "admin_override", `pg-integration/${id}.jpg`);

    // HIGH-4: image_retry_key is persisted, non-null, and distinct from
    // line_retry_key — never the same value, never regenerated per read.
    assert.ok(rows[0].line_retry_key, "line_retry_key must be populated (NOT NULL, 0011 default)");
    assert.ok(rows[0].image_retry_key, "image_retry_key must be populated (NOT NULL, 0012 default)");
    assert.notEqual(rows[0].line_retry_key, rows[0].image_retry_key, "text and image retry keys must be distinct values");
    const reread = await confirmedNotifications(id);
    assert.equal(reread[0].image_retry_key, rows[0].image_retry_key, "image_retry_key must be stable across reads, not regenerated");

    // Repeated confirmation must not duplicate (idempotent no-op transition).
    await db.query("select public.transition_slot_booking($1,'confirmed')", [id]);
    assert.equal((await confirmedNotifications(id)).length, 1, "repeated confirmation must not duplicate the notification");
  }

  // =========================================================================
  // Path 1b: admin non-payment override, no image on file.
  // =========================================================================
  {
    const id = await booking({ withImage: false });
    await db.query("select public.transition_slot_booking($1,'confirmed')", [id]);
    const rows = await confirmedNotifications(id);
    assert.equal(rows.length, 1);
    assertSummaryPayload(rows[0].payload, id, "admin_override", null);
  }

  // =========================================================================
  // Path 2: manual payment review approval.
  // =========================================================================
  {
    const id = await booking({ withImage: true });
    const orderId = await order(id, "manual");
    // Wrong profile forces manual_review instead of automatic confirmation.
    const forced = (await db.query(
      `select public.confirm_slip_payment($1,'promptpay_slip','REF PG MANUAL',now(),99900,'THB',$2,'{}'::jsonb) as result`,
      [orderId, "wrong-profile"],
    )).rows[0].result;
    assert.equal(forced.result, "manual_review");
    assert.equal((await confirmedNotifications(id)).length, 0, "manual_review must not enqueue a booking_confirmed notification yet");

    const approved = (await db.query("select public.approve_manual_review_payment($1) as result", [id])).rows[0].result;
    assert.equal(approved.result, "ok");
    const rows = await confirmedNotifications(id);
    assert.equal(rows.length, 1, "manual review approval must enqueue exactly one booking_confirmed notification");
    assertSummaryPayload(rows[0].payload, id, "manual_review_approved", `pg-integration/${id}.jpg`);

    // Repeated approval attempt: the order is already 'paid', so this
    // returns 'already_paid' (a normal, non-throwing result — same pattern
    // proven by slip-postgres.integration.test.ts's own manual-approve
    // replay) rather than raising. Either way, no duplicate notification.
    const replay = (await db.query("select public.approve_manual_review_payment($1) as result", [id])).rows[0].result;
    assert.equal(replay.result, "already_paid");
    assert.equal((await confirmedNotifications(id)).length, 1);
  }

  // =========================================================================
  // Path 3: EasySlip automatic confirmation.
  // =========================================================================
  {
    const id = await booking({ withImage: false });
    const orderId = await order(id, "auto");
    const result = (await db.query(
      `select public.confirm_slip_payment($1,'promptpay_slip','REF PG AUTO',now(),99900,'THB','profile-test','{}'::jsonb) as result`,
      [orderId],
    )).rows[0].result;
    assert.equal(result.result, "ok");
    const rows = await confirmedNotifications(id);
    assert.equal(rows.length, 1, "EasySlip automatic confirmation must enqueue exactly one booking_confirmed notification");
    assertSummaryPayload(rows[0].payload, id, "easyslip_auto", null);

    // Replaying the same confirmation call must not duplicate.
    const replay = (await db.query(
      `select public.confirm_slip_payment($1,'promptpay_slip','REF PG AUTO',now(),99900,'THB','profile-test','{}'::jsonb) as result`,
      [orderId],
    )).rows[0].result;
    assert.equal(replay.result, "already_paid");
    assert.equal((await confirmedNotifications(id)).length, 1);
  }

  // =========================================================================
  // Race: automatic (EasySlip replay) vs manual (review approval) confirming
  // the same booking concurrently. Both RPCs lock the same bookings row
  // before mutating status, so exactly one of them wins the 'confirmed'
  // transition — the other observes the booking is no longer pending_payment
  // and returns a non-mutating result. Only one booking_confirmed
  // notification may ever exist for this booking, regardless of interleaving.
  // =========================================================================
  {
    const id = await booking({ withImage: false });
    const orderId = await order(id, "race");
    const forced = (await db.query(
      `select public.confirm_slip_payment($1,'promptpay_slip','REF PG RACE',now(),99900,'THB',$2,'{}'::jsonb) as result`,
      [orderId, "wrong-profile"],
    )).rows[0].result;
    assert.equal(forced.result, "manual_review");

    const autoClient = await client();
    const manualClient = await client();
    const [auto, manual] = await Promise.all([
      autoClient.query(
        `select public.confirm_slip_payment($1,'promptpay_slip','REF PG RACE',now(),99900,'THB','profile-test','{}'::jsonb) as result`,
        [orderId],
      ),
      manualClient.query("select public.approve_manual_review_payment($1) as result", [id]),
    ]);
    assert.ok(["manual_review", "rejected", "already_paid"].includes(auto.rows[0].result.result));
    assert.ok(["ok", "already_paid"].includes(manual.rows[0].result.result));

    assert.equal(
      (await db.query("select status from public.bookings where id=$1", [id])).rows[0].status,
      "confirmed",
      "exactly one path must win and leave the booking confirmed",
    );
    const rows = await confirmedNotifications(id);
    assert.equal(rows.length, 1, "a race between automatic and manual confirmation must still produce exactly one booking_confirmed notification");
  }

  // =========================================================================
  // 0010 invariant preserved: a lapsed pending_payment hold can never be
  // confirmed via the admin-override path, and no notification is enqueued
  // for the rejected attempt.
  // =========================================================================
  {
    const id = await booking({ withImage: false });
    await db.query("update public.bookings set hold_expires_at = now() - interval '1 second' where id = $1", [id]);
    await assert.rejects(
      () => db.query("select public.transition_slot_booking($1,'confirmed')", [id]),
      /hold_expired/,
      "a lapsed hold must still be rejected by transition_slot_booking (0010 guard)",
    );
    assert.equal(
      (await db.query("select status from public.bookings where id=$1", [id])).rows[0].status,
      "pending_payment",
      "a rejected confirmation must leave the booking untouched",
    );
    assert.equal((await confirmedNotifications(id)).length, 0, "a rejected confirmation must never enqueue a notification");
  }

  // =========================================================================
  // 0011 ledger preserved: the automatic and manual paths both leave a
  // payment_transactions row resolved 'confirmed' and a
  // payment_slip_verifications audit row with outcome 'confirmed'.
  // =========================================================================
  {
    const id = await booking({ withImage: false });
    const orderId = await order(id, "ledger");
    const result = (await db.query(
      `select public.confirm_slip_payment($1,'promptpay_slip','REF PG LEDGER',now(),99900,'THB','profile-test','{}'::jsonb) as result`,
      [orderId],
    )).rows[0].result;
    assert.equal(result.result, "ok");
    const tx = await db.query(
      "select resolution from public.payment_transactions where payment_order_id=$1", [orderId],
    );
    assert.equal(tx.rows[0]?.resolution, "confirmed", "confirm_slip_payment must still resolve the transaction ledger claim");
    const verification = await db.query(
      "select outcome from public.payment_slip_verifications where payment_order_id=$1", [orderId],
    );
    assert.equal(verification.rows[0]?.outcome, "confirmed", "confirm_slip_payment must still write the audit ledger");
  }

  // =========================================================================
  // LINE delivery failure must never roll back or otherwise affect booking
  // confirmation: the notification_deliveries row and the bookings row are
  // mutated by entirely separate statements/tables. Simulate the delivery
  // worker exhausting retries (status -> 'dead', as complete_notification_delivery
  // would do) directly on the row, and confirm the booking's 'confirmed'
  // status is completely unaffected.
  // =========================================================================
  {
    const id = await booking({ withImage: false });
    await db.query("select public.transition_slot_booking($1,'confirmed')", [id]);
    const before = await confirmedNotifications(id);
    assert.equal(before.length, 1);
    await db.query(
      "update public.notification_deliveries set status='dead', last_error='line_push_failed_500' where id=$1",
      [before[0].id],
    );
    const status = (await db.query("select status from public.bookings where id=$1", [id])).rows[0].status;
    assert.equal(status, "confirmed", "a dead/failed LINE delivery must never roll back the booking's confirmed status");
  }

  // =========================================================================
  // HIGH-4: claim_team_notification_deliveries returns the SAME
  // image_retry_key across two separate claims of the identical row — the
  // exact scenario a worker crash between "LINE accepted the image" and
  // "complete_notification_delivery committed" produces (the row's lease
  // goes stale, a later worker reclaims it, and must resend the image with
  // the identical retry key so LINE dedupes it instead of delivering twice).
  // =========================================================================
  {
    const id = await booking({ withImage: true });
    await db.query("select public.transition_slot_booking($1,'confirmed')", [id]);
    const [row] = await confirmedNotifications(id);

    // Batch large enough to sweep up every pending booking_confirmed row
    // this suite has created so far (harmless side effect: they just move to
    // 'processing', which no other assertion in this file depends on).
    type ClaimRow = { id: string; image_retry_key: string; line_retry_key: string };
    const firstBatch: ClaimRow[] = (await db.query(
      "select id, image_retry_key, line_retry_key from public.claim_team_notification_deliveries($1,$2,$3)",
      ["worker-a", 200, ["booking_confirmed"]],
    )).rows;
    const firstClaim = firstBatch.find((r) => r.id === row.id);
    assert.ok(firstClaim, "claim must include our freshly-enqueued row");
    assert.equal(firstClaim!.image_retry_key, row.image_retry_key);
    assert.equal(firstClaim!.line_retry_key, row.line_retry_key);

    // Simulate a crashed worker: lease goes stale (>10 minutes old) without
    // ever calling complete_notification_delivery.
    await db.query(
      "update public.notification_deliveries set locked_at = now() - interval '11 minutes' where id=$1",
      [row.id],
    );
    const secondBatch: ClaimRow[] = (await db.query(
      "select id, image_retry_key, line_retry_key from public.claim_team_notification_deliveries($1,$2,$3)",
      ["worker-b", 200, ["booking_confirmed"]],
    )).rows;
    const secondClaim = secondBatch.find((r) => r.id === row.id);
    assert.ok(secondClaim, "the reclaimed row must still carry the identical image_retry_key");
    assert.equal(secondClaim!.image_retry_key, firstClaim!.image_retry_key, "image_retry_key must never be regenerated between claims");
    assert.equal(secondClaim!.line_retry_key, firstClaim!.line_retry_key, "line_retry_key must never be regenerated between claims");

    // Clean up the lease so this row doesn't linger 'processing'.
    await db.query("update public.notification_deliveries set status='sent', locked_by=null, locked_at=null where id=$1", [row.id]);
  }

  // =========================================================================
  // Privileges and RLS remain intact for the newly-replaced
  // transition_slot_booking: anon/authenticated can neither execute it nor
  // read the underlying tables directly. (confirm_slip_payment /
  // approve_manual_review_payment are covered the same way by
  // slip-postgres.integration.test.ts, which also runs under `npm run test:pg`.)
  // =========================================================================
  {
    const id = await booking({ withImage: false });
    const priv = await client();
    await priv.query("set role authenticated");
    await assert.rejects(
      () => priv.query("select public.transition_slot_booking($1,'confirmed')", [id]),
      "authenticated must not be able to execute transition_slot_booking",
    );
    await assert.rejects(
      () => priv.query("select * from public.bookings where id=$1", [id]),
      "authenticated must not have table-level SELECT on bookings",
    );
    await priv.query("set role anon");
    await assert.rejects(
      () => priv.query("select public.transition_slot_booking($1,'confirmed')", [id]),
      "anon must not be able to execute transition_slot_booking",
    );
    await assert.rejects(
      () => priv.query("select * from public.booking_slots limit 1"),
      "anon must not have table-level SELECT on booking_slots",
    );
    await priv.query("reset role");
    // The booking must remain untouched by the rejected privileged attempts.
    assert.equal(
      (await db.query("select status from public.bookings where id=$1", [id])).rows[0].status,
      "pending_payment",
    );
  }

  // =========================================================================
  // Never recipient_type = 'customer' for any booking_confirmed row created
  // above.
  // =========================================================================
  {
    const customerRows = await db.query(
      `select count(*)::int n from public.notification_deliveries
        where booking_id = any($1::uuid[]) and event_type = 'booking_confirmed' and recipient_type <> 'team'`,
      [ids.bookings],
    );
    assert.equal(customerRows.rows[0].n, 0, "no booking_confirmed row may target a non-team recipient");
  }

  console.log("booking-confirmed-notification integration passed");
} finally {
  for (const c of extraClients) {
    try { await c.query("rollback"); } catch { /* already closed/idle */ }
  }
  if (ids.orders.length) await db.query("delete from public.notification_deliveries where payment_order_id=any($1::uuid[])", [ids.orders]);
  if (ids.bookings.length) await db.query("delete from public.notification_deliveries where booking_id=any($1::uuid[])", [ids.bookings]);
  if (ids.orders.length) await db.query("delete from public.payment_slip_verifications where payment_order_id=any($1::uuid[])", [ids.orders]);
  if (ids.orders.length) await db.query("delete from public.payment_transactions where payment_order_id=any($1::uuid[])", [ids.orders]);
  if (ids.orders.length) await db.query("delete from public.payment_orders where id=any($1::uuid[])", [ids.orders]);
  if (ids.bookings.length) await db.query("delete from public.booking_images where booking_id=any($1::uuid[])", [ids.bookings]);
  if (ids.bookings.length) await db.query("delete from public.bookings where id=any($1::uuid[])", [ids.bookings]);
  if (ids.slots.length) await db.query("delete from public.booking_slots where id=any($1::uuid[])", [ids.slots]);
  for (const c of extraClients) await c.end().catch(() => undefined);
  await db.end();
}
