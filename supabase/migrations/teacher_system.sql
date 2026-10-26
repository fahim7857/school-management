-- ==============================================================================
-- MIGRATION: Teacher System Schema & Authorization
-- Migration File: supabase/migrations/teacher_system.sql
-- Description:
--   1. Safely updates public.user_roles constraint to include 'teacher' role,
--      preserving 'super_admin' and 'staff'.
--   2. Creates public.teacher_applications table with status tracking,
--      structured JSONB class/subject requests, reviewer metadata, indexes,
--      and secure Row Level Security (RLS) policies.
--
-- EXECUTION INSTRUCTIONS:
--   1. Open your Supabase Dashboard: https://supabase.com/dashboard/project/_
--   2. Navigate to "SQL Editor" on the left navigation panel.
--   3. Create a new query, paste this entire file content, and click "Run".
--   4. Verify execution completes with "Success. No rows returned".
-- ==============================================================================

-- 1. Safely update public.user_roles role check constraint
-- Drop any existing check constraint that inspects the 'role' column on public.user_roles.
DO $$
DECLARE
    r RECORD;
BEGIN
    FOR r IN (
        SELECT conname
        FROM pg_constraint
        WHERE conrelid = 'public.user_roles'::regclass
          AND contype = 'c'
          AND pg_get_constraintdef(oid) LIKE '%role%'
    ) LOOP
        EXECUTE 'ALTER TABLE public.user_roles DROP CONSTRAINT ' || quote_ident(r.conname);
    END LOOP;
END $$;

-- Add updated constraint permitting 'super_admin', 'staff', and 'teacher'
ALTER TABLE public.user_roles
  ADD CONSTRAINT user_roles_role_check
  CHECK (role IN ('super_admin', 'staff', 'teacher'));


-- 2. Create public.teacher_applications table
CREATE TABLE IF NOT EXISTS public.teacher_applications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  full_name TEXT NOT NULL,
  email TEXT NOT NULL,
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected')),
  requested_classes JSONB NOT NULL DEFAULT '[]'::jsonb,
  user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  reviewed_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  reviewed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Indexes for performant filtering and lookups
CREATE INDEX IF NOT EXISTS teacher_applications_status_created_at_idx
  ON public.teacher_applications (status, created_at DESC);

CREATE INDEX IF NOT EXISTS teacher_applications_email_idx
  ON public.teacher_applications (lower(email));

CREATE INDEX IF NOT EXISTS teacher_applications_user_id_idx
  ON public.teacher_applications (user_id);


-- 3. Row Level Security (RLS) Configuration
ALTER TABLE public.teacher_applications ENABLE ROW LEVEL SECURITY;

-- Allow anonymous or authenticated applicants to submit a pending teacher application
DROP POLICY IF EXISTS "Anyone can submit a pending teacher application" ON public.teacher_applications;
CREATE POLICY "Anyone can submit a pending teacher application"
  ON public.teacher_applications
  FOR INSERT
  TO anon, authenticated
  WITH CHECK (
    status = 'pending'
    AND reviewed_by IS NULL
    AND reviewed_at IS NULL
  );

-- Allow authenticated applicants to view their own application
DROP POLICY IF EXISTS "Applicants can view their own application" ON public.teacher_applications;
CREATE POLICY "Applicants can view their own application"
  ON public.teacher_applications
  FOR SELECT
  TO authenticated
  USING ((SELECT auth.uid()) = user_id);

-- Note: All review actions (approve, reject, assignment updates) and admin listings
-- are performed server-side by backend endpoints using SUPABASE_SERVICE_ROLE_KEY,
-- which bypasses RLS securely. Public users cannot read other applicants' data
-- or elevate their own roles.
