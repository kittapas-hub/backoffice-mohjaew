-- LINE chatbot v2: service-role only. Existing booking/campaign tables are untouched.
create table public.line_chat_conversations (
  id uuid primary key default gen_random_uuid(),
  scope text not null check (scope in ('production','preview')),
  user_id text not null check (user_id ~ '^U[0-9a-fA-F]{32}$'),
  mode text not null default 'bot' check (mode in ('bot','human')),
  revision bigint not null default 0,
  updated_at timestamptz not null default now(),
  unique(scope,user_id)
);
create table public.line_chat_jobs (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.line_chat_conversations(id) on delete cascade,
  event_id text not null check (length(event_id) between 1 and 128),
  user_text text not null check (length(user_text) between 1 and 5000),
  reply_token text not null,
  event_timestamp bigint not null,
  status text not null default 'pending' check(status in ('pending','processing','ready','sending','sent','cancelled','failed','unknown')),
  reply_text text check(length(reply_text) between 1 and 5000),
  lease_token uuid,
  lease_until timestamptz,
  revision bigint,
  attempts int not null default 0,
  delivery_attempts int not null default 0,
  transport text check(transport in ('reply','push')),
  retry_key uuid not null default gen_random_uuid(),
  next_attempt_at timestamptz not null default now(),
  error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(conversation_id,event_id)
);
create index line_chat_jobs_due on public.line_chat_jobs(status,next_attempt_at);
create index line_chat_jobs_history on public.line_chat_jobs(conversation_id,created_at,id);
alter table public.line_chat_conversations enable row level security;
alter table public.line_chat_jobs enable row level security;
revoke all on public.line_chat_conversations, public.line_chat_jobs from public, anon, authenticated;
grant select,insert,update,delete on public.line_chat_conversations,public.line_chat_jobs to service_role;

create function public.line_chat_enqueue(p_scope text,p_user text,p_event text,p_text text,p_token text,p_timestamp bigint)
returns uuid language plpgsql security invoker set search_path=public,pg_temp as $$
declare c public.line_chat_conversations; j uuid;
begin
 insert into public.line_chat_conversations(scope,user_id) values(p_scope,p_user)
 on conflict(scope,user_id) do nothing;
 select * into c from public.line_chat_conversations where scope=p_scope and user_id=p_user for update;
 if not exists(select 1 from public.line_chat_jobs where conversation_id=c.id and event_id=p_event)
 and (select count(*) from public.line_chat_jobs where conversation_id=c.id and created_at>now()-interval '1 minute')>=20 then return null; end if;
 insert into public.line_chat_jobs(conversation_id,event_id,user_text,reply_token,event_timestamp,status)
 values(c.id,p_event,p_text,p_token,p_timestamp,case when c.mode='human' then 'cancelled' else 'pending' end)
 on conflict(conversation_id,event_id) do nothing returning id into j;
 update public.line_chat_conversations set updated_at=now() where id=c.id;
 return j;
end $$;

create function public.line_chat_claim(p_id uuid,p_scope text)
returns jsonb language plpgsql security invoker set search_path=public,pg_temp as $$
declare c public.line_chat_conversations; j public.line_chat_jobs;
begin
 select * into c from public.line_chat_conversations
 where id=(select conversation_id from public.line_chat_jobs where id=p_id) and scope=p_scope for update;
 if not found or c.mode <> 'bot' then return null; end if;
 select * into j from public.line_chat_jobs where id=p_id for update;
 if j.status <> 'pending' or j.next_attempt_at>now() then return null; end if;
 if exists(select 1 from public.line_chat_jobs q where q.conversation_id=c.id and q.id<>j.id
   and q.status in ('pending','processing','ready','sending','unknown')
   and (q.created_at,q.id)<(j.created_at,j.id)) then return null; end if;
 update public.line_chat_jobs set status='processing',attempts=attempts+1,revision=c.revision,
 lease_token=gen_random_uuid(),lease_until=now()+interval '90 seconds',updated_at=now()
 where id=p_id returning * into j;
 return to_jsonb(j);
end $$;

create function public.line_chat_complete(p_id uuid,p_scope text,p_lease uuid,p_reply text,p_error boolean default false)
returns boolean language plpgsql security invoker set search_path=public,pg_temp as $$
declare c public.line_chat_conversations; j public.line_chat_jobs;
begin
 select * into c from public.line_chat_conversations
 where id=(select conversation_id from public.line_chat_jobs where id=p_id) and scope=p_scope for update;
 if not found then return false; end if;
 select * into j from public.line_chat_jobs where id=p_id for update;
 if j.status<>'processing' or j.lease_token<>p_lease or j.lease_until<now() then return false; end if;
 if c.mode<>'bot' or c.revision<>j.revision then
   update public.line_chat_jobs set status='cancelled',reply_token='',lease_until=null,updated_at=now() where id=p_id;
   return false;
 end if;
 if p_error and j.attempts<3 then
   update public.line_chat_jobs set status='pending',lease_token=null,lease_until=null,
   next_attempt_at=now()+interval '15 seconds',error_code='ai_unavailable',updated_at=now() where id=p_id;
   return false;
 end if;
 update public.line_chat_jobs set status='ready',reply_text=case when p_error then
   'ขณะนี้ระบบตอบอัตโนมัติขัดข้องค่ะ กรุณาฝากข้อความไว้ให้แอดมินตรวจสอบ หรือจองผ่านเมนูจองคิวได้ค่ะ'
   else p_reply end, lease_until=null,updated_at=now(),error_code=case when p_error then 'ai_unavailable' else null end
 where id=p_id;
 return true;
end $$;

