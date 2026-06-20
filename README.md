# Backoffice หมอแจว (Phase 1)

ระบบรับคำขอจองคิวปรึกษาผ่าน LINE OA ของหมอแจว และหน้าจัดการสำหรับทีมงาน

สโคป Phase 1: รับ webhook จาก LINE → เก็บข้อมูลการจอง (ข้อความ + รูปหน้าตรง 1 รูป)
→ สร้าง booking สถานะ `pending` → แจ้งกลุ่มทีมงาน → หน้า `/admin` สำหรับดูและเปลี่ยนสถานะ

> **ไม่รวม:** website integration, หลายกลุ่มแจ้งเตือน, สรุปรายวัน, การชำระเงิน,
> ระบบนัดหมายปฏิทิน, AI chat, การวิเคราะห์ใบหน้า และ analytics ขั้นสูง

---

## Tech stack

- Next.js (App Router) + TypeScript + Tailwind CSS
- Supabase (Postgres + Auth magic link + Storage)
- LINE Messaging API

---

## 1. ตั้งค่า Supabase + รัน migration

1. สร้างโปรเจกต์ใน [Supabase](https://supabase.com)
2. เปิด **SQL Editor** แล้วรันไฟล์ [`supabase/migrations/0001_init.sql`](supabase/migrations/0001_init.sql)
   - สร้างตาราง: `booking_sessions`, `bookings`, `booking_images`, `line_webhook_events`
   - เปิด Row Level Security ทุกตาราง (ปิดการเข้าถึงจาก client โดยตรง — แอปเข้าถึงผ่าน service role ฝั่งเซิร์ฟเวอร์เท่านั้น)
   - สร้าง Storage bucket `booking-faces` (private)

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

## 7. ขั้นตอนทดสอบ end-to-end (ด้วยข้อมูลจริงของคุณเอง)

1. แอดเป็นเพื่อนกับ LINE OA แล้วแชทแบบ 1-1
2. พิมพ์คีย์เวิร์ดเริ่มจอง: `จองคิวปรึกษาหมอแจว`
   → ระบบเริ่ม session เงียบ ๆ (ไม่มีการตอบกลับ)
3. ส่งข้อมูลตามฟอร์ม (ส่งทีเดียวหรือหลายข้อความก็ได้) เช่น:
   ```
   ชื่อเล่น: ...
   วันเกิด: ...
   หัวข้อ: ...
   เบอร์: ...
   สะดวก: ...
   ```
4. ส่ง **รูปหน้าตรง** อย่างน้อย 1 รูป
5. เมื่อครบทุกฟิลด์ + มีรูป ระบบจะ:
   - ตอบกลับลูกค้า: *"ได้รับข้อมูลการจองคิวเรียบร้อยแล้วค่ะ ..."*
   - ส่งข้อความแจ้งเตือนเข้ากลุ่มทีมงาน (ไม่แนบรูป)
6. เข้า `/admin` → ล็อกอินด้วย magic link (อีเมลต้องอยู่ใน `ADMIN_EMAILS`)
7. ดูรายการจอง, กรองตามสถานะ, เปิดดูรายละเอียด, ดูรูป (signed URL), เปลี่ยนสถานะ

---

## โครงสร้างหลัก

```
src/
  app/
    api/line/webhook/route.ts   # รับ + ตรวจ signature + จัดการ session/booking
    admin/                      # dashboard (list, detail, login, actions)
    auth/callback/route.ts      # แลก magic-link code เป็น session
  lib/
    line.ts                     # signature, reply, push, profile, content
    booking.ts                  # parse ฟิลด์ภาษาไทยแบบ conservative
    supabase/                   # admin (service role), server, client
    env.ts, auth.ts
supabase/migrations/0001_init.sql
```
