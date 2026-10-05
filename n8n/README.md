# เริ่มเชื่อม Mohjaew กับ n8n — LINE Chat v2

โค้ดชุดนี้ยังปิดบอทเป็นค่าเริ่มต้น อย่าเปิดรับลูกค้าทั้งหมดก่อนทดสอบครบ

## ภาพรวม
LINE → เว็บรับและเก็บข้อความ → n8n ขอประวัติจากเว็บ → GPT-6 Luna → ส่งคำตอบกลับเว็บ → เว็บส่ง LINE

- LINE Channel Secret / Access Token และ Supabase Service Role อยู่ใน Vercel เท่านั้น
- OpenAI API Key ของ Chat Bot อยู่ใน n8n Credentials
- n8n ไม่ตรวจคิว ไม่ยืนยันเงิน ไม่สร้างการจอง และไม่ทำนายดวงเอง
- ระบบแคมเปญและการเชื่อมบัญชีทดสอบ LINE เดิมยังทำงาน
- รองรับข้อความส่วนตัวแบบ text ไม่ตอบกลุ่ม รูป สลิป เสียง หรือ follow events
- รุ่นนี้จดจำได้สูงสุด 6 คู่ข้อความที่ส่งสำเร็จ โดยจำกัดเนื้อหาประวัติรวม 12,000 ตัวอักษร
- เก็บข้อความที่ปิดงานแล้ว 30 วัน การล้างทำงานพร้อม recovery workflow

## 0. สิ่งที่ต้องพร้อมก่อนเริ่ม
1. Deploy โค้ด branch feat/mohjaew-line-chat ไป Preview สำหรับทดสอบก่อน
2. ติดตั้ง SQL: supabase/migrations/20261005043116_mohjaew_line_chat.sql
   SQL นี้สร้างเฉพาะตารางและฟังก์ชัน Chat Bot ใหม่ ไม่แก้ข้อมูลการจองหรือการเงิน
   ให้ผู้ดูแลโค้ดตรวจและติดตั้ง migration ก่อนเปิดบอท ไม่ต้องติดตั้งใหม่ซ้ำหากมีในประวัติแล้ว
3. มี n8n ที่ URL เป็น HTTPS และ Vercel สามารถเรียกถึงได้
   ถ้า n8n อยู่บน localhost ของคอมคุณ Vercel จะเรียกไม่ถึง ต้องมี HTTPS endpoint ที่เข้าถึงได้
4. มี OpenAI API Key ที่เรียก gpt-6-luna ได้ และ LINE Messaging API ของ OA ที่ตั้ง webhook แล้ว
5. มีบัญชี LINE สำหรับทดสอบ และทราบ user ID (รูปแบบ U ตามด้วยตัวอักษร/ตัวเลข 32 ตัว)
   ใช้การเชื่อมบัญชีทดสอบใน Backoffice LINE เดิมเพื่อระบุบัญชีของคุณได้
6. Preview และ Production ที่ใช้ Supabase ร่วมกันจะแยกข้อมูลด้วย scope
   ต้องใช้ workflow และ Secret คนละชุด และตั้ง callback URL ให้ตรง environment เสมอ

## 1. สร้าง Secret เชื่อมเว็บกับ n8n
รันใน Terminal ที่มี Node:
```sh
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```
เก็บค่าที่ได้ไว้เอง อย่าส่งลงแชท อย่าใส่ในไฟล์ JSON ที่จะ commit

## 2. สร้าง Credentials ใน n8n
สร้างประเภท Header Auth 3 รายการ:

| ชื่อ | Header Name | Header Value |
|---|---|---|
| Mohjaew Shared Secret | Authorization | Bearer ตามด้วยเว้นวรรคและ Secret จากข้อ 1 |
| OpenAI Chat API | Authorization | Bearer ตามด้วยเว้นวรรคและ OpenAI API Key |
| Mohjaew Cron Secret | Authorization | Bearer ตามด้วยเว้นวรรคและ CRON_SECRET ของ Vercel |

ตัวอย่างรูปแบบเท่านั้น: Bearer YOUR_SECRET

Shared Secret ใช้ยืนยันทั้งเว็บเรียก n8n และ n8n เรียก callback กลับเว็บ
Cron Secret ใช้เฉพาะการกู้ข้อความค้าง ไม่ใช่ OpenAI Key และไม่ใช่ LINE Secret

## 3. Import workflow หลัก
1. สร้าง workflow ใหม่ แล้วเลือก Import from File
2. เลือก n8n/mohjaew-line-ai-chat.json
3. เปิด node Mohjaew Ingress เลือก Header Auth credential: Mohjaew Shared Secret
4. เปิด Prepare Chat และ Complete Chat เลือก credential: Mohjaew Shared Secret
5. เปิด GPT-6 Luna เลือก credential: OpenAI Chat API
6. แก้ URL ใน Prepare Chat และ Complete Chat ให้เป็นโดเมนของ deployment ที่จะทดสอบ:
   - https://YOUR_APP/api/line/chat/prepare
   - https://YOUR_APP/api/line/chat/complete
