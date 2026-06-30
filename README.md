# Backoffice หมอแจว

ระบบจองคิวปรึกษาหมอแจว — Booking Core กลางที่ Website / LINE / Facebook / Instagram
จะพาลูกค้าเข้ามาจองผ่านฐานข้อมูลและ logic ชุดเดียวกัน

**Slot booking core เดียว:** การจองที่เลือกรอบจริงผ่าน slot + capacity + `create_booking` RPC ชุดเดียว
LINE webhook ตอบลิงก์ `/booking?source=line` เป็นทางหลัก และยังรองรับฟอร์ม LINE OA เดิม:
เมื่อข้อมูลที่ติด label และรูปครบ จะสร้างรายการ `pending` แบบไม่ผูก slot เพื่อให้แอดมินเห็นและติดต่อกลับ

**Slot booking:** หน้า `/booking` สาธารณะ (mobile-first) ให้ลูกค้าเลือก
**รอบรายชั่วโมง** (เช่น 18:00–19:00) ที่มี capacity ต่อ slot → สร้าง booking สถานะ `pending_payment`
และ **hold คิว 10 นาทีเพื่อรอชำระเงิน** → ถ้าไม่ชำระจะ `expired` และคืนที่ว่าง → `/admin/day` จัดการรายวัน

> **กันคิวเกิน capacity:** การสร้าง booking ทำผ่าน PostgreSQL function `create_booking()`
> ที่ใช้ row lock (`SELECT … FOR UPDATE`) บนแถวของรอบ จึงปลอดภัยแม้หลายคนกดพร้อมกัน
> (ไม่พึ่งการนับจาก frontend/API)

ช่องทาง (`source`) ที่รองรับ: `line`, `website`, `facebook`, `instagram`
เข้าหน้าจองพร้อมระบุช่องทางได้ที่ `/booking?source=line`

> **ยังไม่รวมในรอบนี้:** Facebook/Instagram webhook, LIFF, Payment Gateway,
> Google Calendar sync, redesign เว็บหลัก, multi-group, daily summary, analytics

---

## Tech stack

- Next.js (App Router) + TypeScript + Tailwind CSS
- Supabase (Postgres + Auth magic link + Storage)
- LINE Messaging API

---

## 1. ตั้งค่า Supabase + รัน migration

