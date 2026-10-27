import { Router } from 'express';
import { createClient } from '@supabase/supabase-js';
import { getTeacherContext } from './auth.js';

const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
const configured = Boolean(SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY);

if (!configured) {
  console.warn('[staffAdmin] SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing in .env');
}

const admin = configured ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY) : null;

export async function requireApproved(req, res, next) {
  if (!admin) {
    return res.status(503).json({
      success: false,
      error: 'Authentication not configured',
      message: 'Supabase is not configured.'
    });
  }

  const authHeader = req.headers.authorization || '';
  const token = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (!token) {
    return res.status(401).json({
      success: false,
      error: 'Unauthorized',
      message: 'Authentication required. Please sign in.'
    });
  }

  try {
    const { data, error } = await admin.auth.getUser(token);
    const user = data?.user;
    if (error || !user) {
      return res.status(401).json({
        success: false,
        error: 'Unauthorized',
        message: 'Invalid or expired session.'
      });
    }

    const { data: roleRow, error: roleError } = await admin.from('user_roles')
      .select('role').eq('user_id', user.id).maybeSingle();

    if (roleError || !roleRow?.role) {
      return res.status(403).json({
        success: false,
        error: 'Forbidden',
        message: 'Awaiting approval or role not assigned.'
      });
    }

    let teacherContext = null;
    if (roleRow.role === 'teacher') {
      teacherContext = getTeacherContext(user.id);
      if (!teacherContext) {
        return res.status(403).json({
          success: false,
          error: 'Forbidden',
          message: 'Teacher profile is inactive or not found.'
        });
      }
    }

    req.user = user;
    req.role = roleRow.role;
    req.teacherContext = teacherContext;
    req.auth = { accessToken: token, user, role: roleRow.role, teacherContext };
    next();
  } catch (err) {
    console.error('requireApproved error:', err);
    return res.status(401).json({
      success: false,
      error: 'Unauthorized',
      message: 'Authentication verification failed.'
    });
  }
}

export const requireSuperAdmin = [
  requireApproved,
  (req, res, next) => {
    if (req.role !== 'super_admin') {
      return res.status(403).json({
        success: false,
        error: 'Forbidden',
        message: 'Forbidden. Super Admin access required.'
      });
    }
    next();
  }
];

export const staffAdminRouter = Router();

// Who am I
staffAdminRouter.get('/me', requireApproved, (req, res) => {
  res.json({
    success: true,
    data: {
      email: req.user.email,
      role: req.role,
      user: {
        id: req.user.id,
        email: req.user.email,
        name: req.user.user_metadata?.full_name || req.user.user_metadata?.name || ''
      },
      teacher: req.teacherContext ? {
        id: req.teacherContext.teacher.id,
        name: req.teacherContext.teacher.name,
        stream: req.teacherContext.teacher.stream,
        assigned_subject_ids: Array.from(req.teacherContext.assignedSubjectIds || []),
        assigned_class_ids: Array.from(req.teacherContext.assignedClassIds || []),
        class_teacher_class_ids: Array.from(req.teacherContext.classTeacherClassIds || [])
      } : null
    }
  });
});

// List applications (?status=pending|approved|rejected|all, default all)
staffAdminRouter.get(
  ['/staff-applications', '/admin/staff-applications'],
  requireSuperAdmin,
  async (req, res) => {
    try {
      const status = req.query.status || 'all';
      let query = admin.from('staff_applications').select('*').order('created_at', { ascending: false });
      if (status !== 'all') {
        query = query.eq('status', status);
      }

      const { data, error } = await query;
      if (error) {
        return res.status(500).json({ success: false, error: 'Database error', message: error.message });
      }
      res.json({ success: true, data: data || [] });
    } catch (err) {
      console.error('List staff applications error:', err);
      res.status(500).json({ success: false, error: 'Server error', message: err.message });
    }
  }
);

// Helper to find a user by email in auth.users
async function findUserByEmail(email) {
  if (!email) return null;
  try {
    const { data } = await admin.auth.admin.listUsers();
    return data?.users?.find(
      u => String(u.email || '').toLowerCase() === String(email).toLowerCase()
    ) || null;
  } catch (e) {
    console.warn('findUserByEmail warning:', e);
    return null;
  }
}