7. Publish/Activate workflow ตามหน้าจอ n8n ของคุณ
8. เปิด Mohjaew Ingress คัดลอก Production URL
   ต้องใช้ Production URL ของ n8n แม้ฝั่งเว็บเป็น Preview
   Test URL ใช้เฉพาะตอนกด Listen for Test Event และไม่เหมาะสำหรับการเชื่อมถาวร

ไฟล์นี้ปิด workflow มาให้ และไม่มีค่าลับฝังอยู่
n8n บางรุ่นจะให้คุณเลือก Credentials ใหม่หลัง import นั่นเป็นเรื่องปกติ

## 4. ตั้ง Vercel environment variables
ใส่ใน environment ที่จะทดสอบ:

| ชื่อ | ค่า |
|---|---|
| N8N_CHATBOT_WEBHOOK_URL | Production URL จาก node Mohjaew Ingress |
| N8N_CHATBOT_SECRET | Secret จากข้อ 1 โดยไม่มีคำว่า Bearer |
| LINE_CHATBOT_ENABLED | true |
| LINE_CHATBOT_ALLOWED_USER_IDS | LINE user ID ของคุณ หากหลายบัญชีคั่นด้วย comma |
| LINE_CHATBOT_ALLOW_ALL_USERS | false |
| CRON_SECRET | Secret สำหรับ recovery workflow |
| BOOKING_PAYMENT_AMOUNT_THB | ราคาจริงที่ได้รับอนุมัติจากเจ้าของบริการ |
| NEXT_PUBLIC_APP_URL | URL ของ environment นี้ |

LINE_CHANNEL_SECRET, LINE_CHANNEL_ACCESS_TOKEN และ Supabase ต้องเป็นค่าถูกต้องของระบบเดิม
OpenAI Key ฝั่ง Vercel เดิมยังใช้สร้างร่างแคมเปญได้ แต่ Chat Bot ชุดนี้ใช้ Key ใน n8n
หลังแก้ Vercel variables ต้อง redeploy ให้ deployment ใหม่ใช้ค่าใหม่

## 5. ตั้ง webhook ของ LINE Developers
ให้ชี้ไปที่เว็บ:
https://YOUR_APP/api/line/webhook

อย่าชี้ LINE ไป n8n โดยตรง เพราะเว็บต้องตรวจลายเซ็นและเก็บงานก่อน
เปิด Use webhook และ Webhook redelivery เพื่อให้ LINE ส่งซ้ำเมื่อเว็บเก็บงานไม่สำเร็จ
กด Verify ควรผ่าน ทั้งนี้ Verify อย่างเดียวไม่ได้พิสูจน์ว่า AI ตอบกลับได้

ตรวจการตอบอัตโนมัติใน LINE OA ด้วย หากมีข้อความตอบรับ/คำตอบเดิมเปิดอยู่ อาจตอบทับกับบอทใหม่

## 6. Import workflow กู้ข้อความค้าง
1. Import n8n/mohjaew-line-chat-recovery.json เป็นอีก workflow
2. ที่ Recover Chat Jobs เลือก credential: Mohjaew Cron Secret
3. แก้ URL เป็น https://YOUR_APP/api/cron/recover-line-chat
4. กด Manual Test ก่อน ควรได้ผล JSON ที่ enabled=true
5. Publish/Activate เพื่อให้รันทุก 1 นาที

ต้องเปิด recovery workflow ก่อนทดสอบข้อความต่อเนื่อง
หากข้อความเดียวกันมาถึงหลายครั้ง ระบบใช้ event ID ป้องกันการคิด/ส่งซ้ำ
หากลูกค้าส่งหลายข้อความต่อเนื่อง ข้อความถัดไปอาจรอรอบ recovery เพื่อให้ตอบเรียงลำดับ
หาก AI ค้าง ระบบจะกู้งานหลัง lease หมด 90 วินาที และพยายามสร้างคำตอบสูงสุด 3 รอบ

## 7. ทดสอบก่อนเปิดลูกค้าจริง
ทักจากบัญชีทดสอบที่อยู่ใน allowlist:
- สวัสดีค่ะ ราคาเท่าไหร่ → ตอบราคาจากระบบและลิงก์จอง
- จองตรงไหน → ส่งลิงก์จองที่ตรง environment
- โอนแล้ว ยืนยันให้หน่อย → ให้แอดมินตรวจ ห้ามยืนยันเอง
- ขอทำนายดวงในแชท → แนะนำบริการ ไม่แต่งคำทำนาย
- ถามต่อจากข้อความก่อนหน้า → ใช้ประวัติของลูกค้ารายนั้น
- ส่ง 2–3 ข้อความติดกัน → ได้งานครบและตอบเรียง อาจรอรอบ recovery
- เปิด /admin/chat เลือกลูกค้า กดพักบอท แล้วส่งข้อความ → บันทึกแต่ไม่ให้ AI ตอบ
- กดให้บอทตอบข้อความใหม่ → งานเก่าที่พักไว้ไม่ถูกส่งย้อนหลัง
- ปิด workflow หลักชั่วคราว ทักข้อความ เปิดคืน แล้วรอ recovery → งานกลับมาทำต่อ
- ทักจากบัญชีที่ไม่ได้อยู่ใน allowlist → ไม่ตอบ AI และไม่เก็บข้อความเป็น Chat Bot

