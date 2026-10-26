-- Supabase authentication and authorization setup for Coaching Center Management.
-- The existing SQLite schema and application data intentionally do not belong here.

-- 1. Role system: one authoritative application role per Supabase Auth user.
create table if not exists public.user_roles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references auth.users(id) on delete cascade,
  role text not null check (role in ('super_admin', 'staff')),
  created_at timestamptz not null default now()
);

create index if not exists user_roles_user_id_idx
  on public.user_roles (user_id);

alter table public.user_roles enable row level security;

-- The backend reads a user's own role with that user's access token.
-- Inserts, updates, and deletes are intentionally service-role-only.
drop policy if exists "Users can read their own role" on public.user_roles;
create policy "Users can read their own role"
  on public.user_roles
  for select
  to authenticated
  using ((select auth.uid()) = user_id);

-- 2. Staff Application functionality: only pending applications can be
-- submitted publicly. Review actions run on the backend with the service role.
create table if not exists public.staff_applications (
  id uuid primary key default gen_random_uuid(),
  full_name text not null,
  email text not null,
  notes text,
  status text not null default 'pending'
    check (status in ('pending', 'approved', 'rejected')),
  user_id uuid references auth.users(id) on delete set null,
  reviewed_by uuid references auth.users(id) on delete set null,
  reviewed_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists staff_applications_status_created_at_idx
  on public.staff_applications (status, created_at desc);

create index if not exists staff_applications_email_idx
  on public.staff_applications (lower(email));

alter table public.staff_applications enable row level security;

drop policy if exists "Anyone can submit a pending staff application"
  on public.staff_applications;
create policy "Anyone can submit a pending staff application"
  on public.staff_applications
  for insert
  to anon, authenticated
  with check (
    status = 'pending'
    and user_id is null
    and reviewed_by is null
    and reviewed_at is null
  );

-- 3. Initial Super Admin assignment.
-- Create the first user in Supabase Auth, then replace the placeholder email
-- below and run this statement once in the Supabase SQL Editor.
insert into public.user_roles (user_id, role)
select id, 'super_admin'
from auth.users
where lower(email) = lower('faizulislamdk@gmail.com')
on conflict (user_id) do update
set role = excluded.role;

-- 4. Security: no public policy can read, approve, reject, or mutate reviewed
-- applications. The server uses SUPABASE_SERVICE_ROLE_KEY for those actions;
-- new super admin set korar sql
INSERT INTO public.user_roles (user_id, role)
SELECT id, 'super_admin'
FROM auth.users
WHERE lower(email) = lower('newemail@example.com')
ON CONFLICT (user_id)
DO UPDATE SET role = 'super_admin';
--staff application zero korar sql code