1. สร้างโปรเจกต์ใน [Supabase](https://supabase.com)
2. เปิด **SQL Editor** แล้วรัน migration **ตามลำดับ**:
   1. [`supabase/migrations/0001_init.sql`](supabase/migrations/0001_init.sql)
      - ตาราง: `booking_sessions`, `bookings`, `booking_images`, `line_webhook_events`
      - เปิด RLS ทุกตาราง (ไม่มี policy = ปิดการเข้าถึงจาก client; แอปใช้ service role ฝั่งเซิร์ฟเวอร์)
      - สร้าง Storage bucket `booking-faces` (private)
   2. [`supabase/migrations/0002_booking_slots.sql`](supabase/migrations/0002_booking_slots.sql) — **additive ไม่ลบข้อมูลเดิม**
      - ตาราง `booking_slots` (รอบเวลา + capacity + is_open)
      - เพิ่มคอลัมน์ `slot_id, source, queue_number, hold_expires_at, idempotency_key` ใน `bookings`
      - ขยายสถานะเป็น `pending_payment / confirmed / cancelled / expired / completed` (คงค่าเดิม `pending/contacted`)
      - ตาราง `api_rate_limits` (rate limit ข้าม instance)
      - ฟังก์ชัน `create_booking` (row lock กัน overbook + idempotency + duplicate guard),
        `transition_slot_booking` (state machine + capacity), `expire_pending_bookings`,
        `get_open_slots`, `record_rate_hit`
      - REVOKE execute จาก anon/authenticated, GRANT เฉพาะ service_role; REVOKE table DML จาก anon/authenticated

## 2. ตั้งค่า Storage bucket

migration จะสร้าง bucket `booking-faces` แบบ **private** ให้อัตโนมัติ
หากต้องการตรวจสอบ: ไปที่ **Storage** ใน Supabase → ต้องเห็น bucket ชื่อ `booking-faces`
และสถานะเป็น Private (ไม่มีไอคอน public)

> ไม่ต้องตั้ง storage policy เพิ่ม เพราะการอัปโหลดและการสร้าง signed URL
> ทำผ่าน service role key ฝั่งเซิร์ฟเวอร์

## 3. Environment variables

คัดลอก [`.env.example`](.env.example) เป็น `.env.local` แล้วกรอกค่า:

| ตัวแปร | คำอธิบาย |
| --- | --- |
| `NEXT_PUBLIC_APP_URL` | URL ของแอป เช่น `https://your-app.vercel.app` (ใช้สำหรับ magic link redirect) |
| `NEXT_PUBLIC_SUPABASE_URL` | Project URL จาก Supabase |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | anon public key |
| `SUPABASE_SERVICE_ROLE_KEY` | service role key — **ฝั่งเซิร์ฟเวอร์เท่านั้น ห้าม expose ไปยัง browser** |
| `LINE_CHANNEL_ACCESS_TOKEN` | จาก LINE Developers Console (Messaging API) |
| `LINE_CHANNEL_SECRET` | ใช้ตรวจสอบ signature ของ webhook |
| `LINE_BOOKING_NOTIFY_GROUP_ID` | group ID ของกลุ่มทีมงานที่จะรับแจ้งเตือน |
| `ADMIN_EMAILS` | อีเมลแอดมินที่อนุญาตให้เข้า `/admin` คั่นด้วย comma |
| `BOOKING_START_KEYWORDS` | คีย์เวิร์ดเริ่มจอง (ดีฟอลต์ `จองคิวปรึกษาหมอแจว`) คั่นด้วย comma |
| `BOOKING_PAYMENT_AMOUNT_THB` | ยอดชำระเงิน (บาท) แสดงบนหน้า `/booking/success` |
| `BOOKING_BANK_NAME` | ชื่อธนาคาร เช่น `กสิกรไทย` |
| `BOOKING_ACCOUNT_NAME` | ชื่อบัญชี |
| `BOOKING_ACCOUNT_NUMBER` | เลขบัญชี |
| `BOOKING_PAYMENT_QR_PATH` | path รูป QR (relative จาก `public/`) ดีฟอลต์ `/payment-qr.png` |
| `NEXT_PUBLIC_LINE_OA_URL` | URL LINE OA สำหรับปุ่ม "ส่งสลิปผ่าน LINE" เช่น `https://line.me/R/ti/p/@youroa` |

## 4. รันในเครื่อง

```bash
npm install
npm run dev
```

เปิด `http://localhost:3000` → ระบบจะ redirect ไป `/admin`

## 5. Deploy บน Vercel

1. push โค้ดขึ้น GitHub
2. Import โปรเจกต์ใน [Vercel](https://vercel.com)
3. ใส่ environment variables ทั้งหมดในหน้า Project Settings → Environment Variables
4. ตั้ง `NEXT_PUBLIC_APP_URL` เป็น production URL ของ Vercel
5. ใน Supabase → **Authentication → URL Configuration** เพิ่ม
   `https://your-app.vercel.app/auth/callback` ใน Redirect URLs
6. Deploy

## 6. ตั้งค่า LINE webhook

1. ไปที่ [LINE Developers Console](https://developers.line.biz) → Messaging API channel
2. ตั้ง **Webhook URL** เป็น:
   `https://your-app.vercel.app/api/line/webhook`
3. เปิด **Use webhook**
4. ปิด auto-reply / greeting ที่ทับซ้อนได้ตามต้องการ (ฟอร์มจอง OA Manager ส่งให้ลูกค้าอยู่แล้ว)

> ระบบนี้ **ไม่ส่งฟอร์มจองซ้ำ** เพราะ LINE OA Manager ส่งฟอร์มเดิมอยู่แล้ว
> เพียงแค่ติดตามคำตอบของลูกค้าอย่างเงียบ ๆ

### วิธีหา `LINE_BOOKING_NOTIFY_GROUP_ID`

LINE ไม่แสดง group ID ในแอป ต้องดึงจาก webhook event:

1. ตั้ง webhook URL และเปิด Use webhook ให้เรียบร้อย (ขั้นตอนข้างบน)
2. เชิญ LINE OA เข้ากลุ่มทีมงานที่ต้องการรับแจ้งเตือน
3. พิมพ์ข้อความอะไรก็ได้ในกลุ่มนั้น 1 ครั้ง
4. เปิด **Logs** (Vercel → Deployment → Functions/Logs หรือ terminal ตอนรัน `npm run dev`)
   จะเห็นบรรทัด:
   ```
   [line] groupId (for LINE_BOOKING_NOTIFY_GROUP_ID): Cxxxxxxxxxxxxxxxx
   ```
5. คัดลอกค่า `Cxxxx...` ไปใส่ใน `LINE_BOOKING_NOTIFY_GROUP_ID`

> group ID ถูก log ลง server log เท่านั้น (ไม่ตอบกลับในแชทและไม่เปิดเผยต่อสาธารณะ)

### อายุของ session

session ที่เริ่มจองแล้วไม่ทำต่อจะ **หมดอายุอัตโนมัติภายใน 24 ชั่วโมง** (นับจากกิจกรรมล่าสุด)
ข้อความที่ส่งมาภายหลังจะไม่ถูกนำไปรวมกับ session เก่า — ต้องพิมพ์คีย์เวิร์ดเริ่มจองใหม่

## 7. ขั้นตอนทดสอบ LINE (ด้วยข้อมูลจริงของคุณเอง)

1. แอดเป็นเพื่อนกับ LINE OA แล้วแชทแบบ 1-1
2. พิมพ์คีย์เวิร์ดเริ่มจอง: `จองคิวปรึกษาหมอแจว`
   → ระบบตอบลิงก์ `…/booking?source=line` และเปิด session สำหรับฟอร์ม LINE OA เดิม
3. ทางหลัก: กดลิงก์ → เลือกรอบใน `/booking` → ได้ booking `pending_payment`
4. ทางฟอร์มเดิม: ส่งข้อมูลที่ติด label ครบและรูป 1 รูป → ได้ booking `pending`
   แบบไม่ผูก slot; event/session เดิมที่ส่งซ้ำจะคืน booking เดิมและไม่สร้างซ้ำ
5. ข้อมูลไม่ครบหรือไม่มีรูป → ยังไม่สร้าง booking
6. รายการ LINE แบบไม่ผูก slot ใช้สำหรับตรวจสอบ/ติดต่อกลับเท่านั้น และยืนยันเป็นคิวจริงไม่ได้
   จนกว่าลูกค้าจะเลือกรอบผ่าน `/booking?source=line`
7. เข้า `/admin` → ล็อกอิน magic link (อีเมลต้องอยู่ใน `ADMIN_EMAILS`) → ดู/จัดการรายการ

> booking เก่าที่ slot_id เป็น null (ถ้ามีในฐานข้อมูล) ถือเป็น legacy/manual —
> admin ยืนยันได้แบบ manual โดยไม่ผูกกับ capacity ของรอบ

## 8. Slot booking (Website / ทุกช่องทาง)

### Flow ลูกค้า
1. เปิด `/booking` (หรือ `/booking?source=line|website|facebook|instagram`)
   - `source` ถูก validate ด้วย allowlist; ค่าที่ไม่รู้จักจะ fallback เป็น `website`
2. เลือกวัน → เห็นเฉพาะรอบรายชั่วโมงที่ **เปิด**, **ยังไม่เริ่ม**, และ **ยังมีที่เหลือ** พร้อมจำนวนคิวคงเหลือ
3. เลือกรอบ + กรอกข้อมูล (ชื่อเล่น, เบอร์, วันเกิด, หัวข้อ)
4. กดยืนยัน → สร้าง booking สถานะ `pending_payment` + hold 10 นาทีสำหรับชำระเงิน + ได้ **ลำดับคิวในรอบ**
5. หน้า `/booking/success` แสดง **เลขอ้างอิง / วัน / รอบ / ลำดับคิว / สถานะ**
   (ไม่ส่งข้อมูลส่วนบุคคลผ่าน query string)

### Admin day view (`/admin/day`)
- เลือกวัน → เห็นแต่ละ slot รายชั่วโมง, จำนวนจอง/capacity, รายชื่อลูกค้าในรอบ
- ปุ่ม **สร้างรอบรายชั่วโมง** (ถ้ายังไม่มีรอบของวันนั้น), **แก้ capacity ราย slot**, **ปิด/เปิดรอบ**
- เปลี่ยนสถานะแบบ state machine (แสดงเฉพาะปุ่มที่ทำได้ตามสถานะปัจจุบัน):
  `pending_payment → ยืนยัน / ยกเลิก`, `confirmed → เสร็จสิ้น / ยกเลิก`
  (ทุก transition ผ่าน `transition_slot_booking` ที่ lock booking+slot และเช็ค capacity —
  ยืนยันเกิน capacity หรือเปลี่ยนสถานะที่ไม่ถูกต้องไม่ได้)

### หมดอายุ hold (คืนที่ว่าง)
- ก่อน query ความว่างและก่อนสร้าง booking ระบบจะเคลียร์ hold ที่หมดเวลาให้อัตโนมัติ
- มี endpoint backstop: `GET /api/cron/expire-bookings`
  - **ต้องตั้ง `CRON_SECRET` เสมอ** และส่ง header `Authorization: Bearer <CRON_SECRET>` ทุกครั้ง
  - ถ้าไม่ได้ตั้ง `CRON_SECRET` → endpoint ปิด (ตอบ `503 cron_disabled`) ไม่เปิดสาธารณะ
  - token ผิด/ไม่ส่ง → `401`
  - โปรเจกต์นี้ใช้ GitHub Actions scheduler ที่ `.github/workflows/expire-bookings.yml`
    เพื่อยิง endpoint ทุก 5 นาทีแทน Vercel Cron
  - ห้ามเพิ่ม `vercel.json` cron สำหรับ endpoint นี้บน Vercel Hobby

#### ตั้งค่า GitHub Actions scheduler

1. ไปที่ GitHub repo → **Settings** → **Secrets and variables** → **Actions**
2. เพิ่ม Repository secrets:
   - `BOOKING_APP_URL`: URL ของแอป เช่น `https://your-app.vercel.app` (ไม่ต้องมี `/` ท้าย URL)
   - `CRON_SECRET`: ค่าเดียวกับ environment variable `CRON_SECRET` ที่ตั้งไว้ในแอป
3. Workflow จะรันอัตโนมัติทุก 5 นาทีตาม schedule `*/5 * * * *`
4. วิธีทดสอบเอง: ไปที่ **Actions** → **Expire pending bookings** → **Run workflow**
5. ถ้า endpoint ตอบไม่ใช่ 2xx, step `curl --fail` จะทำให้ workflow ล้มเหลวเพื่อให้เห็นปัญหาใน Actions logs

### LINE notify (public booking)
- เมื่อจองสำเร็จ ระบบส่งแจ้งทีมผ่าน `notifyTeamSafe` (วัน/รอบ/ชื่อ/เบอร์/หัวข้อ/source/สถานะ/ลิงก์ Backoffice)
- **ถ้ายังไม่ตั้ง `LINE_BOOKING_NOTIFY_GROUP_ID` หรือ token → ไม่ทำให้ booking ล้มเหลว**
  เพียง log ว่า `[line] team notify skipped: ...`

### LINE OA → ลิงก์เข้าหน้าจอง
ไม่ต้องแก้โค้ด — ตั้งใน LINE OA Manager (Rich menu / ข้อความ) ให้ลิงก์ไปที่
`https://your-app.vercel.app/booking?source=line`

## 11. ตั้งค่า Payment Instructions

หน้า `/booking/success` แสดงรายละเอียดชำระเงินถ้ากรอก env vars ครบทั้ง 4 ตัว
(`BOOKING_PAYMENT_AMOUNT_THB`, `BOOKING_BANK_NAME`, `BOOKING_ACCOUNT_NAME`, `BOOKING_ACCOUNT_NUMBER`)
ถ้าตัวใดว่าง ระบบจะแสดงข้อความสำรอง "ทีมงานจะติดต่อเพื่อแจ้งรายละเอียดการชำระเงิน" แทน

### วาง QR code

1. เตรียมรูป QR สำหรับโอนเงิน (ขนาดแนะนำ 400×400 px)
2. วางไฟล์ที่ `public/payment-qr.png`
3. ตั้ง `BOOKING_PAYMENT_QR_PATH=/payment-qr.png` ใน Vercel Environment Variables

> QR จะไม่แสดงถ้า `BOOKING_PAYMENT_QR_PATH` ว่าง

### LINE OA สำหรับส่งสลิป

ตั้ง `NEXT_PUBLIC_LINE_OA_URL` เป็น URL ของ LINE OA (เช่น `https://line.me/R/ti/p/@youroa`)
ปุ่ม "ส่งสลิปผ่าน LINE" จะไม่แสดงถ้า env ว่าง

### Environment Variables ที่ต้องตั้งบน Vercel Production

| ตัวแปร | หมายเหตุ |
| --- | --- |
| `BOOKING_PAYMENT_AMOUNT_THB` | ยอดชำระ (ตัวเลขล้วน ไม่มีสกุลเงิน) |
| `BOOKING_BANK_NAME` | ธนาคาร เช่น `กสิกรไทย` |
| `BOOKING_ACCOUNT_NAME` | ชื่อบัญชี |
| `BOOKING_ACCOUNT_NUMBER` | เลขบัญชี (ไม่มีขีด) |
| `BOOKING_PAYMENT_QR_PATH` | `/payment-qr.png` (ถ้าวางไฟล์แล้ว) |
| `NEXT_PUBLIC_LINE_OA_URL` | URL LINE OA |

---

## 9. Security / RPC boundary

- ฟังก์ชัน `create_booking`, `transition_slot_booking`, `get_open_slots`,
  `expire_pending_bookings`, `record_rate_hit` ทั้งหมดเป็น **invoker rights**
  (ไม่ใช้ SECURITY DEFINER) และ migration `0002` ทำ `REVOKE EXECUTE ... FROM
  public, anon, authenticated` แล้ว `GRANT EXECUTE ... TO service_role`
- ตาราง `bookings`, `booking_slots`, `api_rate_limits` เปิด RLS (ไม่มี policy)
  และ `REVOKE ALL ... FROM anon, authenticated` — public/browser เข้าถึง DB ตรงไม่ได้
- Browser เข้าได้เฉพาะผ่าน Next routes: `GET /api/slots`, `POST /api/bookings`
- ทุก state transition ของ slot booking ผ่าน `transition_slot_booking` (lock booking+slot)
  ไม่มี direct status update สำหรับ slot booking; legacy/manual (slot_id null) แยก flow

## 10. Checklist ทดสอบบน staging

> ใช้ Supabase project สำหรับ staging แยกจาก production และข้อมูลทดสอบของคุณเอง
> ต้องตั้ง env `BOOKING_RATE_LIMIT_SECRET` (และ `CRON_SECRET` ถ้าจะทดสอบ cron)

**RPC boundary**
- [ ] เรียก RPC ตรงด้วย anon key ต้องถูกปฏิเสธ (permission denied):
      ```bash
      curl -s "$SUPABASE_URL/rest/v1/rpc/get_open_slots" \
        -H "apikey: $ANON_KEY" -H "authorization: Bearer $ANON_KEY" \
        -H 'content-type: application/json' -d '{"p_date":"2026-07-01"}'
      # คาดหวัง: 401/403 permission denied — ทำซ้ำกับ create_booking ด้วย
      ```
- [ ] เข้า `/admin`, `/admin/day`, `/admin/bookings/[id]` โดยไม่ล็อกอิน → redirect `/admin/login`

**Slot capacity / availability**
- [ ] รัน `0001` แล้วตามด้วย `0002` ใน SQL Editor — ไม่มี error
- [ ] `/admin/day` → "สร้างรอบรายชั่วโมง" → เห็น 12 slots (09:00–21:00); default capacity = 1 ต่อ slot
- [ ] ตั้ง capacity slot หนึ่ง = 4 แล้วจองจาก `/booking?source=website` ครบ 4 (เบอร์ต่างกัน) → คิว 1–4; ครั้งที่ 5 → 409 `slot_full`
- [ ] กด "ปิดรอบ" → `/booking` ไม่แสดงรอบนั้น และ API ตอบ 409 `slot_closed`
- [ ] ตั้งรอบของวันนี้ให้ `start_time` ผ่านไปแล้ว → `/booking` ไม่แสดงรอบนั้น และยิง POST ด้วย slotId เดิมต้องได้ 409 `slot_closed`
- [ ] ปล่อย `pending_payment` หมด 10 นาที (หรือยิง cron) → `expired` และที่ว่างกลับมา

**Double-click / idempotency** (`$KEY` = UUID เดียวกัน)
- [ ] ยิงซ้ำด้วย `Idempotency-Key` เดิม 2 ครั้ง → ได้ booking เดิม คิวไม่เพิ่ม:
      ```bash
      KEY=$(uuidgen)
      curl -s -X POST "$APP/api/bookings" -H 'content-type: application/json' \
        -H "Idempotency-Key: $KEY" \
        -d "{\"slotId\":\"$SLOT\",\"source\":\"website\",\"nickname\":\"a\",\"phone\":\"0812345678\",\"consultationTopic\":\"x\",\"birthDateText\":\"y\"}"
      # ยิงคำสั่งเดิมซ้ำอีกครั้ง → reference/queue เท่าเดิม
      ```

**Duplicate (เบอร์เดิม + รอบเดิม + key ใหม่)**
- [ ] ยิงด้วย `Idempotency-Key` ใหม่ เบอร์เดิม slot เดิม → 409 `duplicate_booking`
- [ ] cancel/expire booking นั้นก่อน แล้วจองใหม่เบอร์เดิม → สำเร็จ

**Concurrent (capacity เกินไม่ได้)**
- [ ] ```bash
      for i in $(seq 1 10); do
        curl -s -X POST "$APP/api/bookings" -H 'content-type: application/json' \
          -H "Idempotency-Key: $(uuidgen)" \
          -d "{\"slotId\":\"$SLOT\",\"source\":\"website\",\"nickname\":\"t$i\",\"phone\":\"08120000$i\",\"consultationTopic\":\"x\",\"birthDateText\":\"y\"}" &
      done; wait
      ```
      → จำนวนที่สำเร็จต้อง **ไม่เกิน capacity**

**Rate limit** (>5 ครั้ง/15 นาที ต่อ IP)
- [ ] ยิง POST เกิน 5 ครั้งจาก IP เดียว → ครั้งที่ 6 ได้ 429
- [ ] ลบ env `BOOKING_RATE_LIMIT_SECRET` ชั่วคราว → POST ตอบ 500 config error (ไม่เงียบ ๆ ปิด rate limit)
- [ ] honeypot: POST ที่มี `"company":"x"` → 400

**Admin state transitions**
- [ ] pending_payment → ยืนยัน สำเร็จ แม้รอบเต็มพอดี (hold ยังไม่หมด)
- [ ] confirmed → เสร็จสิ้น สำเร็จ และ occupancy ไม่เพิ่ม
- [ ] confirmed → ยกเลิก แล้ว capacity คืน (จองใหม่ได้)
- [ ] expired/cancelled → ไม่มีปุ่ม confirm/complete และถ้ายิง RPC ตรงต้องได้ `invalid_transition`
- [ ] client พยายามส่ง `status`/`queue_number`/`hold_expires_at`/`capacity` ใน body → ไม่มีผล (server กำหนดเอง)

---

## โครงสร้างหลัก

```
src/
  app/
    api/line/webhook/route.ts        # LINE: signature + session/booking
    api/slots/route.ts               # public: รอบว่างของวัน
    api/bookings/route.ts            # public: สร้าง booking (ผ่าน core เดียว)
    api/cron/expire-bookings/route.ts# job คืนที่ว่างจาก hold ที่หมดเวลา
    booking/                         # หน้าจองสาธารณะ (page + BookingForm + success)
    admin/                           # list, detail, login, actions
    admin/day/                       # day view + slot/booking actions
    auth/callback/route.ts
  lib/
    slots.ts                         # กฎ capacity/queue/validation (pure, มี test)
    booking-core.ts                  # createSlotBooking / getAvailableSlots (เรียก RPC)
    line.ts                          # signature, reply, notifyTeamSafe, content
    booking.ts                       # parser LINE conversational
    supabase/ env.ts auth.ts
supabase/migrations/0001_init.sql
supabase/migrations/0002_booking_slots.sql
```

## การทดสอบ / สคริปต์

```bash
npm run typecheck   # tsc --noEmit
npm run lint        # eslint (next lint)
npm run test        # parser + slot capacity + admin auth-guard self-checks
npm run build
```
