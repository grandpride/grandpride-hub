-- =====================================================================
--  GRANDPRIDE EMPLOYEE — v1.6 Documents & SOP with read-and-sign (additive)
--  * private storage bucket 'emp-docs' (PDFs) — staff can read via short-lived
--    signed links, only management (Admin / HOD / Manager / approver) can upload
--  * gp_emp_docs      : the document list (title, category, file path, version)
--  * gp_emp_doc_acks  : "I have read & understood" + signature, one per person per doc
-- =====================================================================
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('emp-docs', 'emp-docs', false, 52428800, array['application/pdf'])
on conflict (id) do nothing;

drop policy if exists emp_docs_read  on storage.objects;
create policy emp_docs_read on storage.objects for select to authenticated
  using (bucket_id = 'emp-docs' and exists (select 1 from public.gp_staff s where s.auth_id = auth.uid()));
drop policy if exists emp_docs_write on storage.objects;
create policy emp_docs_write on storage.objects for insert to authenticated
  with check (bucket_id = 'emp-docs' and public.gp_emp_is_mgmt());
drop policy if exists emp_docs_update on storage.objects;
create policy emp_docs_update on storage.objects for update to authenticated
  using (bucket_id = 'emp-docs' and public.gp_emp_is_mgmt());
drop policy if exists emp_docs_delete on storage.objects;
create policy emp_docs_delete on storage.objects for delete to authenticated
  using (bucket_id = 'emp-docs' and public.gp_emp_is_mgmt());

create table if not exists public.gp_emp_docs (
  id          text primary key,
  title       text not null,
  category    text not null default 'SOP',
  description text,
  file_path   text not null,
  file_name   text,
  size_bytes  bigint,
  version     int  not null default 1,
  must_sign   boolean not null default true,
  active      boolean not null default true,
  created_by  text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
alter table public.gp_emp_docs enable row level security;
drop policy if exists emp_docs_tbl_read on public.gp_emp_docs;
create policy emp_docs_tbl_read on public.gp_emp_docs for select to authenticated
  using (exists (select 1 from public.gp_staff s where s.auth_id = auth.uid()));
drop policy if exists emp_docs_tbl_write on public.gp_emp_docs;
create policy emp_docs_tbl_write on public.gp_emp_docs for all to authenticated
  using (public.gp_emp_is_mgmt()) with check (public.gp_emp_is_mgmt());

create table if not exists public.gp_emp_doc_acks (
  id        text primary key,            -- doc_id|username
  doc_id    text not null,
  version   int  not null default 1,
  username  text not null,
  name      text,
  sig_url   text,
  signed_at timestamptz not null default now()
);
create index if not exists gp_emp_doc_acks_doc_idx on public.gp_emp_doc_acks(doc_id);
alter table public.gp_emp_doc_acks enable row level security;
drop policy if exists emp_doc_acks_insert on public.gp_emp_doc_acks;
create policy emp_doc_acks_insert on public.gp_emp_doc_acks for insert to authenticated
  with check (username = public.gp_emp_my_username());
drop policy if exists emp_doc_acks_update on public.gp_emp_doc_acks;
create policy emp_doc_acks_update on public.gp_emp_doc_acks for update to authenticated
  using (username = public.gp_emp_my_username()) with check (username = public.gp_emp_my_username());
drop policy if exists emp_doc_acks_read on public.gp_emp_doc_acks;
create policy emp_doc_acks_read on public.gp_emp_doc_acks for select to authenticated
  using (username = public.gp_emp_my_username() or public.gp_emp_is_mgmt());