ตัวทดสอบแยกข้อมูลต่อบัญชี ใช้ 2 LINE accounts หากต้องการยืนยันความจำไม่ปะปนจริง

## 8. เมื่อจะเปิดให้ลูกค้าจริง
หลังทดสอบผ่าน:
1. Deploy branch ที่ตรวจแล้วไป Production และติดตั้ง migration ในฐานข้อมูลที่ตรงกัน
2. ใช้ n8n workflow ชุด Production, credential และ callback URL ของ Production
3. ตรวจ recovery workflow เปิดอยู่
4. ตั้ง LINE_CHATBOT_ALLOW_ALL_USERS=true และ redeploy
5. เช็กบทสนทนาชุดแรกใน /admin/chat

เมื่อต้องหยุดบอททั้งหมด: ตั้ง LINE_CHATBOT_ENABLED=false แล้ว redeploy
การหยุดจะไม่ปิดระบบแคมเปญหรือระบบจองเดิม

## ข้อจำกัดที่ต้องเข้าใจ
- แอดมินตอบใน LINE OA แล้วระบบไม่ทราบโดยอัตโนมัติ ต้องกดพักบอทก่อนตอบ
- ประวัติยังไม่มีข้อความที่แอดมินพิมพ์ใน LINE OA; หลังแอดมินดูแลเสร็จ ลูกค้าควรถามคำถามใหม่ให้ชัด
- เมื่อ LINE reply ได้ผลคลุมเครือ เช่น network timeout ระบบจะขึ้น ต้องตรวจการส่งใน LINE
  และหยุดข้อความถัดไปของลูกค้ารายนั้น เพื่อป้องกันการส่งซ้ำ ตรวจใน OA แล้วกดพัก/คืนบอทเพื่อปิดงานค้าง
- หาก reply token หมดอายุและ LINE ปฏิเสธชัดเจน ระบบใช้ Push API พร้อม retry key เดิม
  Push ใช้โควตาข้อความของ OA จึงต้องตรวจโควตาของบัญชีจริงก่อนเปิดรับลูกค้าทั้งหมด
- ปุ่มพักบอทยกเลิกงานที่ยังไม่ส่ง คำขอส่ง LINE ที่เริ่มส่งไปแล้วอาจส่งสำเร็จได้
- ระบบจำกัดการรับ 20 ข้อความต่อลูกค้าต่อ 1 นาที ข้อความเกินขีดจำกัดจะไม่เข้า AI
- Prompt เป็นข้อกำหนดให้ AI ไม่ใช่หลักประกันว่าคำตอบถูกทุกครั้ง ต้องตรวจคำตอบจากกรณีทดสอบจริง
- ตาราง ข้อมูล และสิทธิ์ทดสอบผ่านใน PostgreSQL ที่สร้างทิ้งได้ ยังไม่ได้แก้ฐานข้อมูล Production
- ไฟล์ workflow ตรวจรูปแบบและการแปลงข้อมูลแล้ว แต่ยังต้อง import และรันกับ n8n instance จริง

## ถ้าไม่ตอบ ให้ตรวจตามนี้
1. LINE Verify ผ่านหรือไม่ และ webhook URL ชี้เว็บถูก environment หรือไม่
2. Vercel ใช้ deployment โค้ดใหม่และมี LINE_CHATBOT_ENABLED=true หรือไม่
3. LINE user ID ของคุณอยู่ใน allowlist หรือไม่
4. /admin/chat เห็นข้อความหรือไม่ ถ้าไม่เห็น ให้ตรวจ migration และลายเซ็น webhook
5. n8n workflow เปิดและใช้ Production URL หรือไม่
6. Shared Secret และ Credentials ในทุก node ตรงกันหรือไม่
7. OpenAI credential มีสิทธิ์เรียกโมเดลและบัญชี API ใช้งานได้หรือไม่
8. หากงานค้าง ดูสถานะ recovery workflow และ Cron Secret

ค่าเริ่มต้นไม่เก็บ execution payload ใน n8n เพื่อลดการทำสำเนาข้อมูลลูกค้า
ถ้าจะเปิดบันทึกสำหรับ debug ให้ใช้บัญชีทดสอบและลบข้อมูลทดสอบหลังตรวจ