// Approve: grants staff role (sends invite if applicant has no account yet)
staffAdminRouter.post(
  ['/staff-applications/:id/approve', '/admin/staff-applications/:id/approve'],
  requireSuperAdmin,
  async (req, res) => {
    try {
      const { data: appRow, error: fetchErr } = await admin.from('staff_applications')
        .select('*').eq('id', req.params.id).maybeSingle();

      if (fetchErr) {
        return res.status(500).json({ success: false, message: fetchErr.message });
      }
      if (!appRow) {
        try {
          const { data: teacherApp } = await admin.from('teacher_applications')
            .select('id').eq('id', req.params.id).maybeSingle();
          if (teacherApp) {
            return res.status(400).json({
              success: false,
              message: 'This is a Teacher application. Please process it using the Teacher application approval workflow.',
              is_teacher_application: true
            });
          }
        } catch (e) {}
        return res.status(404).json({ success: false, message: 'Application not found.' });
      }

      let userId = appRow.user_id;

      if (!userId) {
        // 1. Check if an auth user already exists with this email
        const existingUser = await findUserByEmail(appRow.email);
        if (existingUser) {
          userId = existingUser.id;
          await admin.from('staff_applications').update({ user_id: userId }).eq('id', appRow.id);
        } else {
          // 2. Try to invite user by email
          const { data: invited, error: inviteError } = await admin.auth.admin.inviteUserByEmail(appRow.email, {
            data: { full_name: appRow.full_name }
          });

          if (!inviteError && invited?.user?.id) {
            userId = invited.user.id;
          } else {
            // 3. If invitation fails (e.g. SMTP not configured or domain policy), create user directly
            const { data: created, error: createError } = await admin.auth.admin.createUser({
              email: appRow.email,
              email_confirm: true,
              user_metadata: { full_name: appRow.full_name }
            });

            if (!createError && created?.user?.id) {
              userId = created.user.id;
            } else {
              const retryUser = await findUserByEmail(appRow.email);
              if (retryUser) {
                userId = retryUser.id;
              } else {
                return res.status(500).json({
                  success: false,
                  message: inviteError?.message || createError?.message || 'Could not find or create auth user for applicant.'
                });
              }
            }
          }

          if (userId) {
            await admin.from('staff_applications').update({ user_id: userId }).eq('id', appRow.id);
          }
        }
      }

      if (!userId) {
        return res.status(500).json({ success: false, message: 'Could not determine user account for this applicant.' });
      }

      // Check existing role
      const { data: existingRoleRow, error: roleQueryErr } = await admin.from('user_roles')
        .select('id, role').eq('user_id', userId).maybeSingle();

      if (roleQueryErr) {
        return res.status(500).json({ success: false, message: roleQueryErr.message });
      }

      if (existingRoleRow) {
        // If already super_admin, do not downgrade; otherwise ensure role is staff
        if (existingRoleRow.role !== 'super_admin') {
          const { error: updRoleErr } = await admin.from('user_roles')
            .update({ role: 'staff' }).eq('id', existingRoleRow.id);
          if (updRoleErr) return res.status(500).json({ success: false, message: updRoleErr.message });
        }
      } else {
        const { error: insRoleErr } = await admin.from('user_roles')
          .insert({ user_id: userId, role: 'staff' });
        if (insRoleErr) return res.status(500).json({ success: false, message: insRoleErr.message });
      }

      // Mark application as approved
      const { error: appUpdErr } = await admin.from('staff_applications').update({
        status: 'approved',
        user_id: userId,
        reviewed_by: req.user.id,
        reviewed_at: new Date().toISOString()
      }).eq('id', appRow.id);

      if (appUpdErr) {
        return res.status(500).json({ success: false, message: appUpdErr.message });
      }

      res.json({
        success: true,
        message: existingRoleRow?.role === 'super_admin'
          ? 'Application approved; existing Super Admin role was preserved.'
          : 'Staff application approved successfully.'
      });
    } catch (err) {
      console.error('Approve application error:', err);
      res.status(500).json({ success: false, message: err.message || 'Approval failed.' });
    }
  }
);

// Reject (also removes staff role if they had one, preserving super_admin)
staffAdminRouter.post(
  ['/staff-applications/:id/reject', '/admin/staff-applications/:id/reject'],
  requireSuperAdmin,
  async (req, res) => {
    try {
      const { data: appRow, error: fetchErr } = await admin.from('staff_applications')
        .select('*').eq('id', req.params.id).maybeSingle();

      if (fetchErr) {
        return res.status(500).json({ success: false, message: fetchErr.message });
      }
      if (!appRow) {
        try {
          const { data: teacherApp } = await admin.from('teacher_applications')
            .select('id').eq('id', req.params.id).maybeSingle();
          if (teacherApp) {
            return res.status(400).json({
              success: false,
              message: 'This is a Teacher application. Please process it using the Teacher application rejection workflow.',
              is_teacher_application: true
            });
          }
        } catch (e) {}
        return res.status(404).json({ success: false, message: 'Application not found.' });
      }

      let userId = appRow.user_id;
      if (!userId) {
        const existingUser = await findUserByEmail(appRow.email);
        if (existingUser) userId = existingUser.id;
      }

      if (userId) {
        // Delete only 'staff' role, never delete super_admin
        await admin.from('user_roles').delete()
          .eq('user_id', userId).eq('role', 'staff');
      }

      const { error: appUpdErr } = await admin.from('staff_applications').update({
        status: 'rejected',
        reviewed_by: req.user.id,
        reviewed_at: new Date().toISOString()
      }).eq('id', req.params.id);

      if (appUpdErr) {
        return res.status(500).json({ success: false, message: appUpdErr.message });
      }

      res.json({ success: true, message: 'Staff application rejected.' });
    } catch (err) {
      console.error('Reject application error:', err);
      res.status(500).json({ success: false, message: err.message || 'Rejection failed.' });
    }
  }
);