create function public.line_chat_reserve_delivery(p_id uuid,p_scope text)
returns jsonb language plpgsql security invoker set search_path=public,pg_temp as $$
declare c public.line_chat_conversations; j public.line_chat_jobs;
begin
 select * into c from public.line_chat_conversations
 where id=(select conversation_id from public.line_chat_jobs where id=p_id) and scope=p_scope for update;
 if not found then return null; end if;
 select * into j from public.line_chat_jobs where id=p_id for update;
 if j.status<>'ready' or j.next_attempt_at>now() then return null; end if;
 if c.mode<>'bot' or c.revision<>j.revision then
   update public.line_chat_jobs set status='cancelled',reply_token='',updated_at=now() where id=p_id;
   return null;
 end if;
 update public.line_chat_jobs set status='sending',lease_token=gen_random_uuid(),lease_until=now()+interval '30 seconds',
 delivery_attempts=delivery_attempts+1,
 transport=coalesce(transport,case when event_timestamp > extract(epoch from now()-interval '45 seconds')*1000 then 'reply' else 'push' end),
 updated_at=now() where id=p_id returning * into j;
 return to_jsonb(j)||jsonb_build_object('user_id',c.user_id);
end $$;

create function public.line_chat_delivery_receipt(p_id uuid,p_scope text,p_lease uuid,p_outcome text)
returns boolean language plpgsql security invoker set search_path=public,pg_temp as $$
declare j public.line_chat_jobs;
begin
 select q.* into j from public.line_chat_jobs q join public.line_chat_conversations c on c.id=q.conversation_id
 where q.id=p_id and c.scope=p_scope for update of q;
 if not found or j.status<>'sending' or j.lease_token<>p_lease then return false; end if;
 if p_outcome not in ('sent','retry','failed','unknown','expired_reply') then raise exception 'invalid outcome'; end if;
 update public.line_chat_jobs set
 status=case when p_outcome='expired_reply' then 'ready'
   when p_outcome='retry' and delivery_attempts<5 then 'ready'
   when p_outcome='retry' then 'failed' else p_outcome end,
 transport=case when p_outcome='expired_reply' then 'push' else transport end,
 reply_token=case when p_outcome='sent' then '' else reply_token end,
 next_attempt_at=case when p_outcome='retry' then now()+interval '15 seconds' else now() end,
 error_code=case when p_outcome='sent' then error_code else 'delivery_'||p_outcome end,
 lease_token=null,lease_until=null,updated_at=now()
 where id=p_id;
 return true;
end $$;

create function public.line_chat_set_mode(p_id uuid,p_scope text,p_mode text)
returns boolean language plpgsql security invoker set search_path=public,pg_temp as $$
begin
 if p_mode not in ('bot','human') then raise exception 'invalid mode'; end if;
 perform 1 from public.line_chat_conversations where id=p_id and scope=p_scope for update;
 if not found then return false; end if;
 update public.line_chat_conversations set mode=p_mode,revision=revision+1,updated_at=now() where id=p_id;
 -- Never revive old jobs when resuming. A send already in flight cannot be recalled.
 update public.line_chat_jobs set status='cancelled',reply_token='',lease_token=null,lease_until=null,updated_at=now()
 where conversation_id=p_id and status in ('pending','processing','ready','unknown');
 return true;
end $$;

create function public.line_chat_recover(p_scope text)
returns void language plpgsql security invoker set search_path=public,pg_temp as $$
begin
 -- Lock only expired jobs; never take the conversation lock after a job lock.
 update public.line_chat_jobs j set status=case when attempts>=3 then 'ready' else 'pending' end,
 reply_text=case when attempts>=3 then 'ขณะนี้ระบบตอบอัตโนมัติขัดข้องค่ะ กรุณาฝากข้อความให้แอดมินตรวจสอบค่ะ' else reply_text end,
 next_attempt_at=now(),lease_token=null,lease_until=null,error_code='generation_timeout',updated_at=now()
 from public.line_chat_conversations c
 where j.conversation_id=c.id and c.scope=p_scope and j.status='processing' and j.lease_until<now();
 update public.line_chat_jobs j set status=case when transport='push' and delivery_attempts<5 then 'ready'
   when transport='push' then 'failed' else 'unknown' end,
 next_attempt_at=now(),lease_token=null,lease_until=null,error_code='delivery_timeout',updated_at=now()
 from public.line_chat_conversations c
 where j.conversation_id=c.id and c.scope=p_scope and j.status='sending' and j.lease_until<now();
 -- Retention: remove terminal messages after 30 days, inactive conversations after 90 days.
 delete from public.line_chat_jobs j using public.line_chat_conversations c
 where j.conversation_id=c.id and c.scope=p_scope and j.status in ('sent','cancelled','failed')
 and j.updated_at<now()-interval '30 days';
 delete from public.line_chat_conversations c where scope=p_scope and updated_at<now()-interval '90 days'
 and not exists(select 1 from public.line_chat_jobs j where j.conversation_id=c.id);
end $$;

revoke all on function public.line_chat_enqueue(text,text,text,text,text,bigint),
 public.line_chat_claim(uuid,text),public.line_chat_complete(uuid,text,uuid,text,boolean),
 public.line_chat_reserve_delivery(uuid,text),public.line_chat_delivery_receipt(uuid,text,uuid,text),
 public.line_chat_set_mode(uuid,text,text),public.line_chat_recover(text) from public,anon,authenticated;
grant execute on function public.line_chat_enqueue(text,text,text,text,text,bigint),
 public.line_chat_claim(uuid,text),public.line_chat_complete(uuid,text,uuid,text,boolean),
 public.line_chat_reserve_delivery(uuid,text),public.line_chat_delivery_receipt(uuid,text,uuid,text),
 public.line_chat_set_mode(uuid,text,text),public.line_chat_recover(text) to service_role;
