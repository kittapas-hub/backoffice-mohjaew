"use server";
import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/auth";
import { validUuid } from "@/lib/line-chat";
import { setChatMode } from "@/lib/line-chat-server";
export async function changeChatMode(form: FormData) {
  await requireAdmin();
  const id = form.get("conversationId");
  const mode = form.get("mode");
  if (!validUuid(id) || (mode !== "bot" && mode !== "human")) throw new Error("ข้อมูลไม่ถูกต้อง");
  if (!await setChatMode(id, mode)) throw new Error("ไม่พบบทสนทนา");
  revalidatePath("/admin/chat");
}
