import express from 'express';
import { db, getNextRollNumber, seedDefaultDataIfEmpty, getMonthsList, getDbPath, getDbDir, initDatabase } from './database.js';
import multer from 'multer';
import fs from 'node:fs';
import path from 'node:path';
import {
  adminSupabaseRequest,
  authenticateRequest,
  getPublicSupabaseConfig,
  getTeacherContext,
  publicSupabaseRequest,
  requireDeletePermission,
  requireSuperAdmin,
  requireStaffOrAdmin
} from './auth.js';

export const apiRouter = express.Router();

const MONTHS = getMonthsList();

// Public Supabase bootstrap, staff application, and teacher application endpoints.
// Every existing application API route is protected immediately below these.
apiRouter.get('/auth/config', (req, res) => {
  const config = getPublicSupabaseConfig();
  if (!config.url || !config.anonKey) {
    return res.status(503).json({
      success: false,
      error: 'Authentication is not configured',
      message: 'The application administrator must configure Supabase before sign-in can be used.'
    });
  }
  return res.json({ success: true, data: config });
});

// Public academic structure for teacher application form
apiRouter.get('/public/teacher-application-options', (req, res) => {
  try {
    const activeYear = getActiveAcademicYear();
    const classes = db.prepare(`
      SELECT c.*, t.name as class_teacher_name
      FROM classes c
      LEFT JOIN teachers t ON c.class_teacher_id = t.id
      WHERE c.academic_year_id = ? AND c.is_active = 1
      ORDER BY c.stream ASC, c.class_number ASC
    `).all(activeYear.id);

    const classIds = classes.map(c => c.id);
    let subjects = [];
    if (classIds.length > 0) {
      subjects = db.prepare(`
        SELECT s.*, ta.teacher_id as currently_assigned_teacher_id, t.name as currently_assigned_teacher_name
        FROM subjects s
        LEFT JOIN teacher_assignments ta ON s.id = ta.subject_id AND ta.is_active = 1
        LEFT JOIN teachers t ON ta.teacher_id = t.id
        WHERE s.class_id IN (${classIds.map(() => '?').join(',')}) AND s.is_active = 1
        ORDER BY s.class_id ASC, s.name ASC
      `).all(...classIds);
    }

    const classesWithSubjects = classes.map(cls => {
      const classSubjects = subjects.filter(s => s.class_id === cls.id);
      return {
        id: cls.id,
        name: cls.name,
        stream: cls.stream,
        class_number: cls.class_number,
        has_class_teacher: Boolean(cls.class_teacher_id),
        class_teacher_name: cls.class_teacher_name || null,
        subjects: classSubjects.map(s => ({
          id: s.id,
          name: s.name,
          code: s.code,
          full_marks: s.full_marks,
          is_assigned: Boolean(s.currently_assigned_teacher_id),
          assigned_teacher_name: s.currently_assigned_teacher_name || null
        }))
      };
    });

    res.json({
      success: true,
      data: {
        academic_year: activeYear,
        classes: classesWithSubjects
      }
    });
  } catch (error) {
    console.error('Error fetching teacher application options:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

apiRouter.post('/staff-applications', async (req, res) => {
  const fullName = String(req.body?.full_name || req.body?.name || '').trim();
  const email = String(req.body?.email || '').trim().toLowerCase();
  const notes = String(req.body?.notes || '').trim() || null;
  const userId = req.body?.user_id || null;

  if (!fullName || !email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({
      success: false,
      error: 'Name and a valid email address are required'
    });
  }

  try {
    // Idempotency guard: never create a second pending application for the same email.
    const existing = await adminSupabaseRequest(
      `/rest/v1/staff_applications?select=id&email=eq.${encodeURIComponent(email)}&status=eq.pending&limit=1`,
      { method: 'GET' }
    );
    if (Array.isArray(existing) && existing.length > 0) {
      return res.status(201).json({
        success: true,
        message: 'Staff application submitted for review.'
      });
    }

    const payload = {
      full_name: fullName,
      email,
      notes,
      status: 'pending'
    };
    if (userId) payload.user_id = userId;

    // Single INSERT. There is no fallback INSERT anywhere in this handler.
    await adminSupabaseRequest('/rest/v1/staff_applications', {
      method: 'POST',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify(payload)
    });

    return res.status(201).json({
      success: true,
      message: 'Staff application submitted for review.'
    });
  } catch (error) {
    console.error('Staff application submission failed:', error);
    return res.status(error.message.startsWith('Supabase is not configured.') ? 503 : 500).json({
      success: false,
      error: 'Unable to submit staff application',
      message: error.message.startsWith('Supabase is not configured.')
        ? 'The application administrator must configure Supabase before applications can be submitted.'
        : 'Please try again later.'
    });
  }
});

apiRouter.post('/teacher-applications', async (req, res) => {
  const fullName = String(req.body?.full_name || req.body?.name || '').trim();
  const email = String(req.body?.email || '').trim().toLowerCase();
  const notes = String(req.body?.notes || '').trim() || null;
  const userId = req.body?.user_id || null;
  const requestedClasses = req.body?.requested_classes;

  if (!fullName || !email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({
      success: false,
      error: 'Name and a valid email address are required'
    });
  }

  if (!Array.isArray(requestedClasses) || requestedClasses.length === 0) {
    return res.status(400).json({
      success: false,
      error: 'At least one class and subject must be selected'
    });
  }

  // Validate requested classes and subjects in SQLite
  const sanitizedRequests = [];
  for (const rc of requestedClasses) {
    const cId = parseInt(rc.class_id, 10);
    if (!cId) continue;
    const cls = db.prepare('SELECT id, name, stream, class_number FROM classes WHERE id = ?').get(cId);
    if (!cls) continue;

    const subjectIds = Array.isArray(rc.subject_ids) ? rc.subject_ids.map(Number).filter(Boolean) : [];
    if (subjectIds.length === 0) continue;

    const validSubjects = [];
    for (const sId of subjectIds) {
      const subj = db.prepare('SELECT id, name, code FROM subjects WHERE id = ? AND class_id = ?').get(sId, cId);
      if (subj) validSubjects.push(subj);
    }
    if (validSubjects.length === 0) continue;

    sanitizedRequests.push({
      class_id: cls.id,
      class_name: cls.name,
      stream: cls.stream,
      subject_ids: validSubjects.map(s => s.id),
      subject_names: validSubjects.map(s => s.name),
      request_class_teacher: Boolean(rc.request_class_teacher)
    });
  }

  if (sanitizedRequests.length === 0) {
    return res.status(400).json({
      success: false,
      error: 'Invalid class or subject selections. Please select valid classes and subjects.'
    });
  }

  try {
    // Idempotency check: don't create multiple pending applications for same email
    const existing = await adminSupabaseRequest(
      `/rest/v1/teacher_applications?select=id&email=eq.${encodeURIComponent(email)}&status=eq.pending&limit=1`,
      { method: 'GET' }
    );
    if (Array.isArray(existing) && existing.length > 0) {
      return res.status(201).json({
        success: true,
        message: 'Teacher application submitted for review.'
      });
    }

    const payload = {
      full_name: fullName,
      email,
      notes,
      status: 'pending',
      requested_classes: sanitizedRequests
    };
    if (userId) payload.user_id = userId;

    await adminSupabaseRequest('/rest/v1/teacher_applications', {
      method: 'POST',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify(payload)
    });

    return res.status(201).json({
      success: true,
      message: 'Teacher application submitted for review.'
    });
  } catch (error) {
    console.error('Teacher application submission failed:', error);
    return res.status(error.message.startsWith('Supabase is not configured.') ? 503 : 500).json({
      success: false,
      error: 'Unable to submit teacher application',
      message: error.message.startsWith('Supabase is not configured.')
        ? 'The application administrator must configure Supabase before applications can be submitted.'
        : 'Please try again later.'
    });
  }
});

// Backend authentication is the source of truth for every existing SQLite API.
apiRouter.use(authenticateRequest);

apiRouter.get('/auth/me', (req, res) => {
  res.json({
    success: true,
    data: {
      user: {
        id: req.auth.user.id,
        email: req.auth.user.email,
        name: req.auth.user.user_metadata?.full_name || req.auth.user.user_metadata?.name || ''
      },
      role: req.auth.role,
      teacher: req.auth.teacherContext ? {
        id: req.auth.teacherContext.teacher.id,
        name: req.auth.teacherContext.teacher.name,
        stream: req.auth.teacherContext.teacher.stream,
        assigned_subject_ids: Array.from(req.auth.teacherContext.assignedSubjectIds || []),
        assigned_class_ids: Array.from(req.auth.teacherContext.assignedClassIds || []),
        class_teacher_class_ids: Array.from(req.auth.teacherContext.classTeacherClassIds || [])
      } : null
    }
  });
});

// ----------------------------------------------------
// SUPER ADMIN STAFF MANAGEMENT
// ----------------------------------------------------
function serviceErrorStatus(error) {
  return error.message.startsWith('Supabase is not configured.') ? 503 : 500;
}

async function findAuthUserByEmail(email) {
  const result = await adminSupabaseRequest('/auth/v1/admin/users?page=1&per_page=1000', { method: 'GET' });
  const users = Array.isArray(result) ? result : result?.users || [];
  return users.find(user => String(user.email || '').toLowerCase() === email.toLowerCase()) || null;
}

async function getStaffApplication(id) {
  const rows = await adminSupabaseRequest(
    `/rest/v1/staff_applications?select=*&id=eq.${encodeURIComponent(id)}&limit=1`,
    { method: 'GET' }
  );
  return Array.isArray(rows) ? rows[0] : null;
}

apiRouter.get('/admin/staff-applications', requireSuperAdmin, async (req, res) => {
  try {
    const rows = await adminSupabaseRequest(
      '/rest/v1/staff_applications?select=*&order=created_at.desc',
      { method: 'GET' }
    );
    return res.json({ success: true, data: Array.isArray(rows) ? rows : [] });
  } catch (error) {
    console.error('Staff application list failed:', error);
    return res.status(serviceErrorStatus(error)).json({
      success: false,
      error: 'Unable to load staff applications'
    });
  }
});

apiRouter.post('/admin/staff-applications/:id/approve', requireSuperAdmin, async (req, res) => {
  const applicationId = req.params.id;

  try {
    const application = await getStaffApplication(applicationId);
    if (!application) {
      const teacherApp = await getTeacherApplication(applicationId);
      if (teacherApp) {
        return res.status(400).json({
          success: false,
          error: 'This is a Teacher application. Please process it using the Teacher application approval workflow.',
          is_teacher_application: true
        });
      }
      return res.status(404).json({ success: false, error: 'Staff application not found' });
    }
    if (application.status !== 'pending') {
      return res.status(400).json({
        success: false,
        error: `This application is already ${application.status}.`
      });
    }

    let user = await findAuthUserByEmail(application.email);
    if (!user) {
      const invitation = await adminSupabaseRequest('/auth/v1/invite', {
        method: 'POST',
        body: JSON.stringify({
          email: application.email,
          data: { full_name: application.full_name }
        })
      });
      user = invitation?.user || invitation;
    }

    if (!user?.id) {
      throw new Error('Supabase did not return an Auth user for the approved application.');
    }

    // Admin approval replaces email verification: mark the user's email as confirmed
    // so an approved staff member can sign in without clicking a confirmation link.
    if (!user.email_confirmed_at && !user.confirmed_at) {
      await adminSupabaseRequest(`/auth/v1/admin/users/${encodeURIComponent(user.id)}`, {
        method: 'PUT',
        body: JSON.stringify({ email_confirm: true })
      });
    }

    const existingRoles = await adminSupabaseRequest(
      `/rest/v1/user_roles?select=role&user_id=eq.${encodeURIComponent(user.id)}&limit=1`,
      { method: 'GET' }
    );
    const existingRole = Array.isArray(existingRoles) ? existingRoles[0]?.role : null;
    if (existingRole !== 'super_admin') {
      await adminSupabaseRequest('/rest/v1/user_roles', {
        method: 'POST',
        headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify({ user_id: user.id, role: 'staff' })
      });
    }

    await adminSupabaseRequest(
      `/rest/v1/staff_applications?id=eq.${encodeURIComponent(applicationId)}`,
      {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({
          status: 'approved',
          user_id: user.id,
          reviewed_by: req.auth.user.id,
          reviewed_at: new Date().toISOString()
        })
      }
    );

    return res.json({
      success: true,
      message: existingRole === 'super_admin'
        ? 'Application approved; the existing Super Admin role was preserved.'
        : 'Application approved and Staff access assigned.'
    });
  } catch (error) {
    console.error('Staff application approval failed:', error);
    return res.status(serviceErrorStatus(error)).json({
      success: false,
      error: 'Unable to approve staff application',
      message: error.message.includes('invite')
        ? 'The application was not approved because the Supabase invitation could not be created.'
        : undefined
    });
  }
});

apiRouter.post('/admin/staff-applications/:id/reject', requireSuperAdmin, async (req, res) => {
  const applicationId = req.params.id;

  try {
    const application = await getStaffApplication(applicationId);
    if (!application) {
      const teacherApp = await getTeacherApplication(applicationId);
      if (teacherApp) {
        return res.status(400).json({
          success: false,
          error: 'This is a Teacher application. Please process it using the Teacher application rejection workflow.',
          is_teacher_application: true
        });
      }
      return res.status(404).json({ success: false, error: 'Staff application not found' });
    }
    if (application.status !== 'pending') {
      return res.status(400).json({
        success: false,
        error: `This application is already ${application.status}.`
      });
    }

    await adminSupabaseRequest(
      `/rest/v1/staff_applications?id=eq.${encodeURIComponent(applicationId)}`,
      {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({
          status: 'rejected',
          reviewed_by: req.auth.user.id,
          reviewed_at: new Date().toISOString()
        })
      }
    );

    return res.json({ success: true, message: 'Staff application rejected.' });
  } catch (error) {
    console.error('Staff application rejection failed:', error);
    return res.status(serviceErrorStatus(error)).json({
      success: false,
      error: 'Unable to reject staff application'
    });
  }
});

// ----------------------------------------------------
// SUPER ADMIN TEACHER APPLICATION & ASSIGNMENT MANAGEMENT
// ----------------------------------------------------
async function getTeacherApplication(id) {
  const rows = await adminSupabaseRequest(
    `/rest/v1/teacher_applications?select=*&id=eq.${encodeURIComponent(id)}&limit=1`,
    { method: 'GET' }
  );
  return Array.isArray(rows) ? rows[0] : null;
}

function analyzeTeacherApplicationConflicts(requestedClasses, currentTeacherId = null) {
  const conflicts = [];
  if (!Array.isArray(requestedClasses)) return conflicts;

  for (const rc of requestedClasses) {
    const classId = parseInt(rc.class_id, 10);
    const cls = db.prepare('SELECT * FROM classes WHERE id = ?').get(classId);
    if (!cls) continue;

    // Check Class Teacher conflict
    if (rc.request_class_teacher) {
      if (cls.class_teacher_id && (!currentTeacherId || cls.class_teacher_id !== currentTeacherId)) {
        const ct = db.prepare('SELECT name, phone FROM teachers WHERE id = ?').get(cls.class_teacher_id);
        conflicts.push({
          type: 'class_teacher',
          class_id: cls.id,
          class_name: cls.name,
          stream: cls.stream,
          message: `${cls.stream} ${cls.name} already has an active Class Teacher: ${ct ? ct.name : 'ID ' + cls.class_teacher_id}`
        });
      }
    }

    // Check Subject assignment conflicts
    const subjectIds = Array.isArray(rc.subject_ids) ? rc.subject_ids.map(Number).filter(Boolean) : [];
    for (const sId of subjectIds) {
      const subj = db.prepare('SELECT id, name FROM subjects WHERE id = ?').get(sId);
      if (!subj) continue;

      const assignRow = db.prepare(`
        SELECT ta.*, t.name as teacher_name
        FROM teacher_assignments ta
        JOIN teachers t ON ta.teacher_id = t.id
        WHERE ta.subject_id = ? AND ta.is_active = 1
      `).get(sId);

      if (assignRow && (!currentTeacherId || assignRow.teacher_id !== currentTeacherId)) {
        conflicts.push({
          type: 'subject_assignment',
          class_id: cls.id,
          class_name: cls.name,
          stream: cls.stream,
          subject_id: subj.id,
          subject_name: subj.name,
          existing_teacher_id: assignRow.teacher_id,
          existing_teacher_name: assignRow.teacher_name,
          message: `Subject "${subj.name}" in ${cls.stream} ${cls.name} is already assigned to "${assignRow.teacher_name}".`
        });
      }
    }
  }

  return conflicts;
}

apiRouter.get('/admin/teacher-applications', requireSuperAdmin, async (req, res) => {
  try {
    const status = req.query.status || 'all';
    let url = '/rest/v1/teacher_applications?select=*&order=created_at.desc';
    if (status !== 'all') {
      url += `&status=eq.${encodeURIComponent(status)}`;
    }
    const rows = await adminSupabaseRequest(url, { method: 'GET' });
    const list = Array.isArray(rows) ? rows : [];

    const enriched = list.map(app => {
      let requested = app.requested_classes;
      if (typeof requested === 'string') {
        try { requested = JSON.parse(requested); } catch (e) { requested = []; }
      }
      const conflicts = app.status === 'pending' ? analyzeTeacherApplicationConflicts(requested) : [];
      return {
        ...app,
        requested_classes: requested || [],
        conflicts
      };
    });

    return res.json({ success: true, data: enriched });
  } catch (error) {
    console.error('Teacher applications list failed:', error);
    return res.status(serviceErrorStatus(error)).json({
      success: false,
      error: 'Unable to load teacher applications',
      message: error.message
    });
  }
});

apiRouter.get('/admin/teacher-assignments/conflicts', requireSuperAdmin, (req, res) => {
  try {
    const classId = req.query.class_id ? parseInt(req.query.class_id, 10) : null;
    const subjectId = req.query.subject_id ? parseInt(req.query.subject_id, 10) : null;
    const teacherId = req.query.teacher_id ? parseInt(req.query.teacher_id, 10) : null;

    let conflicts = [];
    if (subjectId) {
      const assignRow = db.prepare(`
        SELECT ta.*, t.name as teacher_name, s.name as subject_name
        FROM teacher_assignments ta
        JOIN teachers t ON ta.teacher_id = t.id
        JOIN subjects s ON ta.subject_id = s.id
        WHERE ta.subject_id = ? AND ta.is_active = 1
      `).get(subjectId);
      if (assignRow && (!teacherId || assignRow.teacher_id !== teacherId)) {
        conflicts.push({
          type: 'subject_assignment',
          message: `Subject "${assignRow.subject_name}" is currently assigned to "${assignRow.teacher_name}".`
        });
      }
    }

    if (classId) {
      const cls = db.prepare('SELECT c.*, t.name as class_teacher_name FROM classes c LEFT JOIN teachers t ON c.class_teacher_id = t.id WHERE c.id = ?').get(classId);
      if (cls && cls.class_teacher_id && (!teacherId || cls.class_teacher_id !== teacherId)) {
        conflicts.push({
          type: 'class_teacher',
          message: `${cls.stream} ${cls.name} already has Class Teacher "${cls.class_teacher_name}".`
        });
      }
    }

    res.json({ success: true, conflicts });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

apiRouter.post('/admin/teacher-applications/:id/approve', requireSuperAdmin, async (req, res) => {
  const applicationId = req.params.id;
  const { override_conflicts = true, custom_assignments } = req.body || {};

  try {
    const application = await getTeacherApplication(applicationId);
    if (!application) {
      const staffApp = await getStaffApplication(applicationId);
      if (staffApp) {
        return res.status(400).json({
          success: false,
          error: 'This is a Staff application. Please process it using the Staff application approval workflow.',
          is_staff_application: true
        });
      }
      return res.status(404).json({ success: false, error: 'Teacher application not found' });
    }

    let requested = custom_assignments || application.requested_classes;
    if (typeof requested === 'string') {
      try { requested = JSON.parse(requested); } catch (e) { requested = []; }
    }
    if (!Array.isArray(requested)) requested = [];

    // Check conflicts if override_conflicts is explicitly false
    if (override_conflicts === false) {
      const conflicts = analyzeTeacherApplicationConflicts(requested);
      if (conflicts.length > 0) {
        return res.status(409).json({
          success: false,
          error: 'Assignment conflicts detected',
          conflicts
        });
      }
    }

    // Step A: Inspect Current Provisioning State across both databases
    // 1. Locate Auth User in Supabase
    let user = application.user_id ? { id: application.user_id, email: application.email } : null;
    if (!user) {
      user = await findAuthUserByEmail(application.email);
    }

    // 2. Check Supabase user_roles
    let existingRole = null;
    if (user?.id) {
      try {
        const roles = await adminSupabaseRequest(
          `/rest/v1/user_roles?select=role&user_id=eq.${encodeURIComponent(user.id)}&limit=1`,
          { method: 'GET' }
        );
        existingRole = Array.isArray(roles) && roles.length > 0 ? roles[0]?.role : null;
      } catch (roleLookupErr) {
        existingRole = null;
      }
    }
    const hasValidRole = existingRole === 'teacher' || existingRole === 'super_admin';

    // 3. Check SQLite Teacher profile
    let teacher = user?.id ? db.prepare('SELECT * FROM teachers WHERE user_id = ?').get(user.id) : null;
    if (!teacher) {
      teacher = db.prepare('SELECT * FROM teachers WHERE email = ?').get(application.email);
    }
    const isTeacherProfileIntact = Boolean(teacher && teacher.is_active == 1 && String(teacher.status).toLowerCase() === 'active');

    // 4. Check requested subject assignments in SQLite
    let allRequestedSubjectsPresent = true;
    if (teacher) {
      for (const rc of requested) {
        const sIds = Array.isArray(rc.subject_ids) ? rc.subject_ids.map(Number).filter(Boolean) : [];
        for (const sId of sIds) {
          const assign = db.prepare('SELECT id FROM teacher_assignments WHERE teacher_id = ? AND subject_id = ? AND is_active = 1').get(teacher.id, sId);
          if (!assign) {
            allRequestedSubjectsPresent = false;
            break;
          }
        }
        if (!allRequestedSubjectsPresent) break;
      }
    } else {
      allRequestedSubjectsPresent = false;
    }

    // 5. Check requested Class Teacher assignments in SQLite
    let allRequestedClassTeachersPresent = true;
    if (teacher) {
      for (const rc of requested) {
        if (rc.request_class_teacher) {
          const cls = db.prepare('SELECT class_teacher_id FROM classes WHERE id = ?').get(parseInt(rc.class_id, 10));
          if (!cls || cls.class_teacher_id !== teacher.id) {
            allRequestedClassTeachersPresent = false;
            break;
          }
        }
      }
    } else {
      allRequestedClassTeachersPresent = false;
    }

    // 6. Check verified teacher context
    const tc = user?.id ? getTeacherContext(user.id) : null;
    const isTeacherContextValid = Boolean(tc);

    // Early-return ONLY if application is marked approved AND all provisioning is present and consistent
    if (
      application.status === 'approved' &&
      user?.id &&
      hasValidRole &&
      isTeacherProfileIntact &&
      allRequestedSubjectsPresent &&
      allRequestedClassTeachersPresent &&
      isTeacherContextValid
    ) {
      return res.json({
        success: true,
        message: 'Application is already approved and all provisioning is fully consistent.',
        data: {
          teacher_id: teacher.id,
          user_id: user.id
        }
      });
    }

    // If provisioning is incomplete, safely resume ONLY the missing steps
    // ---------------------------------------------------------------
    // 1. Resume Supabase Auth User (if missing)
    if (!user?.id) {
      user = await findAuthUserByEmail(application.email);
      if (!user) {
        try {
          const invitation = await adminSupabaseRequest('/auth/v1/invite', {
            method: 'POST',
            body: JSON.stringify({
              email: application.email,
              data: { full_name: application.full_name }
            })
          });
          user = invitation?.user || invitation;
        } catch (inviteErr) {
          user = await findAuthUserByEmail(application.email);
        }
      }

      if (!user?.id) {
        try {
          const created = await adminSupabaseRequest('/auth/v1/admin/users', {
            method: 'POST',
            body: JSON.stringify({
              email: application.email,
              email_confirm: true,
              user_metadata: { full_name: application.full_name }
            })
          });
          user = created?.user || created;
        } catch (createErr) {
          user = await findAuthUserByEmail(application.email);
        }
      }

      if (!user?.id) {
        throw new Error('Supabase did not return an Auth user for the approved application.');
      }
    }

    // Confirm email so teacher can sign in directly
    if (!user.email_confirmed_at && !user.confirmed_at) {
      try {
        await adminSupabaseRequest(`/auth/v1/admin/users/${encodeURIComponent(user.id)}`, {
          method: 'PUT',
          body: JSON.stringify({ email_confirm: true })
        });
      } catch (confirmErr) {
        console.warn('Could not confirm user email directly:', confirmErr.message);
      }
    }

    // 2. Resume SQLite Provisioning (if profile, assignments, or class teacher are missing)
    // Note: Cross-database transactions across SQLite and Supabase are not natively supported;
    // local changes are kept strictly atomic via SQLite transaction and validated before granting roles.
    let teacherId = teacher?.id || null;
    const needsSqliteProvisioning = !isTeacherProfileIntact || !allRequestedSubjectsPresent || !allRequestedClassTeachersPresent || !isTeacherContextValid;

    if (needsSqliteProvisioning) {
      db.exec('BEGIN TRANSACTION;');
      try {
        const matchingTeachers = db.prepare('SELECT * FROM teachers WHERE user_id = ? OR email = ?').all(user.id, application.email);

        if (matchingTeachers.length > 0) {
          const primary = matchingTeachers.find(t => t.user_id === user.id) || matchingTeachers[0];
          teacherId = primary.id;

          db.prepare(`
            UPDATE teachers
            SET name = ?, email = ?, user_id = ?, status = 'Active', is_active = 1
            WHERE id = ?
          `).run(application.full_name.trim(), application.email.trim(), user.id, teacherId);

          for (const duplicate of matchingTeachers) {
            if (duplicate.id !== teacherId) {
              db.prepare("UPDATE teachers SET is_active = 0, status = 'Inactive', user_id = NULL WHERE id = ?").run(duplicate.id);
            }
          }
        } else {
          const stream = requested[0]?.stream || 'General';
          const resIns = db.prepare(`
            INSERT INTO teachers (name, email, user_id, status, is_active, stream)
            VALUES (?, ?, ?, 'Active', 1, ?)
          `).run(application.full_name.trim(), application.email.trim(), user.id, stream);
          teacherId = Number(resIns.lastInsertRowid);
        }

        // Provision Subject Assignments & Class Teacher roles
        for (const rc of requested) {
          const classId = parseInt(rc.class_id, 10);
          const cls = db.prepare('SELECT * FROM classes WHERE id = ?').get(classId);
          if (!cls) continue;

          if (rc.request_class_teacher) {
            db.prepare('UPDATE classes SET class_teacher_id = ? WHERE id = ?').run(teacherId, classId);
          }

          const subjectIds = Array.isArray(rc.subject_ids) ? rc.subject_ids.map(Number).filter(Boolean) : [];
          for (const sId of subjectIds) {
            const subj = db.prepare('SELECT * FROM subjects WHERE id = ?').get(sId);
            if (!subj) continue;

            // Deactivate any other teacher assigned to this subject
            db.prepare('UPDATE teacher_assignments SET is_active = 0 WHERE subject_id = ? AND teacher_id != ?').run(sId, teacherId);

            // Upsert assignment for this teacher
            const existingAssignments = db.prepare('SELECT id FROM teacher_assignments WHERE teacher_id = ? AND subject_id = ?').all(teacherId, sId);
            if (existingAssignments.length > 0) {
              db.prepare('UPDATE teacher_assignments SET is_active = 1, class_id = ?, stream = ? WHERE id = ?')
                .run(classId, subj.stream || cls.stream, existingAssignments[0].id);
              for (let i = 1; i < existingAssignments.length; i++) {
                db.prepare('DELETE FROM teacher_assignments WHERE id = ?').run(existingAssignments[i].id);
              }
            } else {
              db.prepare(`
                INSERT INTO teacher_assignments (teacher_id, subject_id, class_id, stream, academic_year_id, is_active)
                VALUES (?, ?, ?, ?, ?, 1)
              `).run(teacherId, sId, classId, subj.stream || cls.stream, subj.academic_year_id || cls.academic_year_id || getActiveAcademicYearId());
            }
          }
        }

        // Verify valid context before committing
        const verifiedContext = getTeacherContext(user.id);
        if (!verifiedContext) {
          throw new Error('Local teacher provisioning failed: could not establish active assignments or Class Teacher role for teacher.');
        }

        db.exec('COMMIT;');
      } catch (sqliteErr) {
        db.exec('ROLLBACK;');
        throw sqliteErr;
      }
    } else {
      teacherId = teacher.id;
    }

    // 3. Resume Supabase user_role assignment (if missing)
    // Handles failures occurring after SQLite commit but before role assignment
    if (!hasValidRole) {
      const existingRoles = await adminSupabaseRequest(
        `/rest/v1/user_roles?select=role&user_id=eq.${encodeURIComponent(user.id)}&limit=1`,
        { method: 'GET' }
      );
      const roleFound = Array.isArray(existingRoles) && existingRoles.length > 0 ? existingRoles[0]?.role : null;
      if (roleFound !== 'super_admin') {
        await adminSupabaseRequest('/rest/v1/user_roles', {
          method: 'POST',
          headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
          body: JSON.stringify({ user_id: user.id, role: 'teacher' })
        });
      }
    }

    // 4. Resume Application Status finalization (if not approved or user_id unlinked)
    // Handles failures occurring after SQLite commit or after role creation but before application finalization
    if (application.status !== 'approved' || application.user_id !== user.id) {
      await adminSupabaseRequest(
        `/rest/v1/teacher_applications?id=eq.${encodeURIComponent(applicationId)}`,
        {
          method: 'PATCH',
          headers: { Prefer: 'return=minimal' },
          body: JSON.stringify({
            status: 'approved',
            user_id: user.id,
            reviewed_by: req.auth.user.id,
            reviewed_at: new Date().toISOString()
          })
        }
      );
    }

    return res.json({
      success: true,
      message: existingRole === 'super_admin'
        ? 'Teacher application approved; existing Super Admin role was preserved.'
        : 'Teacher application approved and Teacher access assigned successfully.',
      data: {
        teacher_id: teacherId,
        user_id: user.id
      }
    });
  } catch (error) {
    console.error('Teacher application approval failed:', error);
    return res.status(serviceErrorStatus(error)).json({
      success: false,
      error: 'Unable to approve teacher application',
      message: error.message
    });
  }
});

apiRouter.post('/admin/teacher-applications/:id/reject', requireSuperAdmin, async (req, res) => {
  const applicationId = req.params.id;

  try {
    const application = await getTeacherApplication(applicationId);
    if (!application) {
      const staffApp = await getStaffApplication(applicationId);
      if (staffApp) {
        return res.status(400).json({
          success: false,
          error: 'This is a Staff application. Please process it using the Staff application rejection workflow.',
          is_staff_application: true
        });
      }
      return res.status(404).json({ success: false, error: 'Teacher application not found' });
    }

    let userId = application.user_id;
    if (!userId) {
      const user = await findAuthUserByEmail(application.email);
      if (user) userId = user.id;
    }

    // In Supabase: delete only 'teacher' role, never delete super_admin
    if (userId) {
      try {
        await adminSupabaseRequest(
          `/rest/v1/user_roles?user_id=eq.${encodeURIComponent(userId)}&role=eq.teacher`,
          { method: 'DELETE' }
        );
      } catch (roleErr) {
        console.warn('Could not remove teacher role during rejection:', roleErr.message);
      }
    }

    // In SQLite: deactivate teacher and assignments atomically
    const teacher = (userId ? db.prepare('SELECT id FROM teachers WHERE user_id = ?').get(userId) : null)
      || db.prepare('SELECT id FROM teachers WHERE email = ?').get(application.email);

    if (teacher) {
      db.exec('BEGIN TRANSACTION;');
      try {
        db.prepare("UPDATE teachers SET is_active = 0, status = 'Inactive' WHERE id = ?").run(teacher.id);
        db.prepare('UPDATE teacher_assignments SET is_active = 0 WHERE teacher_id = ?').run(teacher.id);
        db.prepare('UPDATE classes SET class_teacher_id = NULL WHERE class_teacher_id = ?').run(teacher.id);
        db.exec('COMMIT;');
      } catch (txErr) {
        db.exec('ROLLBACK;');
        throw txErr;
      }
    }

    // Update application status to rejected in Supabase
    await adminSupabaseRequest(
      `/rest/v1/teacher_applications?id=eq.${encodeURIComponent(applicationId)}`,
      {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({
          status: 'rejected',
          reviewed_by: req.auth.user.id,
          reviewed_at: new Date().toISOString()
        })
      }
    );

    return res.json({ success: true, message: 'Teacher application rejected.' });
  } catch (error) {
    console.error('Teacher application rejection failed:', error);
    return res.status(serviceErrorStatus(error)).json({
      success: false,
      error: 'Unable to reject teacher application',
      message: error.message
    });
  }
});

// Dhaka, Bangladesh (UTC+6) Timezone Helpers
export function getDhakaDate(d = new Date()) {
  return d.toLocaleDateString('en-CA', { timeZone: 'Asia/Dhaka' });
}

export function getDhakaTime(d = new Date()) {
  return d.toLocaleTimeString('en-US', { timeZone: 'Asia/Dhaka', hour: '2-digit', minute: '2-digit', hour12: true });
}

export function getDateRangeContext(clientDate) {
  const today = (clientDate && /^\d{4}-\d{2}-\d{2}$/.test(clientDate))
    ? clientDate
    : getDhakaDate();

  const [tYear, tMonth, tDay] = today.split('-').map(Number);
  const todayDateObj = new Date(tYear, tMonth - 1, tDay);

  // Week range: Monday to Sunday of the current week containing today
  const dayOfWeek = todayDateObj.getDay(); // 0 is Sunday, 1 is Monday...
  const diffToMonday = todayDateObj.getDate() - dayOfWeek + (dayOfWeek === 0 ? -6 : 1);
  const mondayObj = new Date(tYear, tMonth - 1, diffToMonday);
  const sundayObj = new Date(tYear, tMonth - 1, diffToMonday + 6);

  const weekStart = `${mondayObj.getFullYear()}-${String(mondayObj.getMonth() + 1).padStart(2, '0')}-${String(mondayObj.getDate()).padStart(2, '0')}`;
  const weekEnd = `${sundayObj.getFullYear()}-${String(sundayObj.getMonth() + 1).padStart(2, '0')}-${String(sundayObj.getDate()).padStart(2, '0')}`;

  // Month range: 1st of the month to last day of month
  const monthStart = `${tYear}-${String(tMonth).padStart(2, '0')}-01`;
  const lastDayOfMonth = new Date(tYear, tMonth, 0).getDate();
  const monthEnd = `${tYear}-${String(tMonth).padStart(2, '0')}-${String(lastDayOfMonth).padStart(2, '0')}`;

  return {
    today,
    weekStart,
    weekEnd,
    monthStart,
    monthEnd,
    year: tYear
  };
}

export function getCurrentMonth() {
  const months = getMonthsList();
  const dhakaDateStr = getDhakaDate();
  const mIndex = parseInt(dhakaDateStr.split('-')[1], 10) - 1;
  return months[mIndex] || months[new Date().getMonth()];
}

export function getCurrentMonthIndex() {
  const dhakaDateStr = getDhakaDate();
  return parseInt(dhakaDateStr.split('-')[1], 10) - 1;
}

export function getActiveAcademicYear() {
  const row = db.prepare('SELECT * FROM academic_years WHERE is_active = 1 ORDER BY year DESC LIMIT 1').get();
  if (row) return row;
  const fallback = db.prepare('SELECT * FROM academic_years ORDER BY year DESC LIMIT 1').get();
  if (fallback) return fallback;
  return { id: 1, year: new Date().getFullYear(), name: `Academic Year ${new Date().getFullYear()}`, is_active: 1 };
}

export function resolveAcademicYear(requestedId) {
  if (requestedId !== undefined && requestedId !== null && requestedId !== '') {
    const id = parseInt(requestedId, 10);
    if (!isNaN(id) && id > 0) {
      const row = db.prepare('SELECT * FROM academic_years WHERE id = ?').get(id);
      if (row) return row;
    }
  }
  return getActiveAcademicYear();
}

function getActiveAcademicYearId() {
  return getActiveAcademicYear().id;
}

// ----------------------------------------------------
// ACADEMIC YEARS
// ----------------------------------------------------
apiRouter.get('/academic-years', (req, res) => {
  try {
    const rows = db.prepare('SELECT * FROM academic_years ORDER BY year DESC').all();
    res.json({ success: true, data: rows });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

apiRouter.get('/academic-years/active', (req, res) => {
  try {
    const activeYear = getActiveAcademicYear();
    res.json({ success: true, data: activeYear });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

apiRouter.post('/academic-years', requireSuperAdmin, (req, res) => {
  try {
    const { year, name, start_date, end_date, copy_classes_from } = req.body;
    if (!year || !name) {
      return res.status(400).json({ success: false, error: 'Year and name are required' });
    }

    const yearNum = parseInt(year, 10);
    const existing = db.prepare('SELECT id FROM academic_years WHERE year = ?').get(yearNum);
    if (existing) {
      return res.status(400).json({ success: false, error: `Academic Year ${yearNum} already exists` });
    }

    const startDate = start_date || `${yearNum}-01-01`;
    const endDate = end_date || `${yearNum}-12-31`;

    const insertYear = db.prepare(`
      INSERT INTO academic_years (year, name, start_date, end_date, is_active)
      VALUES (?, ?, ?, ?, 0)
    `);
    const result = insertYear.run(yearNum, name, startDate, endDate);
    const newYearId = Number(result.lastInsertRowid);

    // Fresh Class Structure for the new academic year
    // Do NOT copy any students, rolls, payments, or fee receipts!
    const sourceYearId = copy_classes_from ? parseInt(copy_classes_from, 10) : getActiveAcademicYearId();
    let sourceClasses = db.prepare('SELECT name, class_number, monthly_fee FROM classes WHERE academic_year_id = ? ORDER BY class_number ASC').all(sourceYearId);

    if (!sourceClasses || sourceClasses.length === 0) {
      sourceClasses = [
        { name: 'Class 3', class_number: 3, monthly_fee: 800 },
        { name: 'Class 4', class_number: 4, monthly_fee: 900 },
        { name: 'Class 5', class_number: 5, monthly_fee: 1000 },
        { name: 'Class 6', class_number: 6, monthly_fee: 1100 },
        { name: 'Class 7', class_number: 7, monthly_fee: 1200 }
      ];
    }

    const classInsert = db.prepare(`
      INSERT INTO classes (academic_year_id, name, class_number, monthly_fee)
      VALUES (?, ?, ?, ?)
    `);

    for (const c of sourceClasses) {
      classInsert.run(newYearId, c.name, c.class_number, c.monthly_fee);
    }

    res.json({
      success: true,
      message: `Fresh Academic Year ${yearNum} created with clean class structure`,
      data: { id: newYearId, year: yearNum, name }
    });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

apiRouter.post('/academic-years/:id/activate', requireSuperAdmin, (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const targetYear = db.prepare('SELECT * FROM academic_years WHERE id = ?').get(id);
    if (!targetYear) {
      return res.status(404).json({ success: false, error: 'Academic year not found' });
    }

    db.exec('BEGIN TRANSACTION;');
    try {
      db.prepare('UPDATE academic_years SET is_active = 0').run();
      db.prepare('UPDATE academic_years SET is_active = 1 WHERE id = ?').run(id);
      db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('active_academic_year', String(targetYear.year));
      db.exec('COMMIT;');
    } catch (txErr) {
      db.exec('ROLLBACK;');
      throw txErr;
    }

    res.json({ success: true, message: `Academic Year ${targetYear.year} is now active`, data: targetYear });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

apiRouter.delete('/academic-years/:id', requireDeletePermission, (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const yearRow = db.prepare('SELECT * FROM academic_years WHERE id = ?').get(id);
    if (!yearRow) {
      return res.status(404).json({ success: false, error: 'Academic year not found' });
    }

    const totalYears = db.prepare('SELECT COUNT(*) as count FROM academic_years').get().count;
    if (totalYears <= 1) {
      return res.status(400).json({ success: false, error: 'Cannot delete the only academic year in the system' });
    }

    // Clean up all associated payments, students, and classes for this academic year
    db.prepare('DELETE FROM payments WHERE academic_year_id = ?').run(id);
    db.prepare('DELETE FROM students WHERE academic_year_id = ?').run(id);
    db.prepare('DELETE FROM classes WHERE academic_year_id = ?').run(id);
    db.prepare('DELETE FROM academic_years WHERE id = ?').run(id);

    // If active year was deleted, activate the latest remaining year
    if (yearRow.is_active) {
      const remaining = db.prepare('SELECT id, year FROM academic_years ORDER BY year DESC LIMIT 1').get();
      if (remaining) {
        db.prepare('UPDATE academic_years SET is_active = 1 WHERE id = ?').run(remaining.id);
        db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('active_academic_year', String(remaining.year));
      }
    }

    res.json({
      success: true,
      message: `Academic Year ${yearRow.year} and all its associated data were deleted successfully`
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ----------------------------------------------------
// CLASSES
// ----------------------------------------------------
apiRouter.get('/classes', (req, res) => {
  try {
    const academicYearId = resolveAcademicYear(req.query.academic_year_id).id;
    const stream = req.query.stream;

    let sql = `
      SELECT c.*, 
        COALESCE(c.stream, 'General') as stream,
        (SELECT COUNT(*) FROM students s WHERE s.class_id = c.id) as student_count
      FROM classes c
      WHERE c.academic_year_id = ?
    `;
    const params = [academicYearId];

    if (stream) {
      sql += " AND LOWER(COALESCE(c.stream, 'General')) = LOWER(?)";
      params.push(stream);
    }

    sql += ' ORDER BY c.stream ASC, c.class_number ASC';

    const classes = db.prepare(sql).all(...params);
    res.json({ success: true, data: classes });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

apiRouter.post('/classes', (req, res) => {
  try {
    const { academic_year_id, name, class_number, monthly_fee, stream } = req.body;
    const ayId = resolveAcademicYear(academic_year_id).id;
    const cNum = parseInt(class_number, 10);
    const fee = parseFloat(monthly_fee);
    const classStream = (stream && stream.toLowerCase() === 'hifz') ? 'Hifz' : 'General';

    if (!name || !name.trim() || isNaN(cNum) || isNaN(fee) || fee <= 0) {
      return res.status(400).json({ success: false, error: 'Valid class name, class number, and positive monthly fee are required.' });
    }

    const trimmedName = name.trim();

    // Check duplicate by class_number within the same stream and academic year
    const existingNum = db.prepare('SELECT id, name FROM classes WHERE academic_year_id = ? AND stream = ? AND class_number = ?').get(ayId, classStream, cNum);
    if (existingNum) {
      return res.status(400).json({
        success: false,
        error: `Class number ${cNum} already exists in ${classStream} stream ("${existingNum.name}"). Each class within a stream must have a unique class number.`
      });
    }

    // Check duplicate by name within the same stream and academic year
    const existingName = db.prepare('SELECT id FROM classes WHERE academic_year_id = ? AND stream = ? AND LOWER(name) = LOWER(?)').get(ayId, classStream, trimmedName);
    if (existingName) {
      return res.status(400).json({
        success: false,
        error: `A class named "${trimmedName}" already exists in ${classStream} stream.`
      });
    }

    const insert = db.prepare(`
      INSERT INTO classes (academic_year_id, name, class_number, monthly_fee, stream, is_active)
      VALUES (?, ?, ?, ?, ?, 1)
    `);
    const resRow = insert.run(ayId, trimmedName, cNum, fee, classStream);
    res.json({
      success: true,
      data: { id: Number(resRow.lastInsertRowid), name: trimmedName, class_number: cNum, stream: classStream, monthly_fee: fee },
      message: `Class "${trimmedName}" (${classStream} Stream) created successfully.`
    });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

apiRouter.put('/classes/:id', (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { name, monthly_fee, stream, is_active } = req.body;
    const fee = monthly_fee !== undefined ? parseFloat(monthly_fee) : null;
    if (fee !== null && (isNaN(fee) || fee <= 0)) {
      return res.status(400).json({ success: false, error: 'Monthly fee must be positive' });
    }

    const currentClass = db.prepare('SELECT * FROM classes WHERE id = ?').get(id);
    if (!currentClass) {
      return res.status(404).json({ success: false, error: 'Class not found' });
    }
    const updatedName = (name && name.trim()) ? name.trim() : currentClass.name;
    const updatedFee = fee !== null ? fee : currentClass.monthly_fee;
    const updatedStream = stream ? (stream.toLowerCase() === 'hifz' ? 'Hifz' : 'General') : (currentClass.stream || 'General');
    const updatedActive = is_active !== undefined ? (is_active ? 1 : 0) : (currentClass.is_active ?? 1);

    db.prepare('UPDATE classes SET name = ?, monthly_fee = ?, stream = ?, is_active = ? WHERE id = ?').run(
      updatedName, updatedFee, updatedStream, updatedActive, id
    );
    res.json({ success: true, message: 'Class updated' });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

apiRouter.delete('/classes/:id', requireDeletePermission, (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      return res.status(400).json({ success: false, error: 'Invalid class ID' });
    }

    const cls = db.prepare('SELECT id, name, class_number FROM classes WHERE id = ?').get(id);
    if (!cls) {
      return res.status(404).json({ success: false, error: 'Class not found' });
    }

    const isTotalDatabase = req.query.total_database === 'true' || req.query.scope === 'total';

    let targetClasses = [cls];
    if (isTotalDatabase) {
      targetClasses = db.prepare(
        'SELECT id, name FROM classes WHERE class_number = ? OR LOWER(name) = LOWER(?)'
      ).all(cls.class_number, cls.name);
    }

    // Removed manual BEGIN/COMMIT since sql.js adapter saves per statement / auto-commits synchronously
    try {
      let totalStudentsDeleted = 0;
      let totalPaymentsDeleted = 0;

      for (const target of targetClasses) {
        // Count students
        const stCountRow = db.prepare('SELECT COUNT(*) as c FROM students WHERE class_id = ?').get(target.id);
        const stCount = stCountRow ? stCountRow.c : 0;
        totalStudentsDeleted += stCount;

        // Delete associated payments first
        const payRes = db.prepare(`
          DELETE FROM payments 
          WHERE class_id = ? 
             OR student_id IN (SELECT id FROM students WHERE class_id = ?)
        `).run(target.id, target.id);
        totalPaymentsDeleted += (payRes && payRes.changes ? payRes.changes : 0);

        // Delete students in this class
        db.prepare('DELETE FROM students WHERE class_id = ?').run(target.id);

        // Delete the class record itself
        db.prepare('DELETE FROM classes WHERE id = ?').run(target.id);
      }

      const scopeNotice = isTotalDatabase
        ? 'from the total database (across all academic years)'
        : 'from the database';

      res.json({
        success: true,
        message: `Class "${cls.name}" was permanently deleted ${scopeNotice} along with ${totalStudentsDeleted} enrolled student(s) and ${totalPaymentsDeleted} payment record(s).`,
        data: {
          targetClassesCount: targetClasses.length,
          totalStudentsDeleted,
          totalPaymentsDeleted
        }
      });
    } catch (innerErr) {
      throw innerErr;
    }
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});
// ============================================================================
// STUDENT BRANCH SUPPORT (Nursery: Blue Batch / Green Batch, Play: Day / Morning)
// Paste this block in your backend API file, ABOVE the first `apiRouter.<method>('/students...')`
// route (it must be registered before the /students routes). `/classes` needs NO change.
// It uses the existing `apiRouter` and `db`.
// ============================================================================

// 1) One-time, safe migration: add students.branch if missing
(function ensureStudentBranchColumn() {
  try {
    const cols = db.prepare('PRAGMA table_info(students)').all();
    if (!cols.some(c => c.name === 'branch')) {
      db.prepare("ALTER TABLE students ADD COLUMN branch TEXT DEFAULT ''").run();
      console.log('[migration] students.branch column added');
    }
  } catch (err) {
    console.error('[migration] could not add students.branch:', err.message);
  }
})();

// 2) Branch rules (same rules as the frontend). Branches exist only for General Nursery / Play.
function allowedBranchesFor(className, classStream) {
  if (String(classStream || '').toLowerCase() === 'hifz') return [];
  const name = String(className || '').trim();
  if (/^nursery\b/i.test(name)) return ['Blue Batch', 'Green Batch'];
  if (/^play\b/i.test(name)) return ['Day', 'Morning'];
  return [];
}

function saveStudentBranch(studentId, branch) {
  const row = db.prepare(
    'SELECT s.id AS id, s.stream AS student_stream, c.name AS class_name, c.stream AS class_stream FROM students s LEFT JOIN classes c ON c.id = s.class_id WHERE s.id = ?'
  ).get(studentId);
  if (!row) return '';
  const stream = row.class_stream || row.student_stream || 'General';
  const allowed = allowedBranchesFor(row.class_name, stream);
  const value = (branch && allowed.includes(branch)) ? branch : '';
  db.prepare('UPDATE students SET branch = ? WHERE id = ?').run(value, studentId);
  return value;
}

function attachBranches(rows) {
  const list = (Array.isArray(rows) ? rows : [rows]).filter(r => r && r.id !== undefined);
  for (let i = 0; i < list.length; i += 500) {
    const chunk = list.slice(i, i + 500);
    const ph = chunk.map(() => '?').join(',');
    const found = db.prepare(`SELECT id, branch FROM students WHERE id IN (${ph})`).all(...chunk.map(r => r.id));
    const map = new Map(found.map(f => [Number(f.id), f.branch || '']));
    chunk.forEach(r => { r.branch = map.get(Number(r.id)) || ''; });
  }
}

// 3) Hook: saves `branch` on create/update and adds `branch` to every student returned by /students*
apiRouter.use('/students', (req, res, next) => {
  const isCreate = req.method === 'POST' && (req.path === '/' || req.path === '');
  const idMatch = req.path.match(/^\/(\d+)$/);
  const isUpdate = req.method === 'PUT' && !!idMatch;
  const isGet = req.method === 'GET';
  const branch = (req.body && typeof req.body.branch === 'string') ? req.body.branch.trim() : null;

  const originalJson = res.json.bind(res);
  res.json = function (payload) {
    try {
      if (payload && payload.success !== false) {
        if (isCreate && branch !== null && payload.data && payload.data.id) {
          saveStudentBranch(payload.data.id, branch);
        } else if (isUpdate && branch !== null) {
          saveStudentBranch(parseInt(idMatch[1], 10), branch);
        } else if (isGet) {
          if (Array.isArray(payload.data)) attachBranches(payload.data);
          else if (payload.data && payload.data.student) attachBranches(payload.data.student);
          if (Array.isArray(payload.students)) attachBranches(payload.students);
          if (payload.exactMatch) attachBranches(payload.exactMatch);
        }
      }
    } catch (err) {
      console.error('[branch hook]', err.message);
    }
    return originalJson(payload);
  };
  next();
});
// ----------------------------------------------------
// STUDENTS & AUTOMATIC ROLL
// ----------------------------------------------------
apiRouter.get('/students/next-roll', (req, res) => {
  try {
    const classId = parseInt(req.query.class_id, 10);
    const ayId = resolveAcademicYear(req.query.academic_year_id).id;
    const stream = req.query.stream;

    if (isNaN(classId)) {
      return res.status(400).json({ success: false, error: 'class_id is required' });
    }

    const cls = db.prepare('SELECT * FROM classes WHERE id = ?').get(classId);
    if (!cls) {
      return res.status(400).json({ success: false, error: 'Class not found' });
    }

    const classStream = (cls.stream && cls.stream.toLowerCase() === 'hifz') ? 'Hifz' : 'General';
    if (stream && stream.toLowerCase() !== classStream.toLowerCase()) {
      return res.status(400).json({
        success: false,
        error: `Selected class "${cls.name}" belongs to the ${classStream} system, not ${stream}`
      });
    }

    const effectiveStream = classStream;
    const nextRoll = getNextRollNumber(ayId, classId, effectiveStream);

    res.json({
      success: true,
      nextRoll,
      classFee: cls.monthly_fee ?? 1000,
      className: cls.name ?? '',
      stream: effectiveStream
    });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

apiRouter.get('/students', (req, res) => {
  try {
    const ayId = resolveAcademicYear(req.query.academic_year_id).id;
    const classFilter = req.query.class_id ? parseInt(req.query.class_id, 10) : null;
    const streamFilter = req.query.stream;
    const statusFilter = req.query.status || 'all';
    const paymentFilter = req.query.payment_status || 'all';
    const search = (req.query.search || '').trim().toLowerCase();
    const currentMonth = (req.query.month) || getCurrentMonth();

    let query = `
      SELECT s.*, c.name as class_name, c.class_number, c.monthly_fee, ay.year as academic_year,
        EXISTS (
          SELECT 1 FROM payments p 
          WHERE p.student_id = s.id 
            AND p.academic_year_id = s.academic_year_id 
            AND p.month = ?
        ) as is_paid_current_month
      FROM students s
      JOIN classes c ON s.class_id = c.id
      JOIN academic_years ay ON s.academic_year_id = ay.id
      WHERE s.academic_year_id = ?
    `;
    const params = [currentMonth, ayId];

    if (classFilter) {
      query += ' AND s.class_id = ?';
      params.push(classFilter);
    }

    if (req.auth?.role === 'teacher') {
      const tc = req.teacherContext;
      if (!tc || !tc.allClassIds || tc.allClassIds.length === 0) {
        return res.json({ success: true, data: [], total: 0, currentMonth });
      }
      query += ` AND s.class_id IN (${tc.allClassIds.map(() => '?').join(',')})`;
      params.push(...tc.allClassIds);
    }

    if (streamFilter && streamFilter !== 'all') {
      query += ' AND LOWER(s.stream) = LOWER(?)';
      params.push(streamFilter);
    }

    if (statusFilter !== 'all') {
      query += ' AND s.status = ?';
      params.push(statusFilter);
    }

    if (search) {
      let searchRoll = null;
      const cleanSearch = search.replace(/^#/, '').trim();
      const stuMatch = cleanSearch.match(/^stu[-_]?(?:20\d{2})?[-_]?0*([a-zA-Z0-9]+)$/i) || cleanSearch.match(/^stu[-_]?0*([a-zA-Z0-9]+)$/i);
      let matchedRollStr = null;
      if (stuMatch) {
        matchedRollStr = stuMatch[1];
        const num = parseInt(stuMatch[1], 10);
        if (!isNaN(num) && /^\d+$/.test(stuMatch[1])) {
          searchRoll = num;
        }
      } else {
        const rawDigits = cleanSearch.replace(/[^0-9]/g, '');
        if (rawDigits.length > 0 && rawDigits.length <= 6) {
          searchRoll = parseInt(rawDigits, 10);
        }
      }

      query += ` AND (
        LOWER(s.name) LIKE ? OR 
        CAST(s.roll_number AS TEXT) LIKE ? OR 
        s.phone LIKE ? OR 
        (s.phone_secondary IS NOT NULL AND s.phone_secondary LIKE ?) OR 
        LOWER(s.father_name) LIKE ? OR
        LOWER(s.mother_name) LIKE ? OR
        ('stu-' || ay.year || '-' || substr('0000' || s.roll_number, -4)) LIKE ? OR
        ('stu-' || substr('0000' || s.roll_number, -4)) LIKE ? OR
        ('stu-' || s.roll_number) LIKE ? OR
        LOWER(s.roll_number) = LOWER(?)
      `;
      const wild = `%${cleanSearch}%`;
      params.push(wild, wild, wild, wild, wild, wild, wild, wild, wild, cleanSearch);

      if (matchedRollStr) {
        query += ` OR LOWER(s.roll_number) = LOWER(?)`;
        params.push(matchedRollStr);
      }

      if (searchRoll !== null) {
        query += ` OR s.roll_number = ?`;
        params.push(searchRoll);
      }
      query += ` )`;
    }

    query += ' ORDER BY c.stream ASC, c.class_number ASC, s.roll_number ASC';

    const rows = db.prepare(query).all(...params);

    // Process payment filter and format response (omit financial data for teachers)
    const isTeacher = req.auth?.role === 'teacher';
    const results = rows.map(s => {
      const isPaid = Boolean(s.is_paid_current_month);
      const primaryContact = s.primary_contact || 'primary';
      const effectivePhone = (primaryContact === 'secondary' && s.phone_secondary) ? s.phone_secondary : s.phone;
      if (isTeacher) {
        return {
          id: s.id,
          name: s.name,
          roll_number: s.roll_number,
          display_roll: `#${s.roll_number}`,
          class_id: s.class_id,
          class_name: s.class_name,
          stream: s.stream,
          primary_phone: effectivePhone,
          status: s.status
        };
      }
      return {
        ...s,
        display_roll: `#${s.roll_number}`,
        current_month_status: isPaid ? 'Paid' : 'Due',
        primary_phone: effectivePhone
      };
    }).filter(s => {
      if (isTeacher || paymentFilter === 'all') return true;
      if (paymentFilter === 'Paid') return s.current_month_status === 'Paid';
      if (paymentFilter === 'Due') return s.current_month_status === 'Due';
    });

    res.json({
      success: true,
      data: results,
      total: results.length,
      currentMonth
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

apiRouter.get('/students/lookup', (req, res) => {
  try {
    const query = (((req.query.query) || (req.query.q) || '')).trim();
    const classId = req.query.class_id ? parseInt(req.query.class_id, 10) : null;
    const currentMonth = (req.query.month) || getCurrentMonth();

    if (!query && !classId) {
      return res.json({ success: true, students: [], exactMatch: null });
    }

    let sql = `
      SELECT s.*, c.name as class_name, c.class_number, c.monthly_fee, ay.year as academic_year
      FROM students s
      JOIN classes c ON s.class_id = c.id
      JOIN academic_years ay ON s.academic_year_id = ay.id
      WHERE 1=1
    `;
    const params = [];

    if (classId) {
      sql += ' AND s.class_id = ?';
      params.push(classId);
    }

    let parsedRoll = null;
    let matchedRollStr = null;
    let cleanStuQuery = query.replace(/^#/, '').trim();
    if (cleanStuQuery) {
      const stuMatch = cleanStuQuery.match(/^stu[-_]?(?:20\d{2})?[-_]?0*([a-zA-Z0-9]+)$/i) || cleanStuQuery.match(/^stu[-_]?0*([a-zA-Z0-9]+)$/i);
      if (stuMatch) {
        matchedRollStr = stuMatch[1];
        const num = parseInt(stuMatch[1], 10);
        if (!isNaN(num) && /^\d+$/.test(stuMatch[1])) {
          parsedRoll = num;
        }
      } else {
        const pureDigits = cleanStuQuery.replace(/[^0-9]/g, '');
        if (pureDigits.length > 0 && pureDigits.length <= 5) {
          parsedRoll = parseInt(pureDigits, 10);
        }
      }

      sql += ` AND (
        LOWER(s.name) LIKE ? OR 
        LOWER(s.father_name) LIKE ? OR 
        s.phone LIKE ? OR 
        CAST(s.roll_number AS TEXT) LIKE ? OR
        ('stu-' || ay.year || '-' || substr('0000' || s.roll_number, -4)) LIKE ? OR
        ('stu-' || substr('0000' || s.roll_number, -4)) LIKE ? OR
        ('stu-' || s.roll_number) LIKE ? OR
        LOWER(s.roll_number) = LOWER(?)
      `;
      const wild = `%${cleanStuQuery.toLowerCase()}%`;
      params.push(wild, wild, wild, wild, wild, wild, wild, cleanStuQuery);

      if (matchedRollStr) {
        sql += ` OR LOWER(s.roll_number) = LOWER(?)`;
        params.push(matchedRollStr);
      }

      if (parsedRoll !== null) {
        sql += ` OR s.roll_number = ?`;
        params.push(parsedRoll);
      }
      sql += ` )`;
    }

    if (cleanStuQuery) {
      sql += ' ORDER BY c.class_number ASC, s.roll_number ASC LIMIT 30';
    } else {
      sql += ' ORDER BY s.roll_number ASC LIMIT 200';
    }

    const students = db.prepare(sql).all(...params);

    const enriched = students.map(st => {
      const payment = db.prepare(`
        SELECT * FROM payments 
        WHERE student_id = ? AND month = ? AND academic_year_id = ?
        LIMIT 1
      `).get(st.id, currentMonth, st.academic_year_id);

      return {
        ...st,
        system_id: `STU-${st.academic_year}-${String(st.roll_number).padStart(4, '0')}`,
        current_month_status: payment ? 'Paid' : 'Due',
        payment: payment || null
      };
    });

    // Determine exact match if user typed an exact roll or student ID
    let exactMatch = null;
    if (cleanStuQuery) {
      const lowerQ = cleanStuQuery.toLowerCase();
      exactMatch = enriched.find(s =>
        s.system_id.toLowerCase() === lowerQ ||
        String(s.roll_number).toLowerCase() === lowerQ ||
        (matchedRollStr && String(s.roll_number).toLowerCase() === matchedRollStr.toLowerCase()) ||
        (parsedRoll !== null && (s.roll_number === parsedRoll || String(s.roll_number) === String(parsedRoll)) && (!classId || s.class_id === classId))
      ) || null;

      if (!exactMatch) {
        exactMatch = enriched.find(s => s.name.toLowerCase() === lowerQ) || null;
      }
      if (!exactMatch && enriched.length === 1 && cleanStuQuery.length >= 2) {
        exactMatch = enriched[0];
      }
    }

    res.json({
      success: true,
      students: enriched,
      exactMatch
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

apiRouter.get('/students/:id', (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const student = db.prepare(`
      SELECT s.*, c.name as class_name, c.class_number, c.monthly_fee, ay.year as academic_year
      FROM students s
      JOIN classes c ON s.class_id = c.id
      JOIN academic_years ay ON s.academic_year_id = ay.id
      WHERE s.id = ?
    `).get(id);

    if (!student) {
      return res.status(404).json({ success: false, error: 'Student not found' });
    }

    // Get all payments for this student
    const payments = db.prepare(`
      SELECT * FROM payments 
      WHERE student_id = ? AND academic_year_id = ?
      ORDER BY payment_date DESC, id DESC
    `).all(id, student.academic_year_id);

    const paymentsByMonth = new Map();
    payments.forEach(p => paymentsByMonth.set(p.month, p));

    // Calculate month-by-month status for 12 months
    const admDate = new Date(student.admission_date);
    const admMonthIndex = isNaN(admDate.getTime()) ? 0 : admDate.getMonth(); // 0 = Jan
    const currentMonthIndex = getCurrentMonthIndex();

    let totalPaid = 0;
    let totalDue = 0;
    let paidCount = 0;
    let dueCount = 0;

    const monthlyBreakdown = MONTHS.map((monthName, idx) => {
      const payment = paymentsByMonth.get(monthName);
      let status;

      if (idx < admMonthIndex) {
        status = 'NOT_APPLICABLE';
      } else if (payment) {
        status = 'PAID';
        totalPaid += payment.amount;
        paidCount++;
      } else if (idx <= currentMonthIndex) {
        status = 'DUE';
        totalDue += student.monthly_fee;
        dueCount++;
      } else {
        status = 'UPCOMING';
      }

      return {
        month: monthName,
        monthIndex: idx + 1,
        status,
        payment: payment || null,
        fee: student.monthly_fee
      };
    });

    res.json({
      success: true,
      data: {
        student: {
          ...student,
          display_roll: `#${student.roll_number}`
        },
        summary: {
          totalPaid,
          totalDue,
          paidCount,
          dueCount,
          monthlyFee: student.monthly_fee
        },
        monthlyBreakdown,
        payments
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

apiRouter.post('/students', (req, res) => {
  try {
    const {
      name,
      father_name,
      mother_name,
      phone,
      phone_secondary,
      primary_contact,
      notes,
      address,
      class_id,
      stream,
      admission_date,
      academic_year_id,
      photo_url
    } = req.body;

    if (!name || !phone || !class_id) {
      return res.status(400).json({ success: false, error: 'Student Name, Phone and Class are required' });
    }

    const ayId = resolveAcademicYear(academic_year_id).id;
    const classId = parseInt(class_id, 10);
    const cls = db.prepare('SELECT * FROM classes WHERE id = ?').get(classId);
    if (!cls) {
      return res.status(400).json({ success: false, error: 'Class not found' });
    }

    const effectiveStream = stream ? (stream.toLowerCase() === 'hifz' ? 'Hifz' : 'General') : (cls.stream || 'General');
    const admDate = admission_date || getDhakaDate();

    // Auto generate next roll inside transaction
    const nextRoll = getNextRollNumber(ayId, classId, effectiveStream);

    const insert = db.prepare(`
      INSERT INTO students (
        academic_year_id, class_id, roll_number, stream, name, father_name, mother_name,
        phone, phone_secondary, primary_contact, notes, address, admission_date, status, photo_url
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Active', ?)
    `);

    const result = insert.run(
      ayId,
      classId,
      String(nextRoll),
      effectiveStream,
      name.trim(),
      father_name && father_name.trim() ? father_name.trim() : null,
      mother_name && mother_name.trim() ? mother_name.trim() : null,
      phone.trim(),
      phone_secondary && phone_secondary.trim() ? phone_secondary.trim() : null,
      primary_contact === 'secondary' ? 'secondary' : 'primary',
      notes && notes.trim() ? notes.trim() : null,
      address && address.trim() ? address.trim() : null,
      admDate,
      photo_url && photo_url.trim() ? photo_url.trim() : null
    );

    res.json({
      success: true,
      data: {
        id: Number(result.lastInsertRowid),
        roll_number: nextRoll,
        display_roll: `#${nextRoll}`,
        stream: effectiveStream,
        name
      }
    });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

apiRouter.put('/students/:id', (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      return res.status(400).json({ success: false, error: 'Invalid student ID' });
    }

    const current = db.prepare('SELECT * FROM students WHERE id = ?').get(id);
    if (!current) {
      return res.status(404).json({ success: false, error: 'Student not found' });
    }

    const {
      name,
      father_name,
      mother_name,
      phone,
      phone_secondary,
      primary_contact,
      notes,
      address,
      status,
      admission_date,
      photo_url,
      class_id,
      stream
    } = req.body;

    // Process name: must not be empty if provided
    let updatedName = current.name;
    if (name !== undefined) {
      const trimmed = (name || '').trim();
      if (!trimmed) {
        return res.status(400).json({ success: false, error: 'Student name cannot be empty' });
      }
      updatedName = trimmed;
    }

    // Process phone: must not be empty if provided
    let updatedPhone = current.phone;
    if (phone !== undefined) {
      const trimmed = (phone || '').trim();
      if (!trimmed) {
        return res.status(400).json({ success: false, error: 'Phone number cannot be empty' });
      }
      updatedPhone = trimmed;
    }

    let updatedPhoneSecondary = current.phone_secondary;
    if (phone_secondary !== undefined) {
      const trimmed = (phone_secondary || '').trim();
      updatedPhoneSecondary = trimmed || null;
    }

    let updatedPrimaryContact = current.primary_contact || 'primary';
    if (primary_contact !== undefined) {
      updatedPrimaryContact = primary_contact === 'secondary' ? 'secondary' : 'primary';
    }

    let updatedNotes = current.notes;
    if (notes !== undefined) {
      const trimmed = (notes || '').trim();
      updatedNotes = trimmed || null;
    }

    // Process father_name: if provided, update to trimmed string or null if empty
    let updatedFather = current.father_name;
    if (father_name !== undefined) {
      const trimmed = (father_name || '').trim();
      updatedFather = (trimmed && trimmed !== 'N/A' && trimmed !== 'null') ? trimmed : null;
    }

    // Process mother_name: if provided, update to trimmed string or null if empty
    let updatedMother = current.mother_name;
    if (mother_name !== undefined) {
      const trimmed = (mother_name || '').trim();
      updatedMother = (trimmed && trimmed !== 'N/A' && trimmed !== 'null') ? trimmed : null;
    }

    // Process address: if provided, update to trimmed string or null if empty
    let updatedAddress = current.address;
    if (address !== undefined) {
      const trimmed = (address || '').trim();
      updatedAddress = (trimmed && trimmed !== 'N/A' && trimmed !== 'null') ? trimmed : null;
    }

    // Process class_id
    let updatedClassId = current.class_id;
    if (class_id !== undefined && class_id) {
      const parsedCls = parseInt(class_id, 10);
      if (!isNaN(parsedCls)) {
        const clsExists = db.prepare('SELECT id FROM classes WHERE id = ?').get(parsedCls);
        if (clsExists) {
          updatedClassId = parsedCls;
        }
      }
    }

    let updatedStream = current.stream || 'General';
    if (stream !== undefined && stream) {
      updatedStream = stream.toLowerCase() === 'hifz' ? 'Hifz' : 'General';
    }

    // Process status: Active or Inactive
    let updatedStatus = current.status;
    if (status !== undefined && status) {
      updatedStatus = status;
    }

    // Process admission_date
    let updatedAdmDate = current.admission_date;
    if (admission_date !== undefined && admission_date) {
      updatedAdmDate = admission_date;
    }

    // Process photo_url
    let updatedPhoto = current.photo_url;
    if (photo_url !== undefined) {
      const trimmed = (photo_url || '').trim();
      updatedPhoto = trimmed ? trimmed : null;
    }

    db.prepare(`
      UPDATE students SET 
        name = ?,
        father_name = ?,
        mother_name = ?,
        phone = ?,
        phone_secondary = ?,
        primary_contact = ?,
        notes = ?,
        address = ?,
        status = ?,
        admission_date = ?,
        photo_url = ?,
        class_id = ?,
        stream = ?,
        updated_at = datetime('now', 'localtime')
      WHERE id = ?
    `).run(
      updatedName,
      updatedFather,
      updatedMother,
      updatedPhone,
      updatedPhoneSecondary,
      updatedPrimaryContact,
      updatedNotes,
      updatedAddress,
      updatedStatus,
      updatedAdmDate,
      updatedPhoto,
      updatedClassId,
      updatedStream,
      id
    );

    res.json({
      success: true,
      message: 'Student profile updated successfully',
      data: {
        id,
        name: updatedName,
        father_name: updatedFather,
        mother_name: updatedMother,
        phone: updatedPhone,
        address: updatedAddress,
        status: updatedStatus,
        admission_date: updatedAdmDate
      }
    });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

apiRouter.patch('/students/:id/status', (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { status } = req.body;
    if (!status || !['Active', 'Inactive'].includes(status)) {
      return res.status(400).json({ success: false, error: 'Status must be Active or Inactive' });
    }

    db.prepare('UPDATE students SET status = ?, updated_at = datetime(\'now\', \'localtime\') WHERE id = ?').run(status, id);
    res.json({ success: true, message: `Student marked as ${status}` });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

apiRouter.delete('/students/:id', requireDeletePermission, (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      return res.status(400).json({ success: false, error: 'Invalid student ID' });
    }

    const student = db.prepare('SELECT id, name, roll_number FROM students WHERE id = ?').get(id);
    if (!student) {
      return res.status(404).json({ success: false, error: 'Student not found' });
    }

    // Delete associated payments first to prevent foreign key restrict violations
    db.prepare('DELETE FROM payments WHERE student_id = ?').run(id);

    // Delete student record
    db.prepare('DELETE FROM students WHERE id = ?').run(id);

    res.json({
      success: true,
      message: `Student "${student.name}" (Roll #${student.roll_number}) and all payment history were deleted successfully`
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ----------------------------------------------------
// PAYMENTS & RECEIPT
// ----------------------------------------------------
apiRouter.get('/payments', (req, res) => {
  try {
    const ayId = resolveAcademicYear(req.query.academic_year_id).id;
    const classId = req.query.class_id ? parseInt(req.query.class_id, 10) : null;
    const month = req.query.month || null;
    const studentSearch = (req.query.search || '').trim().toLowerCase();
    const startDate = req.query.startDate || null;
    const endDate = req.query.endDate || null;

    let query = `
      SELECT p.*, s.name as student_name, s.roll_number, s.phone as student_phone,
        c.name as class_name, c.class_number
      FROM payments p
      JOIN students s ON p.student_id = s.id
      JOIN classes c ON p.class_id = c.id
      WHERE p.academic_year_id = ?
    `;
    const params = [ayId];

    if (classId) {
      query += ' AND p.class_id = ?';
      params.push(classId);
    }
    if (month && month !== 'all') {
      query += ' AND p.month = ?';
      params.push(month);
    }
    if (startDate) {
      query += ' AND p.payment_date >= ?';
      params.push(startDate);
    }
    if (endDate) {
      query += ' AND p.payment_date <= ?';
      params.push(endDate);
    }
    if (studentSearch) {
      query += ' AND (LOWER(s.name) LIKE ? OR CAST(s.roll_number AS TEXT) LIKE ? OR p.receipt_no LIKE ?)';
      const wild = `%${studentSearch}%`;
      params.push(wild, wild, wild);
    }

    query += ' ORDER BY p.payment_date DESC, p.id DESC';

    const rows = db.prepare(query).all(...params);
    res.json({ success: true, data: rows });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

apiRouter.post('/payments', (req, res) => {
  try {
    const { student_id, month, payment_method, note, payment_date, payment_time } = req.body;
    if (!student_id || !month) {
      return res.status(400).json({ success: false, error: 'Student and billing month are required' });
    }

    const studentId = parseInt(student_id, 10);
    const student = db.prepare(`
      SELECT s.*, c.monthly_fee, c.name as class_name, ay.year as academic_year
      FROM students s
      JOIN classes c ON s.class_id = c.id
      JOIN academic_years ay ON s.academic_year_id = ay.id
      WHERE s.id = ?
    `).get(studentId);

    if (!student) {
      return res.status(404).json({ success: false, error: 'Student not found' });
    }

    // Check duplicate payment constraint: student + month + academic_year
    const existing = db.prepare(`
      SELECT * FROM payments 
      WHERE student_id = ? AND month = ? AND academic_year_id = ?
    `).get(studentId, month, student.academic_year_id);

    if (existing) {
      return res.status(400).json({
        success: false,
        error: `Fee for ${month} has already been paid on ${existing.payment_date} (Receipt ${existing.receipt_no}). Duplicate payment rejected.`
      });
    }

    // Determine current date and time in local coaching timezone
    const now = new Date();
    const dateStr = payment_date || getDhakaDate(now);
    const timeStr = payment_time || getDhakaTime(now);

    // Generate unique receipt number
    const maxRec = db.prepare("SELECT COUNT(*) as cnt FROM payments").get();
    const receiptNo = `REC-${student.academic_year}-${String(1000 + maxRec.cnt + 1).padStart(4, '0')}`;

    // Fixed Fee Protection Rule: student monthly tuition fee is predefined and fixed
    const expectedFee = student.monthly_fee || 0;
    if (req.body.amount !== undefined && req.body.amount !== null && String(req.body.amount).trim() !== '') {
      const enteredAmount = parseFloat(req.body.amount);
      if (expectedFee > 0 && (isNaN(enteredAmount) || Math.abs(enteredAmount - expectedFee) > 0.01)) {
        return res.status(400).json({
          success: false,
          error: `Student monthly tuition fee is fixed at ৳${expectedFee}. Collecting partial or modified amounts (৳${enteredAmount}) is not allowed. Use "Others" income for miscellaneous collections.`
        });
      }
    }
    const finalAmount = expectedFee > 0 ? expectedFee : (parseFloat(req.body.amount) || 0);

    const insert = db.prepare(`
      INSERT INTO payments (
        student_id, academic_year_id, class_id, month, year, amount,
        payment_date, payment_time, payment_method, receipt_no, note
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const result = insert.run(
      studentId,
      student.academic_year_id,
      student.class_id,
      month,
      student.academic_year,
      finalAmount,
      dateStr,
      timeStr,
      payment_method || 'Cash',
      receiptNo,
      note || 'Monthly tuition fee'
    );

    res.json({
      success: true,
      message: `Payment of ৳${finalAmount} recorded successfully`,
      data: {
        paymentId: Number(result.lastInsertRowid),
        id: Number(result.lastInsertRowid),
        receiptNo,
        receipt_no: receiptNo,
        studentName: student.name,
        student_name: student.name,
        roll: student.roll_number,
        roll_number: student.roll_number,
        className: student.class_name,
        class_name: student.class_name,
        month,
        year: student.academic_year,
        amount: finalAmount,
        date: dateStr,
        payment_date: dateStr,
        time: timeStr,
        payment_time: timeStr,
        payment_method: payment_method || 'Cash',
        note: note || 'Monthly tuition fee',
        remarks: note || 'Monthly tuition fee'
      }
    });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

// ----------------------------------------------------
// MONTHLY OVERVIEW (12-MONTH MATRIX & DUE LIST)
// ----------------------------------------------------
apiRouter.get('/overview/matrix', (req, res) => {
  try {
    const ayId = resolveAcademicYear(req.query.academic_year_id).id;
    let classId = req.query.class_id ? parseInt(req.query.class_id, 10) : null;
    const targetMonth = (req.query.month) || getCurrentMonth();

    // If no classId provided, default to Class 5 (as in screenshot) or first class
    if (!classId) {
      const cls5 = db.prepare("SELECT id FROM classes WHERE academic_year_id = ? AND class_number = 5").get(ayId);
      if (cls5) {
        classId = cls5.id;
      } else {
        const firstCls = db.prepare("SELECT id FROM classes WHERE academic_year_id = ? ORDER BY class_number ASC LIMIT 1").get(ayId);
        classId = firstCls ? firstCls.id : 1;
      }
    }

    const cls = db.prepare('SELECT * FROM classes WHERE id = ?').get(classId);
    if (!cls) {
      return res.status(404).json({ success: false, error: 'Class not found' });
    }

    // Get all students in this class
    const students = db.prepare(`
      SELECT s.* FROM students s
      WHERE s.class_id = ? AND s.academic_year_id = ?
      ORDER BY s.roll_number ASC
    `).all(classId, ayId);

    // Get all payments for this class and year
    const payments = db.prepare(`
      SELECT * FROM payments
      WHERE class_id = ? AND academic_year_id = ?
    `).all(classId, ayId);

    const payMap = new Map(); // key: `${student_id}_${month}`
    payments.forEach(p => {
      payMap.set(`${p.student_id}_${p.month}`, p);
    });

    const targetMonthIdx = MONTHS.indexOf(targetMonth);
    const activeTargetIdx = targetMonthIdx >= 0 ? targetMonthIdx : 8; // default Sep = 8

    let totalEnrolled = students.length;
    let targetClearedCount = 0;
    let targetDueCount = 0;
    let grossCollectedTargetMonth = 0;
    let expectedTargetAmount = totalEnrolled * cls.monthly_fee;

    const rows = students.map(st => {
      const admDate = new Date(st.admission_date);
      const admMonthIdx = isNaN(admDate.getTime()) ? 0 : admDate.getMonth();

      const monthsStatus = {};

      MONTHS.forEach((mName, mIdx) => {
        const payment = payMap.get(`${st.id}_${mName}`);
        if (mIdx < admMonthIdx) {
          monthsStatus[mName] = { status: 'NOT_APPLICABLE', label: '—' };
        } else if (payment) {
          const amtLabel = payment.amount >= 1000
            ? `✓ ৳${(payment.amount / 1000).toFixed(payment.amount % 1000 === 0 ? 0 : 1)}k`
            : `✓ ৳${payment.amount}`;
          monthsStatus[mName] = {
            status: 'PAID',
            label: amtLabel,
            receipt: payment.receipt_no,
            amount: payment.amount,
            date: payment.payment_date,
            note: payment.note || 'Monthly tuition fee',
            remarks: payment.note || 'Monthly tuition fee',
            payment_method: payment.payment_method || 'Cash'
          };
        } else if (mIdx <= activeTargetIdx) {
          monthsStatus[mName] = { status: 'DUE', label: 'DUE', amount: cls.monthly_fee };
        } else {
          monthsStatus[mName] = { status: 'UPCOMING', label: '—' };
        }
      });

      const targetCell = monthsStatus[targetMonth];
      if (targetCell?.status === 'PAID') {
        targetClearedCount++;
        grossCollectedTargetMonth += (targetCell.amount || cls.monthly_fee);
      } else if (targetCell?.status === 'DUE') {
        targetDueCount++;
      }

      return {
        id: st.id,
        roll: st.roll_number,
        display_roll: `#${st.roll_number}`,
        name: st.name,
        phone: st.phone,
        father: st.father_name,
        status: st.status,
        monthly_fee: cls.monthly_fee,
        months: monthsStatus
      };
    });

    const clearedPercent = totalEnrolled > 0 ? ((targetClearedCount / totalEnrolled) * 100).toFixed(1) : '0';
    const duePercent = totalEnrolled > 0 ? ((targetDueCount / totalEnrolled) * 100).toFixed(1) : '0';
    const unsettledAmount = expectedTargetAmount - grossCollectedTargetMonth;

    const targetYearRow = db.prepare('SELECT year FROM academic_years WHERE id = ?').get(ayId);
    const ayYear = targetYearRow ? targetYearRow.year : 2026;

    res.json({
      success: true,
      academicYear: ayYear,
      academicYearId: ayId,
      classInfo: cls,
      targetMonth,
      stats: {
        totalEnrolled,
        clearedCount: targetClearedCount,
        clearedPercent: parseFloat(clearedPercent),
        dueCount: targetDueCount,
        duePercent: parseFloat(duePercent),
        grossCollected: grossCollectedTargetMonth,
        expectedTarget: expectedTargetAmount,
        unsettledAmount
      },
      rows
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

apiRouter.get('/overview/due-list', (req, res) => {
  try {
    const ayId = resolveAcademicYear(req.query.academic_year_id).id;
    const classId = req.query.class_id ? parseInt(req.query.class_id, 10) : null;
    const targetMonth = (req.query.month) || getCurrentMonth();

    let query = `
      SELECT s.id, s.roll_number, s.name, s.phone, s.admission_date, c.id as class_id, c.name as class_name, c.monthly_fee
      FROM students s
      JOIN classes c ON s.class_id = c.id
      WHERE s.academic_year_id = ? 
        AND NOT EXISTS (
          SELECT 1 FROM payments p 
          WHERE p.student_id = s.id 
            AND p.month = ? 
            AND p.academic_year_id = ?
        )
    `;
    const params = [ayId, targetMonth, ayId];

    if (classId) {
      query += ' AND s.class_id = ?';
      params.push(classId);
    }

    query += ' ORDER BY c.class_number ASC, s.roll_number ASC';

    const rows = db.prepare(query).all(...params);

    // Calculate total due months for each student
    const targetMonthIdx = MONTHS.indexOf(targetMonth);
    const results = rows.map(st => {
      const admDate = new Date(st.admission_date);
      const admMonthIdx = isNaN(admDate.getTime()) ? 0 : admDate.getMonth();

      // Check how many months between admission and target are unpaid
      let unpaidMonths = [];
      for (let i = admMonthIdx; i <= targetMonthIdx; i++) {
        const m = MONTHS[i];
        const paid = db.prepare('SELECT 1 FROM payments WHERE student_id = ? AND month = ? AND academic_year_id = ?').get(st.id, m, ayId);
        if (!paid) {
          unpaidMonths.push(m);
        }
      }

      return {
        ...st,
        display_roll: `#${st.roll_number}`,
        targetMonth,
        unpaidMonthsCount: unpaidMonths.length,
        unpaidMonths,
        totalDueAmount: unpaidMonths.length * st.monthly_fee
      };
    });

    res.json({
      success: true,
      targetMonth,
      totalDueStudents: results.length,
      data: results
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ----------------------------------------------------
// EXPENSES & CATEGORIES
// ----------------------------------------------------
const getExpenseCategoriesHandler = (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT ec.*, 
        COUNT(e.id) as expense_count,
        COALESCE(SUM(e.amount), 0) as total_amount
      FROM expense_categories ec
      LEFT JOIN expenses e ON ec.id = e.category_id
      GROUP BY ec.id
      ORDER BY CASE WHEN LOWER(TRIM(ec.name)) IN ('other', 'others') THEN 1 ELSE 0 END ASC, ec.name ASC
    `).all();
    res.json({ success: true, data: rows });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

apiRouter.get('/expense-categories', getExpenseCategoriesHandler);
apiRouter.get('/expenses/categories', getExpenseCategoriesHandler);

const postExpenseCategoriesHandler = (req, res) => {
  try {
    const { name } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({ success: false, error: 'Category name is required' });
    }

    const insert = db.prepare('INSERT INTO expense_categories (name, is_default) VALUES (?, 0)');
    const resRow = insert.run(name.trim());
    res.json({ success: true, data: { id: Number(resRow.lastInsertRowid), name: name.trim() } });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
};

apiRouter.post('/expense-categories', postExpenseCategoriesHandler);
apiRouter.post('/expenses/categories', postExpenseCategoriesHandler);

apiRouter.get('/expenses', (req, res) => {
  try {
    const categoryId = req.query.category_id ? parseInt(req.query.category_id, 10) : null;
    const startDate = req.query.startDate || null;
    const endDate = req.query.endDate || null;
    const search = (req.query.search || '').trim().toLowerCase();

    let query = `
      SELECT e.*, ec.name as category_name
      FROM expenses e
      JOIN expense_categories ec ON e.category_id = ec.id
      WHERE 1=1
    `;
    const params = [];

    if (categoryId) {
      query += ' AND e.category_id = ?';
      params.push(categoryId);
    }
    if (startDate) {
      query += ' AND e.expense_date >= ?';
      params.push(startDate);
    }
    if (endDate) {
      query += ' AND e.expense_date <= ?';
      params.push(endDate);
    }
    if (search) {
      query += ' AND (LOWER(e.description) LIKE ? OR LOWER(ec.name) LIKE ? OR e.voucher_no LIKE ?)';
      const wild = `%${search}%`;
      params.push(wild, wild, wild);
    }

    query += ' ORDER BY e.expense_date DESC, e.id DESC';

    const rows = db.prepare(query).all(...params);
    res.json({ success: true, data: rows });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

apiRouter.post('/expenses', (req, res) => {
  try {
    const { category_id, amount, description, expense_date, expense_time } = req.body;
    const amt = parseFloat(amount);
    const catId = parseInt(category_id, 10);

    if (isNaN(amt) || amt <= 0) {
      return res.status(400).json({ success: false, error: 'Valid positive amount required' });
    }
    if (!catId || !description) {
      return res.status(400).json({ success: false, error: 'Category and description are required' });
    }

    const now = new Date();
    const dateStr = expense_date || getDhakaDate(now);
    const timeStr = expense_time || getDhakaTime(now);

    // Auto voucher number
    const maxVoucher = db.prepare('SELECT COUNT(*) as count FROM expenses').get();
    const voucherNo = `V-${String(100 + maxVoucher.count + 1)}`;

    const insert = db.prepare(`
      INSERT INTO expenses (category_id, amount, description, expense_date, expense_time, voucher_no)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    const result = insert.run(catId, amt, description.trim(), dateStr, timeStr, voucherNo);
    const cat = db.prepare('SELECT name FROM expense_categories WHERE id = ?').get(catId);
    res.json({
      success: true,
      data: {
        id: Number(result.lastInsertRowid),
        voucher_no: voucherNo,
        voucherNo,
        category_id: catId,
        category_name: cat ? cat.name : 'General Expense',
        amount: amt,
        description: description.trim(),
        expense_date: dateStr,
        expense_time: timeStr
      }
    });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

apiRouter.get('/expenses/:id', (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const expense = db.prepare(`
      SELECT e.*, ec.name as category_name
      FROM expenses e
      JOIN expense_categories ec ON e.category_id = ec.id
      WHERE e.id = ?
    `).get(id);
    if (!expense) {
      return res.status(404).json({ success: false, error: 'Expense not found' });
    }
    res.json({ success: true, data: expense });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

apiRouter.get('/expense-categories/:id/details', (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const category = db.prepare('SELECT * FROM expense_categories WHERE id = ?').get(id);
    if (!category) {
      return res.status(404).json({ success: false, error: 'Category not found' });
    }

    const items = db.prepare(`
      SELECT * FROM expenses WHERE category_id = ? ORDER BY expense_date DESC, id DESC
    `).all(id);

    res.json({ success: true, category, data: items });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

apiRouter.delete('/expenses/:id', requireDeletePermission, (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    db.prepare('DELETE FROM expenses WHERE id = ?').run(id);
    res.json({ success: true, message: 'Expense voucher deleted successfully' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

apiRouter.put('/payments/:id', (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { amount, note, payment_method, payment_date } = req.body;
    const current = db.prepare('SELECT * FROM payments WHERE id = ?').get(id);
    if (!current) {
      return res.status(404).json({ success: false, error: 'Payment not found' });
    }
    const rawAmount = amount !== undefined ? parseFloat(amount) : current.amount;
    const finalAmount = (!isNaN(rawAmount) && rawAmount >= 0) ? rawAmount : current.amount;
    const finalNote = note !== undefined ? note : current.note;
    const finalMethod = payment_method || current.payment_method;
    const finalDate = payment_date || current.payment_date;

    db.prepare(`
      UPDATE payments SET
        amount = ?,
        note = ?,
        payment_method = ?,
        payment_date = ?
      WHERE id = ?
    `).run(finalAmount, finalNote, finalMethod, finalDate, id);

    const updated = db.prepare(`
      SELECT p.*, s.name as student_name, s.roll_number, c.name as class_name
      FROM payments p
      JOIN students s ON p.student_id = s.id
      JOIN classes c ON p.class_id = c.id
      WHERE p.id = ?
    `).get(id);

    res.json({
      success: true,
      message: `Payment updated to ৳${finalAmount}`,
      data: updated
    });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

apiRouter.delete('/payments/:id', requireDeletePermission, (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    db.prepare('DELETE FROM payments WHERE id = ?').run(id);
    res.json({ success: true, message: 'Payment record deleted successfully' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ----------------------------------------------------
// FINANCIAL DASHBOARD (DYNAMIC SQLite CALCULATIONS)
// ----------------------------------------------------
apiRouter.get('/dashboard', (req, res) => {
  try {
    const ayRow = resolveAcademicYear(req.query.academic_year_id);
    const ayId = ayRow.id;
    const currentAcademicYear = ayRow.year;

    // Dynamic dates & timezone reconciliation (client date or Dhaka UTC+6)
    const clientDate = req.query.client_date || req.query.date || req.headers['x-client-date'];
    const { today, weekStart, weekEnd, monthStart, monthEnd } = getDateRangeContext(clientDate);
    const yearStart = `${currentAcademicYear}-01-01`;

    // Income calculations
    const todayIncomeRow = db.prepare(`
      SELECT COALESCE(SUM(amount), 0) as total, COUNT(id) as count
      FROM payments
      WHERE academic_year_id = ?
        AND (
          payment_date = ?
          OR date(created_at) = ?
          OR date(created_at, '+6 hours') = ?
        )
    `).get(ayId, today, today, today);

    const weekIncomeRow = db.prepare(`
      SELECT COALESCE(SUM(amount), 0) as total, COUNT(id) as count
      FROM payments
      WHERE academic_year_id = ?
        AND (
          (payment_date >= ? AND payment_date <= ?)
          OR (date(created_at) >= ? AND date(created_at) <= ?)
          OR (date(created_at, '+6 hours') >= ? AND date(created_at, '+6 hours') <= ?)
        )
    `).get(ayId, weekStart, weekEnd, weekStart, weekEnd, weekStart, weekEnd);

    const monthIncomeRow = db.prepare(`
      SELECT COALESCE(SUM(amount), 0) as total, COUNT(id) as count
      FROM payments
      WHERE academic_year_id = ?
        AND (
          (payment_date >= ? AND payment_date <= ?)
          OR (date(created_at) >= ? AND date(created_at) <= ?)
          OR (date(created_at, '+6 hours') >= ? AND date(created_at, '+6 hours') <= ?)
        )
    `).get(ayId, monthStart, monthEnd, monthStart, monthEnd, monthStart, monthEnd);

    const overallIncomeRow = db.prepare(`
      SELECT COALESCE(SUM(amount), 0) as total, COUNT(id) as count
      FROM payments WHERE academic_year_id = ?
    `).get(ayId);

    // Include Others Miscellaneous Income in totals
    const todayOtherRow = db.prepare(`
      SELECT COALESCE(SUM(amount), 0) as total, COUNT(id) as count
      FROM other_collections WHERE collection_date = ?
    `).get(today);
    todayIncomeRow.total += (todayOtherRow?.total || 0);
    todayIncomeRow.count += (todayOtherRow?.count || 0);

    const weekOtherRow = db.prepare(`
      SELECT COALESCE(SUM(amount), 0) as total, COUNT(id) as count
      FROM other_collections WHERE collection_date >= ? AND collection_date <= ?
    `).get(weekStart, weekEnd);
    weekIncomeRow.total += (weekOtherRow?.total || 0);
    weekIncomeRow.count += (weekOtherRow?.count || 0);

    const monthOtherRow = db.prepare(`
      SELECT COALESCE(SUM(amount), 0) as total, COUNT(id) as count
      FROM other_collections WHERE collection_date >= ? AND collection_date <= ?
    `).get(monthStart, monthEnd);
    monthIncomeRow.total += (monthOtherRow?.total || 0);
    monthIncomeRow.count += (monthOtherRow?.count || 0);

    const overallOtherRow = db.prepare(`
      SELECT COALESCE(SUM(amount), 0) as total, COUNT(id) as count
      FROM other_collections
    `).get();
    overallIncomeRow.total += (overallOtherRow?.total || 0);
    overallIncomeRow.count += (overallOtherRow?.count || 0);

    // Expense calculations
    const todayExpenseRow = db.prepare(`
      SELECT COALESCE(SUM(amount), 0) as total, COUNT(id) as count
      FROM expenses
      WHERE (
        expense_date = ?
        OR date(created_at) = ?
        OR date(created_at, '+6 hours') = ?
      )
    `).get(today, today, today);

    const weekExpenseRow = db.prepare(`
      SELECT COALESCE(SUM(amount), 0) as total, COUNT(id) as count
      FROM expenses
      WHERE (
        (expense_date >= ? AND expense_date <= ?)
        OR (date(created_at) >= ? AND date(created_at) <= ?)
        OR (date(created_at, '+6 hours') >= ? AND date(created_at, '+6 hours') <= ?)
      )
    `).get(weekStart, weekEnd, weekStart, weekEnd, weekStart, weekEnd);

    const monthExpenseRow = db.prepare(`
      SELECT COALESCE(SUM(amount), 0) as total, COUNT(id) as count
      FROM expenses
      WHERE (
        (expense_date >= ? AND expense_date <= ?)
        OR (date(created_at) >= ? AND date(created_at) <= ?)
        OR (date(created_at, '+6 hours') >= ? AND date(created_at, '+6 hours') <= ?)
      )
    `).get(monthStart, monthEnd, monthStart, monthEnd, monthStart, monthEnd);

    const overallExpenseRow = db.prepare(`
      SELECT COALESCE(SUM(amount), 0) as total, COUNT(id) as count
      FROM expenses
    `).get();

    // Student counts
    const totalStudents = db.prepare('SELECT COUNT(*) as count FROM students WHERE academic_year_id = ?').get(ayId);
    const activeClasses = db.prepare('SELECT COUNT(*) as count FROM classes WHERE academic_year_id = ?').get(ayId);

    // Target month for dashboard analysis (defaults to current month)
    const activeMonth = (req.query.month) || getCurrentMonth();

    // Due students count in current active month
    const dueCountRow = db.prepare(`
      SELECT COUNT(*) as count FROM students s
      WHERE s.academic_year_id = ?
        AND NOT EXISTS (
          SELECT 1 FROM payments p 
          WHERE p.student_id = s.id AND p.month = ? AND p.academic_year_id = s.academic_year_id
        )
    `).get(ayId, activeMonth);

    // Net balance calculations: Net = Income - Expense
    const todayNet = todayIncomeRow.total - todayExpenseRow.total;
    const weekNet = weekIncomeRow.total - weekExpenseRow.total;
    const monthNet = monthIncomeRow.total - monthExpenseRow.total;
    const overallNet = overallIncomeRow.total - overallExpenseRow.total;

    // Class Overview & Collection Rates
    const classes = db.prepare(`
      SELECT c.*, 
        (SELECT COUNT(*) FROM students s WHERE s.class_id = c.id) as student_count,
        (SELECT COALESCE(SUM(p.amount), 0) FROM payments p WHERE p.class_id = c.id AND p.month = ? AND p.academic_year_id = c.academic_year_id) as collected_amount
      FROM classes c
      WHERE c.academic_year_id = ?
      ORDER BY c.class_number ASC
    `).all(activeMonth, ayId);

    let totalProjected = 0;
    let totalCollectedSeptember = 0;

    const classOverview = classes.map(c => {
      const students = c.student_count || 0;
      const expected = students * c.monthly_fee;
      const collected = c.collected_amount || 0;
      const due = Math.max(0, expected - collected);
      const recoveryRate = expected > 0 ? ((collected / expected) * 100).toFixed(1) : '100';

      totalProjected += expected;
      totalCollectedSeptember += collected;

      return {
        id: c.id,
        name: c.name,
        class_number: c.class_number,
        students,
        monthly_fee: c.monthly_fee,
        expected,
        collected,
        due,
        recoveryRate: parseFloat(recoveryRate)
      };
    });

    const aggregateEfficiency = totalProjected > 0 ? ((totalCollectedSeptember / totalProjected) * 100).toFixed(1) : '0';

    // All due students for current active month
    const priorityDue = db.prepare(`
      SELECT s.id, s.roll_number, s.name, c.name as class_name, c.class_number, c.monthly_fee
      FROM students s
      JOIN classes c ON s.class_id = c.id
      WHERE s.academic_year_id = ?
        AND NOT EXISTS (
          SELECT 1 FROM payments p WHERE p.student_id = s.id AND p.month = ? AND p.academic_year_id = s.academic_year_id
        )
      ORDER BY c.class_number ASC, s.roll_number ASC
    `).all(ayId, activeMonth);

    const dueUnpaidTotal = priorityDue.reduce((sum, st) => sum + (st.monthly_fee || 0), 0);

    // Recent Transactions audit trail (latest payments & expenses combined)
    const recentPayments = db.prepare(`
      SELECT p.id, p.amount, p.payment_date as date, p.payment_time as time, p.receipt_no as ref_no,
        p.created_at, s.name as student_name, c.name as class_name, p.month
      FROM payments p
      LEFT JOIN students s ON p.student_id = s.id
      LEFT JOIN classes c ON p.class_id = c.id
      WHERE p.academic_year_id = ?
      ORDER BY p.id DESC
      LIMIT 25
    `).all(ayId);

    const recentExpenses = db.prepare(`
      SELECT e.id, e.amount, e.expense_date as date, e.expense_time as time, e.voucher_no as ref_no,
        e.created_at, e.description, COALESCE(ec.name, 'Expense') as category_name
      FROM expenses e
      LEFT JOIN expense_categories ec ON e.category_id = ec.id
      ORDER BY e.id DESC
      LIMIT 25
    `).all();

    const toSortKey = (row) => {
      const datePart = String(row.date || row.created_at || '').slice(0, 10);
      const created = String(row.created_at || datePart || '');
      return `${datePart} ${created} ${String(row.id).padStart(8, '0')}`;
    };

    const recentTransactions = [
      ...recentPayments.map(p => ({
        id: `p-${p.id}`,
        title: `${p.student_name || 'Student'} - ${p.class_name || 'Class'} ${p.month || ''} Fee`.trim(),
        subtitle: `Receipt #${p.ref_no || p.id}`,
        amount: p.amount,
        type: 'income',
        date: p.date,
        time: p.time || '',
        sortKey: toSortKey(p)
      })),
      ...recentExpenses.map(e => ({
        id: `e-${e.id}`,
        title: `${e.category_name} - ${e.description}`,
        subtitle: `Voucher #${e.ref_no || e.id}`,
        amount: e.amount,
        type: 'expense',
        date: e.date,
        time: e.time || '',
        sortKey: toSortKey(e)
      }))
    ].sort((a, b) => b.sortKey.localeCompare(a.sortKey)).slice(0, 30);

    // Monthly chart from real income (payments) and expenses
    const chartMonthMeta = [
      { key: 'January', short: 'Jan', num: '01' },
      { key: 'February', short: 'Feb', num: '02' },
      { key: 'March', short: 'Mar', num: '03' },
      { key: 'April', short: 'Apr', num: '04' },
      { key: 'May', short: 'May', num: '05' },
      { key: 'June', short: 'Jun', num: '06' },
      { key: 'July', short: 'Jul', num: '07' },
      { key: 'August', short: 'Aug', num: '08' },
      { key: 'September', short: 'Sep', num: '09' },
      { key: 'October', short: 'Oct', num: '10' },
      { key: 'November', short: 'Nov', num: '11' },
      { key: 'December', short: 'Dec', num: '12' }
    ];

    const incomeByMonthStmt = db.prepare(`
      SELECT COALESCE(SUM(amount), 0) as total FROM payments WHERE academic_year_id = ? AND month = ?
    `);
    const expenseByMonthStmt = db.prepare(`
      SELECT COALESCE(SUM(amount), 0) as total FROM expenses WHERE strftime('%m', expense_date) = ?
    `);

    const chartData = chartMonthMeta.map(m => {
      const income = incomeByMonthStmt.get(ayId, m.key).total;
      const expense = expenseByMonthStmt.get(m.num).total;
      const net = income - expense;
      const margin = income > 0 ? parseFloat(((net / income) * 100).toFixed(1)) : 0;
      return { month: m.short, income, expense, net, margin };
    });

    res.json({
      success: true,
      academicYear: currentAcademicYear,
      stats: {
        totalStudents: totalStudents.count,
        activeStudents: totalStudents.count,
        activeClasses: activeClasses.count,
        dueStudentsCount: dueCountRow.count,
        today: {
          income: todayIncomeRow.total,
          paymentsCount: todayIncomeRow.count,
          expense: todayExpenseRow.total,
          vouchersCount: todayExpenseRow.count,
          net: todayNet,
          margin: todayIncomeRow.total > 0 ? ((todayNet / todayIncomeRow.total) * 100).toFixed(1) : '0'
        },
        weekly: {
          income: weekIncomeRow.total,
          paymentsCount: weekIncomeRow.count || 0,
          expense: weekExpenseRow.total,
          vouchersCount: weekExpenseRow.count || 0,
          net: weekNet
        },
        monthly: {
          income: monthIncomeRow.total,
          paymentsCount: monthIncomeRow.count || 0,
          expense: monthExpenseRow.total,
          vouchersCount: monthExpenseRow.count || 0,
          net: monthNet
        },
        overall: {
          income: overallIncomeRow.total,
          paymentsCount: overallIncomeRow.count || 0,
          expense: overallExpenseRow.total,
          vouchersCount: overallExpenseRow.count || 0,
          net: overallNet
        }
      },
      classOverview: {
        classes: classOverview,
        totalProjected,
        totalCollectedSeptember,
        aggregateEfficiency: parseFloat(aggregateEfficiency)
      },
      priorityDue,
      dueUnpaidTotal,
      recentTransactions,
      chartData
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ----------------------------------------------------
// REPORTS
// ----------------------------------------------------
apiRouter.get('/reports/summary', (req, res) => {
  try {
    const ayId = resolveAcademicYear(req.query.academic_year_id).id;

    const classReports = db.prepare(`
      SELECT c.id, c.name, c.class_number, c.monthly_fee,
        COUNT(s.id) as total_students,
        (COUNT(s.id) * c.monthly_fee * 9) as expected_till_sep,
        COALESCE((SELECT SUM(p.amount) FROM payments p WHERE p.class_id = c.id AND p.academic_year_id = ?), 0) as total_collected
      FROM classes c
      LEFT JOIN students s ON s.class_id = c.id
      WHERE c.academic_year_id = ?
      GROUP BY c.id
      ORDER BY c.class_number ASC
    `).all(ayId, ayId);

    const expensesByCategory = db.prepare(`
      SELECT ec.name, COALESCE(SUM(e.amount), 0) as total
      FROM expense_categories ec
      LEFT JOIN expenses e ON ec.id = e.category_id
      GROUP BY ec.id
      ORDER BY total DESC
    `).all();

    res.json({
      success: true,
      classReports: classReports.map(c => ({
        ...c,
        due: Math.max(0, c.expected_till_sep - c.total_collected),
        efficiency: c.expected_till_sep > 0 ? ((c.total_collected / c.expected_till_sep) * 100).toFixed(1) : '100'
      })),
      expensesByCategory
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

apiRouter.get('/reports/financial', (req, res) => {
  try {
    const period = (req.query.period) || 'month';
    const ayRow = resolveAcademicYear(req.query.academic_year_id);
    const ayId = ayRow.id;
    const currentYear = ayRow.year;

    const clientDate = req.query.client_date || req.query.date || req.headers['x-client-date'];
    const { today, weekStart, weekEnd, monthStart, monthEnd } = getDateRangeContext(clientDate);
    const yearStart = `${currentYear}-01-01`;
    const yearEnd = `${currentYear}-12-31`;

    let startDate = monthStart;
    let endDate = monthEnd;

    if (period === 'today') {
      startDate = today;
      endDate = today;
    } else if (period === 'week') {
      startDate = weekStart;
      endDate = weekEnd;
    } else if (period === 'month') {
      startDate = monthStart;
      endDate = monthEnd;
    } else if (period === 'year') {
      startDate = yearStart;
      endDate = yearEnd;
    }

    const incomeRow = db.prepare(`
      SELECT COALESCE(SUM(amount), 0) as total, COUNT(id) as count
      FROM payments
      WHERE academic_year_id = ? AND (
        (payment_date >= ? AND payment_date <= ?)
        OR (date(created_at) >= ? AND date(created_at) <= ?)
        OR (date(created_at, '+6 hours') >= ? AND date(created_at, '+6 hours') <= ?)
      )
    `).get(ayId, startDate, endDate, startDate, endDate, startDate, endDate);

    const otherIncomeRow = db.prepare(`
      SELECT COALESCE(SUM(amount), 0) as total, COUNT(id) as count
      FROM other_collections
      WHERE collection_date >= ? AND collection_date <= ?
    `).get(startDate, endDate);
    if (otherIncomeRow) {
      incomeRow.total += (otherIncomeRow.total || 0);
      incomeRow.count += (otherIncomeRow.count || 0);
    }

    const expenseRow = db.prepare(`
      SELECT COALESCE(SUM(amount), 0) as total, COUNT(id) as count
      FROM expenses
      WHERE (
        (expense_date >= ? AND expense_date <= ?)
        OR (date(created_at) >= ? AND date(created_at) <= ?)
        OR (date(created_at, '+6 hours') >= ? AND date(created_at, '+6 hours') <= ?)
      )
    `).get(startDate, endDate, startDate, endDate, startDate, endDate);

    const expenseCategories = db.prepare(`
      SELECT ec.name as category, COALESCE(SUM(e.amount), 0) as total
      FROM expense_categories ec
      JOIN expenses e ON ec.id = e.category_id
      WHERE e.expense_date >= ? AND e.expense_date <= ?
      GROUP BY ec.id
      ORDER BY total DESC
    `).all(startDate, endDate);

    const classRevenue = db.prepare(`
      SELECT c.name as className, COALESCE(SUM(p.amount), 0) as total
      FROM classes c
      JOIN payments p ON c.id = p.class_id
      WHERE p.academic_year_id = ? AND p.payment_date >= ? AND p.payment_date <= ?
      GROUP BY c.id
      ORDER BY total DESC
    `).all(ayId, startDate, endDate);

    const months = [
      'January', 'February', 'March', 'April', 'May', 'June',
      'July', 'August', 'September', 'October', 'November', 'December'
    ];

    const monthlyTrajectory = months.map(m => {
      const inc = db.prepare(`
        SELECT COALESCE(SUM(amount), 0) as total FROM payments WHERE academic_year_id = ? AND month = ?
      `).get(ayId, m);

      // Estimated expense distribution for trajectory
      const exp = db.prepare(`
        SELECT COALESCE(SUM(amount), 0) as total FROM expenses WHERE strftime('%m', expense_date) = ? AND strftime('%Y', expense_date) = ?
      `).get(String(months.indexOf(m) + 1).padStart(2, '0'), String(currentYear));

      return {
        month: m,
        income: inc.total,
        expense: exp.total > 0 ? exp.total : 0
      };
    });

    res.json({
      success: true,
      data: {
        academicYear: currentYear,
        period,
        startDate,
        endDate,
        totalIncome: incomeRow.total,
        incomeCount: incomeRow.count,
        totalExpense: expenseRow.total,
        expenseCount: expenseRow.count,
        netBalance: incomeRow.total - expenseRow.total,
        expenseCategories,
        classRevenue,
        monthlyTrajectory
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ----------------------------------------------------
// VOUCHER PRINTING APIS (DAILY & MONTHLY DYNAMIC VOUCHERS)
// ----------------------------------------------------

apiRouter.get('/vouchers/daily', (req, res) => {
  try {
    const rawDate = req.query.date || getDhakaDate();
    const dateStr = /^\d{4}-\d{2}-\d{2}$/.test(rawDate) ? rawDate : getDhakaDate();

    // Format display date: e.g. "Monday, 28 September 2026"
    const [y, m, d] = dateStr.split('-').map(Number);
    const dateObj = new Date(y, m - 1, d);
    const formattedDate = dateObj.toLocaleDateString('en-GB', {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      year: 'numeric'
    });
    const dayOfWeek = dateObj.toLocaleDateString('en-GB', { weekday: 'long' });

    // 1. Fetch Expenses on date
    const expenseRows = db.prepare(`
      SELECT e.id, e.category_id, e.amount, e.description, e.expense_date, e.expense_time, e.voucher_no,
             ec.name as category_name
      FROM expenses e
      JOIN expense_categories ec ON e.category_id = ec.id
      WHERE e.expense_date = ?
      ORDER BY ec.name ASC, e.id ASC
    `).all(dateStr);

    // Group expenses by category
    const expenseCategoryMap = new Map();
    let totalExpense = 0;

    for (const exp of expenseRows) {
      totalExpense += exp.amount || 0;
      if (!expenseCategoryMap.has(exp.category_id)) {
        expenseCategoryMap.set(exp.category_id, {
          category_id: exp.category_id,
          category_name: exp.category_name,
          count: 0,
          total_amount: 0,
          items: []
        });
      }
      const cat = expenseCategoryMap.get(exp.category_id);
      cat.count += 1;
      cat.total_amount += exp.amount || 0;
      cat.items.push({
        id: exp.id,
        voucher_no: exp.voucher_no || `V-${exp.id}`,
        description: exp.description,
        time: exp.expense_time,
        amount: exp.amount
      });
    }

    const expenseCategories = Array.from(expenseCategoryMap.values());

    // 2. Fetch Student Fee Payments on date
    const paymentRows = db.prepare(`
      SELECT p.id, p.class_id, p.amount, p.payment_date, p.payment_time, p.payment_method, p.receipt_no, p.note,
             c.name as class_name, s.name as student_name, s.roll_number
      FROM payments p
      JOIN classes c ON p.class_id = c.id
      JOIN students s ON p.student_id = s.id
      WHERE p.payment_date = ?
      ORDER BY c.class_number ASC, p.id ASC
    `).all(dateStr);

    // Group payments by class/fee category
    const paymentCategoryMap = new Map();
    let totalPayment = 0;

    for (const p of paymentRows) {
      totalPayment += p.amount || 0;
      const catKey = p.class_id;
      if (!paymentCategoryMap.has(catKey)) {
        paymentCategoryMap.set(catKey, {
          class_id: p.class_id,
          category_name: p.class_name,
          count: 0,
          total_amount: 0,
          items: []
        });
      }
      const cat = paymentCategoryMap.get(catKey);
      cat.count += 1;
      cat.total_amount += p.amount || 0;
      cat.items.push({
        id: p.id,
        receipt_no: p.receipt_no,
        student_name: p.student_name,
        roll_number: p.roll_number,
        method: p.payment_method,
        time: p.payment_time,
        note: p.note,
        amount: p.amount
      });
    }

    // 3. Fetch Others Miscellaneous Income collections on date
    const otherRows = db.prepare(`
      SELECT id, description, amount, collection_date, collection_time, receipt_no, note
      FROM other_collections
      WHERE collection_date = ?
      ORDER BY id ASC
    `).all(dateStr);

    let otherIncomeTotal = 0;
    if (otherRows.length > 0) {
      const otherItems = [];
      for (const o of otherRows) {
        otherIncomeTotal += o.amount || 0;
        otherItems.push({
          id: o.id,
          receipt_no: o.receipt_no,
          student_name: o.description,
          roll_number: 'N/A',
          method: 'Cash',
          time: o.collection_time,
          note: o.note || o.description,
          amount: o.amount
        });
      }
      totalPayment += otherIncomeTotal;
      paymentCategoryMap.set('others', {
        class_id: 'others',
        category_name: 'Others Income',
        count: otherRows.length,
        total_amount: otherIncomeTotal,
        items: otherItems
      });
    }

    const paymentCategories = Array.from(paymentCategoryMap.values());

    res.json({
      success: true,
      data: {
        date: dateStr,
        formattedDate,
        dayOfWeek,
        expenses: {
          categories: expenseCategories,
          total: totalExpense,
          count: expenseRows.length
        },
        payments: {
          categories: paymentCategories,
          total: totalPayment,
          count: paymentRows.length + otherRows.length
        },
        netBalance: totalPayment - totalExpense
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

apiRouter.get('/vouchers/monthly', (req, res) => {
  try {
    const today = getDhakaDate();
    const currentYear = parseInt(today.split('-')[0], 10);
    const currentMonth = parseInt(today.split('-')[1], 10);

    let year = parseInt(req.query.year, 10);
    if (isNaN(year) || year < 2000 || year > 2100) {
      const activeAy = getActiveAcademicYear();
      year = activeAy ? activeAy.year : currentYear;
    }

    let month = parseInt(req.query.month, 10);
    if (isNaN(month) || month < 1 || month > 12) {
      month = currentMonth;
    }

    const monthPadded = String(month).padStart(2, '0');
    const monthPrefix = `${year}-${monthPadded}`;

    // Get exact number of days for this specific month and year
    // Automatically returns 28/29 for February, 30 for Apr/Jun/Sep/Nov, 31 for others
    const totalDays = new Date(year, month, 0).getDate();

    const monthObj = new Date(year, month - 1, 1);
    const monthName = monthObj.toLocaleDateString('en-US', { month: 'long' });
    const formattedMonthYear = `${monthName} ${year}`;

    // 1. Fetch all expenses for that month
    const expenseRows = db.prepare(`
      SELECT e.id, e.amount, e.expense_date, e.voucher_no, ec.name as category_name
      FROM expenses e
      JOIN expense_categories ec ON e.category_id = ec.id
      WHERE e.expense_date LIKE ?
      ORDER BY e.expense_date ASC, e.id ASC
    `).all(`${monthPrefix}-%`);

    const dailyExpensesMap = new Map();
    let totalExpense = 0;
    for (const exp of expenseRows) {
      totalExpense += exp.amount || 0;
      const d = exp.expense_date;
      if (!dailyExpensesMap.has(d)) {
        dailyExpensesMap.set(d, { total: 0, count: 0, items: [] });
      }
      const dayData = dailyExpensesMap.get(d);
      dayData.total += exp.amount || 0;
      dayData.count += 1;
      dayData.items.push(exp);
    }

    // 2. Fetch all payments for that month
    const paymentRows = db.prepare(`
      SELECT p.id, p.amount, p.payment_date, p.receipt_no, c.name as class_name, s.name as student_name
      FROM payments p
      JOIN classes c ON p.class_id = c.id
      JOIN students s ON p.student_id = s.id
      WHERE p.payment_date LIKE ?
      ORDER BY p.payment_date ASC, p.id ASC
    `).all(`${monthPrefix}-%`);

    const dailyPaymentsMap = new Map();
    let totalPayment = 0;
    for (const p of paymentRows) {
      totalPayment += p.amount || 0;
      const d = p.payment_date;
      if (!dailyPaymentsMap.has(d)) {
        dailyPaymentsMap.set(d, { total: 0, count: 0, items: [] });
      }
      const dayData = dailyPaymentsMap.get(d);
      dayData.total += p.amount || 0;
      dayData.count += 1;
      dayData.items.push(p);
    }

    // Include others collections for that month
    const otherMonthRows = db.prepare(`
      SELECT id, amount, collection_date, receipt_no, description
      FROM other_collections
      WHERE collection_date LIKE ?
      ORDER BY collection_date ASC, id ASC
    `).all(`${monthPrefix}-%`);

    for (const o of otherMonthRows) {
      totalPayment += o.amount || 0;
      const d = o.collection_date;
      if (!dailyPaymentsMap.has(d)) {
        dailyPaymentsMap.set(d, { total: 0, count: 0, items: [] });
      }
      const dayData = dailyPaymentsMap.get(d);
      dayData.total += o.amount || 0;
      dayData.count += 1;
      dayData.items.push({
        id: o.id,
        amount: o.amount,
        payment_date: o.collection_date,
        receipt_no: o.receipt_no,
        class_name: 'Others Income',
        student_name: o.description
      });
    }

    // 3. Build calendar matrix for every day (1..totalDays)
    const days = [];
    let daysWithExpenses = 0;
    let daysWithPayments = 0;

    for (let dayNum = 1; dayNum <= totalDays; dayNum++) {
      const dayStr = String(dayNum).padStart(2, '0');
      const dateKey = `${year}-${monthPadded}-${dayStr}`;
      const dayDate = new Date(year, month - 1, dayNum);
      const dayOfWeekShort = dayDate.toLocaleDateString('en-US', { weekday: 'short' });
      const dayOfWeekLong = dayDate.toLocaleDateString('en-US', { weekday: 'long' });

      const expData = dailyExpensesMap.get(dateKey) || { total: 0, count: 0, items: [] };
      const payData = dailyPaymentsMap.get(dateKey) || { total: 0, count: 0, items: [] };

      if (expData.total > 0) daysWithExpenses++;
      if (payData.total > 0) daysWithPayments++;

      days.push({
        day: dayNum,
        date: dateKey,
        formattedDay: `${dayStr} ${monthName.substring(0, 3)}`,
        dayOfWeek: dayOfWeekShort,
        dayOfWeekLong,
        isWeekend: (dayDate.getDay() === 5 || dayDate.getDay() === 6), // Friday / Saturday in Bangladesh
        expenseAmount: expData.total,
        expenseCount: expData.count,
        paymentAmount: payData.total,
        paymentCount: payData.count,
        netAmount: payData.total - expData.total
      });
    }

    // 4. Collect available years dynamically
    const ayYears = db.prepare('SELECT year FROM academic_years ORDER BY year DESC').all().map(r => r.year);
    const expYears = db.prepare("SELECT DISTINCT substr(expense_date, 1, 4) as y FROM expenses WHERE expense_date IS NOT NULL").all().map(r => parseInt(r.y, 10));
    const payYears = db.prepare("SELECT DISTINCT substr(payment_date, 1, 4) as y FROM payments WHERE payment_date IS NOT NULL").all().map(r => parseInt(r.y, 10));

    const yearSet = new Set([currentYear, ...ayYears, ...expYears, ...payYears]);
    const availableYears = Array.from(yearSet).filter(y => !isNaN(y) && y > 2000).sort((a, b) => b - a);

    res.json({
      success: true,
      data: {
        year,
        month,
        monthName,
        formattedMonthYear,
        totalDays,
        totalExpense,
        totalPayment,
        netBalance: totalPayment - totalExpense,
        daysWithExpenses,
        daysWithPayments,
        days,
        availableYears
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

const upload = multer({
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB limit
  fileFilter: (req, file, cb) => {
    if (file.originalname.match(/\.(sqlite|db|sqlite3)$/i) || file.mimetype.includes('sqlite') || file.mimetype.includes('octet-stream') || file.mimetype.includes('sql')) {
      cb(null, true);
    } else {
      cb(new Error('Only SQLite database files (.sqlite, .db) are allowed'));
    }
  }
});

apiRouter.post('/database/restore', requireSuperAdmin, upload.single('database_file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'No database file uploaded' });
    }

    const uploadedFilePath = req.file.path;
    const currentDbPath = getDbPath();

    // 1. Validate that the uploaded file is a valid SQLite database
    try {
      const headerBuf = Buffer.alloc(16);
      const fd = fs.openSync(uploadedFilePath, 'r');
      fs.readSync(fd, headerBuf, 0, 16, 0);
      fs.closeSync(fd);
      const sqliteHeader = headerBuf.toString('ascii', 0, 6);
      if (sqliteHeader !== 'SQLite') {
        fs.unlinkSync(uploadedFilePath);
        return res.status(400).json({ success: false, error: 'Uploaded file is not a valid SQLite database' });
      }
    } catch (err) {
      if (fs.existsSync(uploadedFilePath)) fs.unlinkSync(uploadedFilePath);
      return res.status(400).json({ success: false, error: 'Failed to read and validate SQLite database header: ' + err.message });
    }

    // 2. Automatically create a backup of the current database before replacing
    const backupDir = path.join(path.dirname(currentDbPath), 'backups');
    if (!fs.existsSync(backupDir)) {
      fs.mkdirSync(backupDir, { recursive: true });
    }
    const backupFilename = `coaching-backup-pre-restore-${new Date().toISOString().replace(/[:.]/g, '-')}.sqlite`;
    const backupPath = path.join(backupDir, backupFilename);
    if (fs.existsSync(currentDbPath)) {
      fs.copyFileSync(currentDbPath, backupPath);
    }

    // 3. Safely replace database file
    fs.copyFileSync(uploadedFilePath, currentDbPath);
    if (fs.existsSync(uploadedFilePath)) {
      fs.unlinkSync(uploadedFilePath);
    }

    // 4. Re-initialize database connection so the new database becomes active immediately
    await initDatabase();

    // 5. Audit Log entry (if audit_logs table exists, or console log)
    try {
      db.prepare(`
        INSERT INTO settings (key, value)
        VALUES ('last_db_restore', ? )
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `).run(new Date().toISOString());
    } catch (e) { }

    return res.json({
      success: true,
      message: 'Database restored successfully. Active database updated and re-initialized.',
      backupCreated: backupFilename
    });
  } catch (error) {
    console.error('Database restore failed:', error);
    return res.status(500).json({ success: false, error: 'Database restore failed: ' + error.message });
  }
});

// Download database backup
apiRouter.get('/database/backup', async (req, res) => {
  try {
    const dbPath = getDbPath();
    if (fs.existsSync(dbPath)) {
      const activeYear = getActiveAcademicYear();
      res.download(dbPath, `coaching-backup-${activeYear.year}-${new Date().toISOString().split('T')[0]}.sqlite`);
    } else {
      res.status(404).json({ success: false, error: 'Database file not found' });
    }
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});
apiRouter.get('/settings/system', requireSuperAdmin, (req, res) => {
  try {
    const dbPath = getDbPath();
    const stats = fs.existsSync(dbPath) ? fs.statSync(dbPath) : null;
    res.json({
      success: true,
      data: {
        appName: 'Coaching Center Management System',
        edition: 'Enterprise Desktop v2.6.0',
        platform: 'Windows Desktop (Offline-First)',
        runtime: `Node.js ${process.version}`,
        database: `SQLite 3 (${path.basename(dbPath)})`,
        dbPath: dbPath,
        dbSize: stats ? `${(stats.size / 1024).toFixed(1)} KB` : 'N/A',
        lastModified: stats ? stats.mtime.toISOString().replace('T', ' ').substring(0, 19) : 'N/A',
        storageMode: 'Single Source of Truth (Zero External Cloud Dependency)'
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

apiRouter.post('/seed', requireSuperAdmin, (req, res) => {
  try {
    seedDefaultDataIfEmpty(true);
    res.json({ success: true, message: 'Database reset and re-seeded with realistic records successfully' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ----------------------------------------------------
// ACADEMIC & EXAMINATION HELPER FUNCTIONS
// ----------------------------------------------------

/**
 * Calculate final subject score according to stream and exam type.
 * General: 30% Monthly Test average + 70% Main Exam, rounded to nearest 0.5.
 * Hifz: Direct sum of CT marks and Final Exam marks (capped at 100).
 */
function calculateSubjectScore(stream, examType, marks) {
  if (stream === 'Hifz') {
    const ct = (marks.ct_marks !== null && marks.ct_marks !== undefined && marks.ct_marks !== '') ? Number(marks.ct_marks) : 0;
    const final = (marks.final_exam !== null && marks.final_exam !== undefined && marks.final_exam !== '') ? Number(marks.final_exam) : 0;
    const raw = ct + final;
    return Math.min(100, Math.round(raw * 2) / 2);
  }

  // General Stream
  let mt1 = null;
  let mt2 = null;
  let mainExam = null;

  if (examType === 'final') {
    mt1 = (marks.mt3 !== null && marks.mt3 !== undefined && marks.mt3 !== '') ? Number(marks.mt3) : null;
    mt2 = (marks.mt4 !== null && marks.mt4 !== undefined && marks.mt4 !== '') ? Number(marks.mt4) : null;
    mainExam = (marks.final_exam !== null && marks.final_exam !== undefined && marks.final_exam !== '') ? Number(marks.final_exam) : null;
  } else {
    // Default to Half-Yearly
    mt1 = (marks.mt1 !== null && marks.mt1 !== undefined && marks.mt1 !== '') ? Number(marks.mt1) : null;
    mt2 = (marks.mt2 !== null && marks.mt2 !== undefined && marks.mt2 !== '') ? Number(marks.mt2) : null;
    mainExam = (marks.main_exam !== null && marks.main_exam !== undefined && marks.main_exam !== '') ? Number(marks.main_exam) : null;
  }

  let mtCount = 0;
  let mtSum = 0;
  if (mt1 !== null && !isNaN(mt1)) { mtSum += mt1; mtCount++; }
  if (mt2 !== null && !isNaN(mt2)) { mtSum += mt2; mtCount++; }

  const mtAvg = mtCount > 0 ? (mtSum / mtCount) : 0;
  const mtComponent = (mtAvg * 30) / 100;
  const mainComponent = (mainExam !== null && !isNaN(mainExam)) ? (mainExam * 70) / 100 : 0;

  const rawTotal = mtComponent + mainComponent;
  // Nearest 0.5 rounding: Math.round(score * 2) / 2
  return Math.min(100, Math.round(rawTotal * 2) / 2);
}

/**
 * Standard ABMS grading scale:
 * 90-100: A+ (5.00) Excellent
 * 80-89:  A  (4.50) Very Good
 * 70-79:  B+ (4.00) Good
 * 60-69:  B  (3.00) Satisfactory
 * 50-59:  C  (2.00) Poor
 * 40-49:  D  (1.00) Very Poor
 * 0-39:   F  (0.00) Fail
 */
function getGradeAndGpa(score) {
  const s = Math.round(score * 2) / 2;
  if (s >= 90) return { grade: 'A+', gpa: 5.00, remarks: 'Excellent' };
  if (s >= 80) return { grade: 'A', gpa: 4.50, remarks: 'Very Good' };
  if (s >= 70) return { grade: 'B+', gpa: 4.00, remarks: 'Good' };
  if (s >= 60) return { grade: 'B', gpa: 3.00, remarks: 'Satisfactory' };
  if (s >= 50) return { grade: 'C', gpa: 2.00, remarks: 'Poor' };
  if (s >= 40) return { grade: 'D', gpa: 1.00, remarks: 'Very Poor' };
  return { grade: 'F', gpa: 0.00, remarks: 'Fail' };
}

// ----------------------------------------------------
// TEACHERS MANAGEMENT API (FIXED SALARY & ADVANCES)
// ----------------------------------------------------
apiRouter.get('/teachers', (req, res) => {
  try {
    const teachers = db.prepare('SELECT * FROM teachers ORDER BY name ASC').all();

    const results = teachers.map(t => {
      // Assignments
      const assignments = db.prepare(`
        SELECT ta.id as assignment_id, ta.subject_id, s.name as subject_name, s.code as subject_code,
               c.id as class_id, c.name as class_name, c.stream, c.class_number
        FROM teacher_assignments ta
        JOIN subjects s ON ta.subject_id = s.id
        JOIN classes c ON s.class_id = c.id
        WHERE ta.teacher_id = ? AND ta.is_active = 1
        ORDER BY c.stream ASC, c.class_number ASC, s.name ASC
      `).all(t.id);

      // Class Teacher classes
      const classTeacherClasses = db.prepare(`
        SELECT id, name, stream, class_number
        FROM classes
        WHERE class_teacher_id = ?
        ORDER BY stream ASC, class_number ASC
      `).all(t.id);

      // Advances
      const advRow = db.prepare('SELECT COALESCE(SUM(amount), 0) as total FROM teacher_advances WHERE teacher_id = ?').get(t.id);
      const totalAdvance = advRow ? advRow.total : 0;

      // Deducted from salary payments
      const dedRow = db.prepare('SELECT COALESCE(SUM(advance_deducted), 0) as total, COALESCE(SUM(net_paid), 0) as total_net, COALESCE(SUM(fixed_salary), 0) as total_gross FROM teacher_salary_payments WHERE teacher_id = ?').get(t.id);
      const totalAdvanceRecovered = dedRow ? dedRow.total : 0;
      const totalSalaryPaid = dedRow ? dedRow.total_net : 0;

      const outstandingAdvance = Math.max(0, totalAdvance - totalAdvanceRecovered);
      const fixedSalary = t.fixed_salary || 0;
      // Current payable for upcoming cycle: fixed_salary minus unrecovered advance
      const currentPayable = Math.max(0, fixedSalary - outstandingAdvance);

      return {
        ...t,
        primary_phone: t.primary_contact === 'secondary' && t.phone_secondary ? t.phone_secondary : (t.phone || ''),
        assignments,
        assigned_count: assignments.length,
        class_teacher_classes: classTeacherClasses,
        is_class_teacher: classTeacherClasses.length > 0,
        total_advance: totalAdvance,
        advance_recovered: totalAdvanceRecovered,
        outstanding_advance: outstandingAdvance,
        total_salary_paid: totalSalaryPaid,
        current_payable: currentPayable
      };
    });

    res.json({ success: true, data: results });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Teachers Dashboard Summary
apiRouter.get('/teachers/dashboard-summary', (req, res) => {
  try {
    const teachersCount = db.prepare('SELECT COUNT(*) as count FROM teachers WHERE is_active = 1').get().count;

    const allTeachers = db.prepare('SELECT id, fixed_salary FROM teachers WHERE is_active = 1').all();
    let totalFixedSalaryCommitment = 0;
    let totalOutstandingAdvances = 0;

    for (const t of allTeachers) {
      totalFixedSalaryCommitment += t.fixed_salary || 0;
      const adv = db.prepare('SELECT COALESCE(SUM(amount), 0) as total FROM teacher_advances WHERE teacher_id = ?').get(t.id).total;
      const ded = db.prepare('SELECT COALESCE(SUM(advance_deducted), 0) as total FROM teacher_salary_payments WHERE teacher_id = ?').get(t.id).total;
      totalOutstandingAdvances += Math.max(0, adv - ded);
    }

    const todayMonth = getDhakaDate().substring(0, 7);
    const paidThisMonthRow = db.prepare("SELECT COALESCE(SUM(net_paid), 0) as total FROM teacher_salary_payments WHERE payment_date LIKE ?").get(`${todayMonth}%`);
    const totalPaidThisMonth = paidThisMonthRow ? paidThisMonthRow.total : 0;

    res.json({
      success: true,
      data: {
        totalTeachers: teachersCount,
        totalFixedSalaryCommitment,
        totalOutstandingAdvances,
        totalPaidThisMonth,
        totalPayable: Math.max(0, totalFixedSalaryCommitment - totalOutstandingAdvances)
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Teacher Payment & Salary Summary (Month-wise)
apiRouter.get('/teachers/payment-summary', (req, res) => {
  try {
    const today = getDhakaDate();
    const todayMonth = today.substring(0, 7);
    const selectedMonth = (req.query.month && /^\d{4}-\d{2}$/.test(req.query.month)) ? req.query.month : todayMonth;

    const allTeachers = db.prepare('SELECT id, name, phone, fixed_salary, stream FROM teachers ORDER BY name ASC').all();

    let totalFixedSalary = 0;
    let totalPaidInMonth = 0;
    let totalAdvanceDeductedInMonth = 0;

    const teacherBreakdown = allTeachers.map(t => {
      totalFixedSalary += t.fixed_salary || 0;

      // Payment in this month
      const payRow = db.prepare('SELECT * FROM teacher_salary_payments WHERE teacher_id = ? AND salary_month = ?').get(t.id, selectedMonth);

      // Advances outstanding
      const adv = db.prepare('SELECT COALESCE(SUM(amount), 0) as total FROM teacher_advances WHERE teacher_id = ?').get(t.id).total;
      const ded = db.prepare('SELECT COALESCE(SUM(advance_deducted), 0) as total FROM teacher_salary_payments WHERE teacher_id = ?').get(t.id).total;
      const outstandingAdvance = Math.max(0, adv - ded);

      const netPaid = payRow ? payRow.net_paid : 0;
      const advDeducted = payRow ? payRow.advance_deducted : 0;

      totalPaidInMonth += netPaid;
      totalAdvanceDeductedInMonth += advDeducted;

      return {
        teacher_id: t.id,
        teacher_name: t.name,
        teacher_phone: t.phone || '',
        fixed_salary: t.fixed_salary || 0,
        stream: t.stream || 'General',
        is_paid: Boolean(payRow),
        payment_date: payRow ? payRow.payment_date : null,
        salary_month: payRow ? payRow.salary_month : selectedMonth,
        payment_method: payRow ? (payRow.payment_method || 'Cash') : 'Cash',
        note: payRow ? (payRow.note || '') : '',
        net_paid: netPaid,
        advance_deducted: advDeducted,
        outstanding_advance: outstandingAdvance,
        payable_amount: payRow ? 0 : Math.max(0, (t.fixed_salary || 0) - outstandingAdvance)
      };
    });

    const [yearStr, monthStr] = selectedMonth.split('-');
    const dateObj = new Date(parseInt(yearStr, 10), parseInt(monthStr, 10) - 1, 1);
    const selectedMonthName = dateObj.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });

    let paymentsQuery = `
      SELECT tsp.*, t.name as teacher_name, t.phone as teacher_phone
      FROM teacher_salary_payments tsp
      JOIN teachers t ON tsp.teacher_id = t.id
      WHERE 1=1
    `;
    const pParams = [];
    if (req.query.month && /^\d{4}-\d{2}$/.test(req.query.month)) {
      paymentsQuery += ` AND tsp.salary_month = ?`;
      pParams.push(req.query.month);
    }
    if (req.query.teacher_id) {
      paymentsQuery += ` AND tsp.teacher_id = ?`;
      pParams.push(parseInt(req.query.teacher_id, 10));
    }
    paymentsQuery += ` ORDER BY tsp.payment_date DESC, tsp.id DESC`;
    const paymentsList = db.prepare(paymentsQuery).all(...pParams);

    res.json({
      success: true,
      data: {
        todayDate: today,
        selectedMonth,
        selectedMonthName,
        totalFixedSalary,
        totalPaidInMonth,
        totalAdvanceDeductedInMonth,
        teachers: teacherBreakdown,
        payments: paymentsList,
        salary_payments: paymentsList,
        salaryPayments: paymentsList
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Single Teacher Details with Salary & Advance History
apiRouter.get('/teachers/:id', (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const teacher = db.prepare('SELECT * FROM teachers WHERE id = ?').get(id);
    if (!teacher) {
      return res.status(404).json({ success: false, error: 'Teacher not found' });
    }

    const assignments = db.prepare(`
      SELECT ta.id as assignment_id, ta.subject_id, s.name as subject_name, s.code as subject_code,
             c.id as class_id, c.name as class_name, c.stream, c.class_number
      FROM teacher_assignments ta
      JOIN subjects s ON ta.subject_id = s.id
      JOIN classes c ON s.class_id = c.id
      WHERE ta.teacher_id = ? AND ta.is_active = 1
      ORDER BY c.stream ASC, c.class_number ASC, s.name ASC
    `).all(id);

    const advances = db.prepare('SELECT * FROM teacher_advances WHERE teacher_id = ? ORDER BY advance_date DESC, id DESC').all(id);
    const salaryPayments = db.prepare('SELECT * FROM teacher_salary_payments WHERE teacher_id = ? ORDER BY salary_month DESC, id DESC').all(id);

    const totalAdv = advances.reduce((sum, a) => sum + (a.amount || 0), 0);
    const totalRec = salaryPayments.reduce((sum, p) => sum + (p.advance_deducted || 0), 0);
    const totalNetPaid = salaryPayments.reduce((sum, p) => sum + (p.net_paid || 0), 0);
    const outstandingAdvance = Math.max(0, totalAdv - totalRec);

    // Keep historical payments accessible for audit
    const historicalPayments = db.prepare('SELECT * FROM teacher_payments WHERE teacher_id = ? ORDER BY payment_date DESC, id DESC').all(id);

    // Class Teacher classes
    const classTeacherClasses = db.prepare(`
      SELECT id, name, stream, class_number
      FROM classes
      WHERE class_teacher_id = ?
      ORDER BY stream ASC, class_number ASC
    `).all(id);

    res.json({
      success: true,
      data: {
        ...teacher,
        primary_phone: teacher.primary_contact === 'secondary' && teacher.phone_secondary ? teacher.phone_secondary : (teacher.phone || ''),
        assignments,
        class_teacher_classes: classTeacherClasses,
        is_class_teacher: classTeacherClasses.length > 0,
        advances,
        salary_payments: salaryPayments,
        historical_payments: historicalPayments,
        total_advance: totalAdv,
        advance_recovered: totalRec,
        outstanding_advance: outstandingAdvance,
        total_salary_paid: totalNetPaid,
        current_payable: Math.max(0, (teacher.fixed_salary || 0) - outstandingAdvance)
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Create Teacher (with fixed monthly salary, dual phone, stream, class-subject assignments, and class teacher)
apiRouter.post('/teachers', requireStaffOrAdmin, (req, res) => {
  try {
    const {
      name,
      email,
      phone,
      phone_secondary,
      primary_contact,
      fixed_salary,
      stream,
      assigned_subject_ids,
      class_teacher_class_ids
    } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({ success: false, error: 'Teacher name is required' });
    }

    const tPhone = phone ? phone.trim() : '';
    const tPhoneSec = phone_secondary ? phone_secondary.trim() : '';
    const tEmail = email ? email.trim() : '';
    const tPrimaryContact = primary_contact === 'secondary' ? 'secondary' : 'primary';
    const tFixedSalary = parseFloat(fixed_salary) || 0;
    const tStream = stream === 'Hifz' ? 'Hifz' : 'General';

    // Validate subject assignments (check that no subject is already actively assigned)
    const subjectIds = Array.isArray(assigned_subject_ids) ? assigned_subject_ids.map(Number).filter(Boolean) : [];
    if (subjectIds.length > 0) {
      for (const sId of subjectIds) {
        const conflict = db.prepare(`
          SELECT ta.*, t.name as teacher_name, s.name as subject_name, c.name as class_name, c.stream
          FROM teacher_assignments ta
          JOIN teachers t ON ta.teacher_id = t.id
          JOIN subjects s ON ta.subject_id = s.id
          JOIN classes c ON s.class_id = c.id
          WHERE ta.subject_id = ? AND ta.is_active = 1
        `).get(sId);

        if (conflict) {
          return res.status(400).json({
            success: false,
            error: `Subject "${conflict.subject_name}" in ${conflict.stream} ${conflict.class_name} is already assigned to teacher "${conflict.teacher_name}". A subject can have only one active teacher.`
          });
        }
      }
    }

    // Validate class teacher assignments (at most 1 active class teacher per class)
    const ctClassIds = Array.isArray(class_teacher_class_ids) ? class_teacher_class_ids.map(Number).filter(Boolean) : [];
    if (ctClassIds.length > 0) {
      for (const cId of ctClassIds) {
        const conflict = db.prepare(`
          SELECT c.name, t.name as teacher_name
          FROM classes c
          JOIN teachers t ON c.class_teacher_id = t.id
          WHERE c.id = ? AND t.is_active = 1
        `).get(cId);

        if (conflict) {
          return res.status(400).json({
            success: false,
            error: `Class "${conflict.name}" already has an active Class Teacher: "${conflict.teacher_name}".`
          });
        }
      }
    }

    // Insert teacher
    const stmt = db.prepare(`
      INSERT INTO teachers (name, email, phone, phone_secondary, primary_contact, fixed_salary, stream, status, is_active)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'Active', 1)
    `);
    const result = stmt.run(name.trim(), tEmail, tPhone, tPhoneSec, tPrimaryContact, tFixedSalary, tStream);
    const newTeacherId = Number(result.lastInsertRowid);

    // Insert assignments with required NOT NULL columns (class_id, stream, academic_year_id)
    for (const sId of subjectIds) {
      const subj = db.prepare('SELECT class_id, stream, academic_year_id FROM subjects WHERE id = ?').get(sId);
      if (subj) {
        db.prepare(`
          INSERT INTO teacher_assignments (teacher_id, subject_id, class_id, stream, academic_year_id, is_active)
          VALUES (?, ?, ?, ?, ?, 1)
        `).run(newTeacherId, sId, subj.class_id, subj.stream || tStream, subj.academic_year_id || getActiveAcademicYearId());
      }
    }

    // Assign class teacher relationships
    for (const cId of ctClassIds) {
      db.prepare('UPDATE classes SET class_teacher_id = ? WHERE id = ?').run(newTeacherId, cId);
    }

    const newTeacher = db.prepare('SELECT * FROM teachers WHERE id = ?').get(newTeacherId);
    res.json({
      success: true,
      message: `Teacher "${newTeacher.name}" added successfully with fixed salary ৳${tFixedSalary.toLocaleString()}`,
      data: newTeacher
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Update Teacher (with assignment & class teacher uniqueness validation)
apiRouter.put('/teachers/:id', requireStaffOrAdmin, (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const teacher = db.prepare('SELECT * FROM teachers WHERE id = ?').get(id);
    if (!teacher) {
      return res.status(404).json({ success: false, error: 'Teacher not found' });
    }

    const {
      name,
      email,
      phone,
      phone_secondary,
      primary_contact,
      fixed_salary,
      stream,
      is_active,
      assigned_subject_ids,
      class_teacher_class_ids
    } = req.body;

    const tName = (name && name.trim()) ? name.trim() : teacher.name;
    const tEmail = email !== undefined ? email.trim() : (teacher.email || '');
    const tPhone = phone !== undefined ? phone.trim() : teacher.phone;
    const tPhoneSec = phone_secondary !== undefined ? phone_secondary.trim() : (teacher.phone_secondary || '');
    const tPrimaryContact = primary_contact !== undefined ? (primary_contact === 'secondary' ? 'secondary' : 'primary') : teacher.primary_contact;
    const tFixedSalary = fixed_salary !== undefined ? (parseFloat(fixed_salary) || 0) : teacher.fixed_salary;
    const tStream = stream !== undefined ? (stream === 'Hifz' ? 'Hifz' : 'General') : (teacher.stream || 'General');
    const tIsActive = is_active !== undefined ? (is_active ? 1 : 0) : (teacher.is_active ?? 1);
    const tStatus = tIsActive ? 'Active' : 'Inactive';

    // Validate subject assignments if passed
    if (assigned_subject_ids !== undefined) {
      const subjectIds = Array.isArray(assigned_subject_ids) ? assigned_subject_ids.map(Number).filter(Boolean) : [];
      for (const sId of subjectIds) {
        const conflict = db.prepare(`
          SELECT ta.*, t.name as teacher_name, s.name as subject_name, c.name as class_name, c.stream
          FROM teacher_assignments ta
          JOIN teachers t ON ta.teacher_id = t.id
          JOIN subjects s ON ta.subject_id = s.id
          JOIN classes c ON s.class_id = c.id
          WHERE ta.subject_id = ? AND ta.is_active = 1 AND ta.teacher_id != ?
        `).get(sId, id);

        if (conflict) {
          return res.status(400).json({
            success: false,
            error: `Subject "${conflict.subject_name}" in ${conflict.stream} ${conflict.class_name} is already assigned to teacher "${conflict.teacher_name}".`
          });
        }
      }

      // Deactivate old assignments for this teacher
      db.prepare('DELETE FROM teacher_assignments WHERE teacher_id = ?').run(id);

      // Insert updated assignments with required NOT NULL fields
      for (const sId of subjectIds) {
        const subj = db.prepare('SELECT class_id, stream, academic_year_id FROM subjects WHERE id = ?').get(sId);
        if (subj) {
          db.prepare(`
            INSERT INTO teacher_assignments (teacher_id, subject_id, class_id, stream, academic_year_id, is_active)
            VALUES (?, ?, ?, ?, ?, 1)
          `).run(id, sId, subj.class_id, subj.stream || tStream, subj.academic_year_id || getActiveAcademicYearId());
        }
      }
    }

    // Validate and update class teacher assignments if passed
    if (class_teacher_class_ids !== undefined) {
      const ctClassIds = Array.isArray(class_teacher_class_ids) ? class_teacher_class_ids.map(Number).filter(Boolean) : [];
      for (const cId of ctClassIds) {
        const conflict = db.prepare(`
          SELECT c.name, t.name as teacher_name
          FROM classes c
          JOIN teachers t ON c.class_teacher_id = t.id
          WHERE c.id = ? AND t.is_active = 1 AND t.id != ?
        `).get(cId, id);

        if (conflict) {
          return res.status(400).json({
            success: false,
            error: `Class "${conflict.name}" already has an active Class Teacher: "${conflict.teacher_name}".`
          });
        }
      }

      // Clear existing class teacher relationships for this teacher
      db.prepare('UPDATE classes SET class_teacher_id = NULL WHERE class_teacher_id = ?').run(id);

      // Assign new relationships
      for (const cId of ctClassIds) {
        db.prepare('UPDATE classes SET class_teacher_id = ? WHERE id = ?').run(id, cId);
      }
    }

    // If teacher is deactivated, release assignments and class teacher roles
    if (tIsActive === 0) {
      db.prepare('UPDATE teacher_assignments SET is_active = 0 WHERE teacher_id = ?').run(id);
      db.prepare('UPDATE classes SET class_teacher_id = NULL WHERE class_teacher_id = ?').run(id);
    }

    db.prepare(`
      UPDATE teachers
      SET name = ?, email = ?, phone = ?, phone_secondary = ?, primary_contact = ?, fixed_salary = ?, stream = ?, status = ?, is_active = ?
      WHERE id = ?
    `).run(tName, tEmail, tPhone, tPhoneSec, tPrimaryContact, tFixedSalary, tStream, tStatus, tIsActive, id);

    const updated = db.prepare('SELECT * FROM teachers WHERE id = ?').get(id);
    res.json({ success: true, message: `Teacher "${updated.name}" updated successfully`, data: updated });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Soft-deactivate teacher (preserve all historical salary, exam, and assignment records)
apiRouter.delete('/teachers/:id', requireDeletePermission, (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const teacher = db.prepare('SELECT * FROM teachers WHERE id = ?').get(id);
    if (!teacher) {
      return res.status(404).json({ success: false, error: 'Teacher not found' });
    }

    // Soft deactivate teacher and release active assignments & class teacher status
    db.prepare("UPDATE teachers SET is_active = 0, status = 'Inactive' WHERE id = ?").run(id);
    db.prepare('UPDATE teacher_assignments SET is_active = 0 WHERE teacher_id = ?').run(id);
    db.prepare('UPDATE classes SET class_teacher_id = NULL WHERE class_teacher_id = ?').run(id);

    res.json({ success: true, message: `Teacher "${teacher.name}" deactivated successfully. Historical records preserved.` });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Record Teacher Salary Advance (recorded once in expenses to prevent duplicate accounting)
apiRouter.post('/teachers/:id/advance', (req, res) => {
  try {
    const teacherId = parseInt(req.params.id, 10);
    const teacher = db.prepare('SELECT * FROM teachers WHERE id = ?').get(teacherId);
    if (!teacher) {
      return res.status(404).json({ success: false, error: 'Teacher not found' });
    }

    const { amount, advance_date, note, payment_method } = req.body;
    const advAmount = parseFloat(amount);
    if (isNaN(advAmount) || advAmount <= 0) {
      return res.status(400).json({ success: false, error: 'Invalid advance amount' });
    }

    const advDate = (advance_date && /^\d{4}-\d{2}-\d{2}$/.test(advance_date)) ? advance_date : getDhakaDate();
    const advNote = note && note.trim() ? note.trim() : `Salary advance for ${teacher.name}`;
    const payMethod = payment_method || 'Cash';

    // 1. Insert into teacher_advances
    const advResult = db.prepare(`
      INSERT INTO teacher_advances (teacher_id, amount, advance_date, note, payment_method, is_recovered)
      VALUES (?, ?, ?, ?, ?, 0)
    `).run(teacherId, advAmount, advDate, advNote, payMethod);

    // 2. Ensure "Teacher Salary" expense category exists
    let teacherCat = db.prepare("SELECT id FROM expense_categories WHERE name = 'Teacher Salary'").get();
    if (!teacherCat) {
      const catRes = db.prepare("INSERT INTO expense_categories (name, is_default) VALUES ('Teacher Salary', 1)").run();
      teacherCat = { id: Number(catRes.lastInsertRowid) };
    }

    // 3. Generate sequential voucher number
    const maxVoucher = db.prepare('SELECT COUNT(*) as count FROM expenses').get();
    const voucherNo = `V-${String(100 + (maxVoucher ? maxVoucher.count : 0) + 1)}`;

    // 4. Create matching expense entry linked to Teacher Salary expense
    db.prepare(`
      INSERT INTO expenses (category_id, amount, description, expense_date, expense_time, voucher_no)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      teacherCat.id,
      advAmount,
      `Teacher Salary Advance: ${teacher.name} (${advNote})`,
      advDate,
      getDhakaTime(),
      voucherNo
    );

    // Calculate updated outstanding advance
    const totalAdv = db.prepare('SELECT COALESCE(SUM(amount), 0) as total FROM teacher_advances WHERE teacher_id = ?').get(teacherId).total;
    const totalRec = db.prepare('SELECT COALESCE(SUM(advance_deducted), 0) as total FROM teacher_salary_payments WHERE teacher_id = ?').get(teacherId).total;
    const outstanding = Math.max(0, totalAdv - totalRec);

    res.json({
      success: true,
      message: `Advance of ৳${advAmount.toLocaleString()} recorded for ${teacher.name}. Outstanding advance: ৳${outstanding.toLocaleString()}.`,
      data: {
        advance_id: Number(advResult.lastInsertRowid),
        amount: advAmount,
        advance_date: advDate,
        outstanding_advance: outstanding
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Pay Fixed Monthly Salary (with automatic advance adjustment & zero double expense counting)
apiRouter.post('/teachers/:id/pay-fixed', (req, res) => {
  try {
    const teacherId = parseInt(req.params.id, 10);
    const teacher = db.prepare('SELECT * FROM teachers WHERE id = ?').get(teacherId);
    if (!teacher) {
      return res.status(404).json({ success: false, error: 'Teacher not found' });
    }

    const { salary_month, payment_date, note, payment_method } = req.body;
    if (!salary_month || !/^\d{4}-\d{2}$/.test(salary_month)) {
      return res.status(400).json({ success: false, error: 'Valid salary month (YYYY-MM) is required' });
    }

    // Check duplicate payment for same month
    const existingPayment = db.prepare('SELECT * FROM teacher_salary_payments WHERE teacher_id = ? AND salary_month = ?').get(teacherId, salary_month);
    if (existingPayment) {
      return res.status(400).json({
        success: false,
        error: `Salary for month ${salary_month} has already been paid on ${existingPayment.payment_date} (Net: ৳${existingPayment.net_paid.toLocaleString()}).`
      });
    }

    const fixedSalary = teacher.fixed_salary || 0;
    if (fixedSalary <= 0) {
      return res.status(400).json({ success: false, error: 'Teacher has no fixed salary configured. Please update teacher fixed salary first.' });
    }

    // Calculate outstanding advance balance
    const totalAdvRow = db.prepare('SELECT COALESCE(SUM(amount), 0) as total FROM teacher_advances WHERE teacher_id = ?').get(teacherId);
    const totalAdv = totalAdvRow ? totalAdvRow.total : 0;

    const totalRecRow = db.prepare('SELECT COALESCE(SUM(advance_deducted), 0) as total FROM teacher_salary_payments WHERE teacher_id = ?').get(teacherId);
    const totalRec = totalRecRow ? totalRecRow.total : 0;

    const outstandingAdvance = Math.max(0, totalAdv - totalRec);

    // Automatic deduction of advance against salary (cannot exceed fixed_salary or outstandingAdvance)
    const advanceDeducted = Math.min(fixedSalary, outstandingAdvance);
    const netPaid = fixedSalary - advanceDeducted;

    const payDate = (payment_date && /^\d{4}-\d{2}-\d{2}$/.test(payment_date)) ? payment_date : getDhakaDate();
    const payMethod = payment_method || 'Cash';
    const payNote = note && note.trim()
      ? note.trim()
      : `Monthly salary for ${salary_month} (Gross: ৳${fixedSalary}, Advance Adjusted: ৳${advanceDeducted}, Net Paid: ৳${netPaid})`;

    // 1. Insert into teacher_salary_payments
    const payResult = db.prepare(`
      INSERT INTO teacher_salary_payments (teacher_id, salary_month, fixed_salary, advance_deducted, net_paid, payment_date, note, payment_method)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(teacherId, salary_month, fixedSalary, advanceDeducted, netPaid, payDate, payNote, payMethod);

    // 2. Only record netPaid into expenses (advance portion was ALREADY recorded when advance was given)
    // This strictly prevents duplicate expense accounting!
    let voucherNo = null;
    if (netPaid > 0) {
      let teacherCat = db.prepare("SELECT id FROM expense_categories WHERE name = 'Teacher Salary'").get();
      if (!teacherCat) {
        const catRes = db.prepare("INSERT INTO expense_categories (name, is_default) VALUES ('Teacher Salary', 1)").run();
        teacherCat = { id: Number(catRes.lastInsertRowid) };
      }

      const maxVoucher = db.prepare('SELECT COUNT(*) as count FROM expenses').get();
      voucherNo = `V-${String(100 + (maxVoucher ? maxVoucher.count : 0) + 1)}`;

      db.prepare(`
        INSERT INTO expenses (category_id, amount, description, expense_date, expense_time, voucher_no)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        teacherCat.id,
        netPaid,
        `Fixed Salary (${salary_month}): ${teacher.name} [Gross: ৳${fixedSalary.toLocaleString()}, Advance Adjusted: ৳${advanceDeducted.toLocaleString()}]`,
        payDate,
        getDhakaTime(),
        voucherNo
      );
    }

    // 3. Mark advances as recovered if fully repaid
    const newOutstandingAdvance = Math.max(0, outstandingAdvance - advanceDeducted);
    if (newOutstandingAdvance === 0) {
      db.prepare('UPDATE teacher_advances SET is_recovered = 1 WHERE teacher_id = ?').run(teacherId);
    }

    res.json({
      success: true,
      message: `Salary for ${salary_month} processed: Gross ৳${fixedSalary.toLocaleString()}, Advance Adjusted ৳${advanceDeducted.toLocaleString()}, Net Paid ৳${netPaid.toLocaleString()}.`,
      data: {
        payment_id: Number(payResult.lastInsertRowid),
        salary_month,
        fixed_salary: fixedSalary,
        advance_deducted: advanceDeducted,
        net_paid: netPaid,
        remaining_advance: newOutstandingAdvance,
        voucher_no: voucherNo
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Teacher Advance Statement
apiRouter.get('/teachers/advance-statement', (req, res) => {
  try {
    let query = `
      SELECT ta.*, t.name as teacher_name, t.phone as teacher_phone, t.fixed_salary
      FROM teacher_advances ta
      JOIN teachers t ON ta.teacher_id = t.id
      WHERE 1=1
    `;
    const params = [];
    if (req.query.month && /^\d{4}-\d{2}$/.test(req.query.month)) {
      query += ` AND ta.advance_date LIKE ?`;
      params.push(`${req.query.month}%`);
    }
    if (req.query.teacher_id) {
      query += ` AND ta.teacher_id = ?`;
      params.push(parseInt(req.query.teacher_id, 10));
    }
    query += ` ORDER BY ta.advance_date DESC, ta.id DESC`;

    const advances = db.prepare(query).all(...params);

    let totalAmount = 0;
    const items = advances.map(a => {
      totalAmount += a.amount || 0;
      return {
        id: a.id,
        teacher_id: a.teacher_id,
        date: a.advance_date,
        teacher_name: a.teacher_name,
        teacher_phone: a.teacher_phone,
        fixed_salary: a.fixed_salary,
        amount: a.amount,
        is_recovered: a.is_recovered,
        payment_method: a.payment_method || 'Cash',
        note: a.note || 'Salary Advance'
      };
    });

    res.json({
      success: true,
      totalAmount,
      count: items.length,
      advances: items
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ----------------------------------------------------
// ACADEMIC & SUBJECT MANAGEMENT (SUPER ADMIN)
// ----------------------------------------------------
apiRouter.get('/academic/classes', (req, res) => {
  try {
    const stream = req.query.stream;
    const ayId = req.query.academic_year_id ? parseInt(req.query.academic_year_id, 10) : getActiveAcademicYearId();

    let query = `
      SELECT c.*, 
             t_ct.name as class_teacher_name,
             (SELECT COUNT(*) FROM subjects s WHERE s.class_id = c.id AND s.is_active = 1) as subject_count,
             (SELECT COUNT(*) FROM students st WHERE st.class_id = c.id AND LOWER(st.status) = 'active') as student_count
      FROM classes c
      LEFT JOIN teachers t_ct ON c.class_teacher_id = t_ct.id
      WHERE 1=1
    `;
    const params = [];
    if (ayId) {
      query += ' AND c.academic_year_id = ?';
      params.push(ayId);
    }
    if (stream && ['General', 'Hifz'].includes(stream)) {
      query += ' AND c.stream = ?';
      params.push(stream);
    }

    // Teacher filtering
    if (req.auth?.role === 'teacher') {
      const tc = req.teacherContext;
      if (!tc || !tc.allClassIds || tc.allClassIds.size === 0) {
        return res.json({ success: true, data: [] });
      }
      const classIdArray = Array.from(tc.allClassIds);
      query += ` AND c.id IN (${classIdArray.map(() => '?').join(',')})`;
      params.push(...classIdArray);
    }

    query += ' ORDER BY c.stream ASC, c.class_number ASC';

    const classes = db.prepare(query).all(...params);
    const enriched = classes.map(c => ({
      ...c,
      is_class_teacher: req.auth?.role === 'teacher' ? Boolean(req.teacherContext?.isClassTeacher(c.id)) : false
    }));

    res.json({ success: true, data: enriched });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get subjects with teacher assignments
apiRouter.get('/academic/subjects', (req, res) => {
  try {
    const classId = req.query.class_id ? parseInt(req.query.class_id, 10) : null;
    const stream = req.query.stream;

    let query = `
      SELECT s.*, c.name as class_name, c.stream as class_stream, c.class_number,
             ta.id as assignment_id, ta.teacher_id, t.name as teacher_name, t.phone as teacher_phone
      FROM subjects s
      JOIN classes c ON s.class_id = c.id
      LEFT JOIN teacher_assignments ta ON s.id = ta.subject_id AND ta.is_active = 1
      LEFT JOIN teachers t ON ta.teacher_id = t.id
      WHERE s.is_active = 1
    `;
    const params = [];
    if (classId) {
      query += ' AND s.class_id = ?';
      params.push(classId);
    }
    if (stream && ['General', 'Hifz'].includes(stream)) {
      query += ' AND s.stream = ?';
      params.push(stream);
    }

    // Teacher filtering
    if (req.auth?.role === 'teacher') {
      const tc = req.teacherContext;
      if (!tc) return res.json({ success: true, data: [] });

      if (classId) {
        if (!tc.isClassTeacher(classId)) {
          // Regular teacher in this class: only assigned subjects
          if (!tc.assignedSubjectIds || tc.assignedSubjectIds.size === 0) {
            return res.json({ success: true, data: [] });
          }
          const subIds = Array.from(tc.assignedSubjectIds);
          query += ` AND s.id IN (${subIds.map(() => '?').join(',')})`;
          params.push(...subIds);
        }
      } else {
        // No specific classId requested: show subjects where teacher is class teacher OR assigned subject
        const ctClassIds = Array.from(tc.classTeacherClassIds || []);
        const subIds = Array.from(tc.assignedSubjectIds || []);
        if (ctClassIds.length === 0 && subIds.length === 0) {
          return res.json({ success: true, data: [] });
        }
        const orConditions = [];
        if (ctClassIds.length > 0) {
          orConditions.push(`s.class_id IN (${ctClassIds.map(() => '?').join(',')})`);
          params.push(...ctClassIds);
        }
        if (subIds.length > 0) {
          orConditions.push(`s.id IN (${subIds.map(() => '?').join(',')})`);
          params.push(...subIds);
        }
        query += ` AND (${orConditions.join(' OR ')})`;
      }
    }

    query += ' ORDER BY s.stream ASC, c.class_number ASC, s.name ASC';

    const subjects = db.prepare(query).all(...params);
    res.json({ success: true, data: subjects });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Create subject
apiRouter.post('/academic/subjects', requireStaffOrAdmin, (req, res) => {
  try {
    const { name, code, class_id, stream, full_marks, is_optional } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({ success: false, error: 'Subject name is required.' });
    }
    if (!class_id) {
      return res.status(400).json({ success: false, error: 'Class is required.' });
    }

    const cls = db.prepare('SELECT * FROM classes WHERE id = ?').get(class_id);
    if (!cls) {
      return res.status(404).json({ success: false, error: 'Selected class not found.' });
    }

    const trimmedName = name.trim();
    const existing = db.prepare('SELECT id FROM subjects WHERE class_id = ? AND LOWER(name) = LOWER(?)').get(class_id, trimmedName);
    if (existing) {
      return res.status(400).json({ success: false, error: `Subject "${trimmedName}" already exists in class "${cls.name}".` });
    }

    const subjStream = stream || cls.stream || 'General';
    const fMarks = parseInt(full_marks, 10) || 100;
    const isOpt = is_optional ? 1 : 0;
    const ayId = cls.academic_year_id || getActiveAcademicYearId();

    const stmt = db.prepare(`
      INSERT INTO subjects (academic_year_id, class_id, name, code, stream, full_marks, is_optional, is_active)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1)
    `);
    const result = stmt.run(ayId, class_id, trimmedName, (code || '').trim(), subjStream, fMarks, isOpt);

    const newSubj = db.prepare(`
      SELECT s.*, c.name as class_name, c.stream as class_stream
      FROM subjects s
      JOIN classes c ON s.class_id = c.id
      WHERE s.id = ?
    `).get(result.lastInsertRowid);
    res.json({ success: true, message: `Subject "${newSubj.name}" added successfully.`, data: newSubj });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Update subject
apiRouter.put('/academic/subjects/:id', requireStaffOrAdmin, (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const subj = db.prepare('SELECT * FROM subjects WHERE id = ?').get(id);
    if (!subj) {
      return res.status(404).json({ success: false, error: 'Subject not found' });
    }

    const { name, code, full_marks, is_optional, is_active } = req.body;
    const sName = (name && name.trim()) ? name.trim() : subj.name;
    const sCode = code !== undefined ? code.trim() : subj.code;
    const fMarks = full_marks !== undefined ? (parseInt(full_marks, 10) || 100) : subj.full_marks;
    const isOpt = is_optional !== undefined ? (is_optional ? 1 : 0) : subj.is_optional;
    const active = is_active !== undefined ? (is_active ? 1 : 0) : subj.is_active;

    db.prepare(`
      UPDATE subjects
      SET name = ?, code = ?, full_marks = ?, is_optional = ?, is_active = ?
      WHERE id = ?
    `).run(sName, sCode, fMarks, isOpt, active, id);

    const updated = db.prepare('SELECT * FROM subjects WHERE id = ?').get(id);
    res.json({ success: true, message: `Subject "${updated.name}" updated successfully`, data: updated });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Delete subject (Safe deactivation if historical exam marks exist)
apiRouter.delete('/academic/subjects/:id', requireDeletePermission, (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const subj = db.prepare('SELECT * FROM subjects WHERE id = ?').get(id);
    if (!subj) {
      return res.status(404).json({ success: false, error: 'Subject not found' });
    }

    // Check if marks exist for this subject
    const marksCount = db.prepare('SELECT COUNT(*) as count FROM exam_marks WHERE subject_id = ?').get(id).count;
    if (marksCount > 0) {
      // Deactivate safely rather than deleting historical marks
      db.prepare('UPDATE subjects SET is_active = 0 WHERE id = ?').run(id);
      db.prepare('UPDATE teacher_assignments SET is_active = 0 WHERE subject_id = ?').run(id);
      return res.json({
        success: true,
        message: `Subject "${subj.name}" has ${marksCount} historical examination records and has been deactivated to preserve academic integrity.`
      });
    }

    // Otherwise, can safely remove
    db.prepare('DELETE FROM teacher_assignments WHERE subject_id = ?').run(id);
    db.prepare('DELETE FROM subjects WHERE id = ?').run(id);

    res.json({ success: true, message: `Subject "${subj.name}" deleted successfully` });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Available subjects dynamic helper (for Teacher assignment UI)
apiRouter.get('/academic/available-subjects', (req, res) => {
  try {
    const stream = req.query.stream || 'General';
    const currentTeacherId = req.query.teacher_id ? parseInt(req.query.teacher_id, 10) : null;

    const subjects = db.prepare(`
      SELECT s.id, s.name, s.code, s.class_id, s.stream,
             c.name as class_name, c.class_number,
             ta.teacher_id as assigned_teacher_id,
             t.name as assigned_teacher_name
      FROM subjects s
      JOIN classes c ON s.class_id = c.id
      LEFT JOIN teacher_assignments ta ON s.id = ta.subject_id AND ta.is_active = 1
      LEFT JOIN teachers t ON ta.teacher_id = t.id
      WHERE s.is_active = 1 AND s.stream = ?
      ORDER BY c.class_number ASC, s.name ASC
    `).all(stream);

    const results = subjects.map(s => {
      const isAssignedToOther = Boolean(s.assigned_teacher_id && s.assigned_teacher_id !== currentTeacherId);
      const isAssignedToCurrent = Boolean(s.assigned_teacher_id && s.assigned_teacher_id === currentTeacherId);
      return {
        ...s,
        is_assigned_to_other: isAssignedToOther,
        is_assigned_to_current: isAssignedToCurrent,
        is_available: !isAssignedToOther
      };
    });

    res.json({ success: true, data: results });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Academic Teacher-Subject Assignments List Endpoint
apiRouter.get('/academic/assignments', (req, res) => {
  try {
    const { class_id, stream } = req.query;
    let query = `
      SELECT 
        s.id as subject_id,
        s.name as subject_name,
        s.code as subject_code,
        s.stream,
        c.name as class_name,
        ta.teacher_id,
        t.name as teacher_name,
        t.phone as teacher_phone,
        t.stream as teacher_stream
      FROM subjects s
      JOIN classes c ON s.class_id = c.id
      LEFT JOIN teacher_assignments ta ON s.id = ta.subject_id AND ta.is_active = 1
      LEFT JOIN teachers t ON ta.teacher_id = t.id
      WHERE s.is_active = 1
    `;
    const params = [];

    if (class_id) {
      query += ` AND s.class_id = ?`;
      params.push(parseInt(class_id, 10));
    }
    if (stream && stream !== 'All') {
      query += ` AND s.stream = ?`;
      params.push(stream);
    }
    if (req.query.academic_year_id) {
      query += ` AND s.academic_year_id = ?`;
      params.push(parseInt(req.query.academic_year_id, 10));
    }

    query += ` ORDER BY s.name ASC`;

    const assignments = db.prepare(query).all(...params);
    res.json({ success: true, data: assignments });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Super Admin Teacher-Subject Assignment Endpoint
apiRouter.post('/academic/assignments', (req, res) => {
  try {
    const { teacher_id, subject_id } = req.body;
    if (!teacher_id || !subject_id) {
      return res.status(400).json({ success: false, error: 'teacher_id and subject_id are required' });
    }

    const tId = parseInt(teacher_id, 10);
    const sId = parseInt(subject_id, 10);

    const teacher = db.prepare('SELECT * FROM teachers WHERE id = ?').get(tId);
    if (!teacher) return res.status(404).json({ success: false, error: 'Teacher not found' });

    const subject = db.prepare('SELECT s.*, c.name as class_name, c.stream FROM subjects s JOIN classes c ON s.class_id = c.id WHERE s.id = ?').get(sId);
    if (!subject) return res.status(404).json({ success: false, error: 'Subject not found' });

    // Strict Rule: Check if assigned to another active teacher
    const conflict = db.prepare(`
      SELECT ta.*, t.name as teacher_name
      FROM teacher_assignments ta
      JOIN teachers t ON ta.teacher_id = t.id
      WHERE ta.subject_id = ? AND ta.is_active = 1 AND ta.teacher_id != ?
    `).get(sId, tId);

    if (conflict) {
      return res.status(400).json({
        success: false,
        error: `Subject "${subject.name}" in ${subject.stream} ${subject.class_name} is already assigned to "${conflict.teacher_name}".`
      });
    }

    // Upsert or insert assignment
    const existing = db.prepare('SELECT * FROM teacher_assignments WHERE subject_id = ?').get(sId);
    if (existing) {
      db.prepare('UPDATE teacher_assignments SET teacher_id = ?, is_active = 1 WHERE subject_id = ?').run(tId, sId);
    } else {
      const ayId = subject.academic_year_id || getActiveAcademicYearId();
      db.prepare('INSERT INTO teacher_assignments (teacher_id, subject_id, class_id, stream, academic_year_id, is_active) VALUES (?, ?, ?, ?, ?, 1)').run(tId, sId, subject.class_id, subject.stream || 'General', ayId);
    }

    res.json({
      success: true,
      message: `Subject "${subject.name}" (${subject.stream} ${subject.class_name}) assigned to "${teacher.name}" successfully.`
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ----------------------------------------------------
// EXAMINATION MANAGEMENT & MARKS ENTRY
// ----------------------------------------------------
apiRouter.get('/examinations', (req, res) => {
  try {
    const stream = req.query.stream;
    const ayId = req.query.academic_year_id ? parseInt(req.query.academic_year_id, 10) : getActiveAcademicYearId();

    let query = `
      SELECT e.*, ay.name as academic_year_name, ay.name as year_name, c.name as class_name, c.class_number
      FROM examinations e
      LEFT JOIN academic_years ay ON e.academic_year_id = ay.id
      LEFT JOIN classes c ON e.class_id = c.id
      WHERE 1=1
    `;
    const params = [];
    if (ayId) {
      query += ' AND e.academic_year_id = ?';
      params.push(ayId);
    }
    if (stream && ['General', 'Hifz'].includes(stream)) {
      query += ' AND e.stream = ?';
      params.push(stream);
    }

    // Teacher filtering
    if (req.auth?.role === 'teacher') {
      const tc = req.teacherContext;
      if (!tc || !tc.allClassIds || tc.allClassIds.size === 0) {
        return res.json({ success: true, data: [] });
      }
      const classIdArray = Array.from(tc.allClassIds);
      query += ` AND (e.class_id IN (${classIdArray.map(() => '?').join(',')}) OR (e.class_id IS NULL AND e.stream = ?))`;
      params.push(...classIdArray, tc.teacher.stream);
    }

    query += ' ORDER BY e.id DESC';

    const exams = db.prepare(query).all(...params);
    res.json({ success: true, data: exams });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

apiRouter.post('/examinations', requireStaffOrAdmin, (req, res) => {
  try {
    const {
      academic_year_id,
      stream,
      class_id,
      exam_type,
      name,
      start_date,
      end_date,
      weight_monthly,
      weight_main
    } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({ success: false, error: 'Examination name is required' });
    }

    const ayId = academic_year_id ? parseInt(academic_year_id, 10) : getActiveAcademicYearId();
    const eStream = stream === 'Hifz' ? 'Hifz' : 'General';
    const cId = class_id ? parseInt(class_id, 10) : null;
    const eType = exam_type === 'final' ? 'final' : 'half_yearly';
    const wMonthly = parseFloat(weight_monthly) || (eStream === 'General' ? 30 : 0);
    const wMain = parseFloat(weight_main) || (eStream === 'General' ? 70 : 100);

    const stmt = db.prepare(`
      INSERT INTO examinations (academic_year_id, stream, class_id, exam_type, name, start_date, end_date, weight_monthly, weight_main, is_published)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
    `);
    const result = stmt.run(ayId, eStream, cId, eType, name.trim(), start_date || null, end_date || null, wMonthly, wMain);

    const newExam = db.prepare('SELECT * FROM examinations WHERE id = ?').get(result.lastInsertRowid);
    res.json({ success: true, message: `Examination "${newExam.name}" created successfully`, data: newExam });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Examination Marks Sheet (Grid view for Marks Entry)
apiRouter.get('/examinations/:id/marks-sheet', (req, res) => {
  try {
    const examId = parseInt(req.params.id, 10);
    const exam = db.prepare(`
      SELECT e.*, ay.name as academic_year_name, ay.name as year_name, c.name as class_name, c.class_number
      FROM examinations e
      LEFT JOIN academic_years ay ON e.academic_year_id = ay.id
      LEFT JOIN classes c ON e.class_id = c.id
      WHERE e.id = ?
    `).get(examId);

    if (!exam) return res.status(404).json({ success: false, error: 'Examination not found' });

    const selectedClassId = req.query.class_id ? parseInt(req.query.class_id, 10) : exam.class_id;
    const selectedSubjectId = req.query.subject_id ? parseInt(req.query.subject_id, 10) : null;

    let isClassTeacher = false;
    let allowedSubjectIds = null;

    // Check teacher permission if role is teacher
    if (req.auth?.role === 'teacher') {
      const tc = req.teacherContext;
      if (!tc || !tc.profile || !tc.profile.is_active) {
        return res.status(403).json({ success: false, error: 'Access denied: Teacher profile is inactive or not found.' });
      }
      if (!selectedClassId) {
        return res.status(400).json({ success: false, error: 'class_id is required to view marks sheet.' });
      }
      isClassTeacher = tc.isClassTeacher(selectedClassId);
      const hasSubject = tc.hasSubjectInClass(selectedClassId);
      if (!isClassTeacher && !hasSubject) {
        return res.status(403).json({ success: false, error: 'Access denied: You are not assigned to this class.' });
      }
      if (!isClassTeacher) {
        allowedSubjectIds = Array.from(tc.assignedSubjectIds || []);
        if (selectedSubjectId && !tc.hasSubject(selectedSubjectId)) {
          return res.status(403).json({ success: false, error: 'Access denied: You are not assigned to this subject.' });
        }
      }
    }

    // Subjects in this class/stream
    let subjQuery = 'SELECT s.*, c.name as class_name FROM subjects s JOIN classes c ON s.class_id = c.id WHERE s.is_active = 1 AND (s.stream = ? COLLATE NOCASE OR c.stream = ? COLLATE NOCASE)';
    const subParams = [exam.stream, exam.stream];
    if (selectedClassId) {
      subjQuery += ' AND s.class_id = ?';
      subParams.push(selectedClassId);
    }
    if (allowedSubjectIds !== null) {
      if (allowedSubjectIds.length === 0) {
        return res.json({ success: true, data: { exam, subjects: [], students: [], marks: [], is_class_teacher: isClassTeacher } });
      }
      subjQuery += ` AND s.id IN (${allowedSubjectIds.map(() => '?').join(',')})`;
      subParams.push(...allowedSubjectIds);
    }
    subjQuery += ' ORDER BY s.name ASC';
    const subjects = db.prepare(subjQuery).all(...subParams);

    // Students in this class/stream
    let stuQuery = "SELECT st.*, c.name as class_name FROM students st JOIN classes c ON st.class_id = c.id WHERE LOWER(TRIM(st.status)) = 'active' AND (st.stream = ? COLLATE NOCASE OR c.stream = ? COLLATE NOCASE)";
    const stuParams = [exam.stream, exam.stream];
    if (selectedClassId) {
      stuQuery += ' AND st.class_id = ?';
      stuParams.push(selectedClassId);
    }
    if (exam.academic_year_id) {
      stuQuery += ' AND (st.academic_year_id = ? OR c.academic_year_id = ?)';
      stuParams.push(exam.academic_year_id, exam.academic_year_id);
    }
    stuQuery += ' ORDER BY CAST(st.roll_number AS INTEGER) ASC, st.roll_number ASC, st.name ASC';
    const students = db.prepare(stuQuery).all(...stuParams);

    // Existing Marks
    let marksQuery = 'SELECT * FROM exam_marks WHERE examination_id = ?';
    const marksParams = [examId];
    if (selectedSubjectId) {
      marksQuery += ' AND subject_id = ?';
      marksParams.push(selectedSubjectId);
    } else if (allowedSubjectIds !== null) {
      marksQuery += ` AND subject_id IN (${allowedSubjectIds.map(() => '?').join(',')})`;
      marksParams.push(...allowedSubjectIds);
    }
    const marks = db.prepare(marksQuery).all(...marksParams);

    res.json({
      success: true,
      data: {
        exam,
        subjects,
        students,
        marks,
        is_class_teacher: isClassTeacher
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Save Marks (Batch or Single)
apiRouter.post('/examinations/:id/save-marks', (req, res) => {
  try {
    const examId = parseInt(req.params.id, 10);
    const exam = db.prepare('SELECT * FROM examinations WHERE id = ?').get(examId);
    if (!exam) return res.status(404).json({ success: false, error: 'Examination not found' });

    const { marks_list } = req.body;
    if (!Array.isArray(marks_list) || marks_list.length === 0) {
      return res.status(400).json({ success: false, error: 'marks_list array is required' });
    }

    const isStaffOrAdmin = req.auth?.role === 'super_admin' || req.auth?.role === 'staff';
    const isTeacher = req.auth?.role === 'teacher';

    if (!isStaffOrAdmin && !isTeacher) {
      return res.status(403).json({ success: false, error: 'Access denied: Unauthorized.' });
    }

    // Teacher authorization checks: PRE-VALIDATE EVERY ROW IN BULK BEFORE ANY WRITING
    if (isTeacher) {
      const tc = req.teacherContext;
      if (!tc || !tc.teacher || !tc.teacher.is_active) {
        return res.status(403).json({ success: false, error: 'Access denied: Teacher profile is inactive or not found.' });
      }
      for (const item of marks_list) {
        const subId = parseInt(item.subject_id, 10);
        const stuId = parseInt(item.student_id, 10);
        if (!subId || !stuId) {
          return res.status(400).json({ success: false, error: 'student_id and subject_id are required for all entries.' });
        }
        const subj = db.prepare('SELECT id, name, class_id FROM subjects WHERE id = ?').get(subId);
        if (!subj) {
          return res.status(400).json({ success: false, error: `Invalid subject ID: ${subId}` });
        }
        const targetClassId = subj.class_id || item.class_id || exam.class_id;
        const isCT = tc.isClassTeacher(targetClassId);
        const hasSub = tc.hasSubject(subId);
        if (!isCT && !hasSub) {
          return res.status(403).json({
            success: false,
            error: `Access denied: You are not authorized to enter marks for subject "${subj.name}" in class ID ${targetClassId}.`
          });
        }

        // Verify student belongs to target class
        const student = db.prepare('SELECT id, class_id FROM students WHERE id = ?').get(stuId);
        if (!student) {
          return res.status(400).json({ success: false, error: `Student ID ${stuId} not found.` });
        }
        if (targetClassId && student.class_id !== targetClassId) {
          return res.status(400).json({
            success: false,
            error: `Student ID ${stuId} does not belong to subject's class ID ${targetClassId}.`
          });
        }
      }
    }

    // Atomic write inside transaction
    db.exec('BEGIN TRANSACTION;');
    const insertedOrUpdated = [];
    try {
      for (const item of marks_list) {
        const { student_id, subject_id, mt1, mt2, mt3, mt4, ct_marks, main_exam, final_exam, is_absent, remarks } = item;
        if (!student_id || !subject_id) continue;

        const sId = parseInt(student_id, 10);
        const subId = parseInt(subject_id, 10);

        const subj = db.prepare('SELECT * FROM subjects WHERE id = ?').get(subId);
        if (!subj) continue;

        const finalScore = is_absent ? 0 : calculateSubjectScore(exam.stream, exam.exam_type, {
          mt1, mt2, mt3, mt4, ct_marks, main_exam, final_exam
        });

        const { grade, gpa } = is_absent ? { grade: 'F', gpa: 0 } : getGradeAndGpa(finalScore);

        const existing = db.prepare('SELECT id FROM exam_marks WHERE examination_id = ? AND student_id = ? AND subject_id = ?').get(examId, sId, subId);

        if (existing) {
          db.prepare(`
            UPDATE exam_marks
            SET mt1 = ?, mt2 = ?, mt3 = ?, mt4 = ?, ct_marks = ?, main_exam = ?, final_exam = ?,
                final_score = ?, grade = ?, grade_point = ?, is_absent = ?, remarks = ?, updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
          `).run(
            mt1 !== undefined ? mt1 : null,
            mt2 !== undefined ? mt2 : null,
            mt3 !== undefined ? mt3 : null,
            mt4 !== undefined ? mt4 : null,
            ct_marks !== undefined ? ct_marks : null,
            main_exam !== undefined ? main_exam : null,
            final_exam !== undefined ? final_exam : null,
            finalScore,
            grade,
            gpa,
            is_absent ? 1 : 0,
            remarks || '',
            existing.id
          );
          insertedOrUpdated.push(existing.id);
        } else {
          const insClassId = (item.class_id ? parseInt(item.class_id, 10) : null) || subj.class_id || exam.class_id;
          const insStream = exam.stream || subj.stream || 'General';
          const ins = db.prepare(`
            INSERT INTO exam_marks (examination_id, student_id, subject_id, class_id, stream, mt1, mt2, mt3, mt4, ct_marks, main_exam, final_exam, final_score, grade, grade_point, is_absent, remarks)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            examId,
            sId,
            subId,
            insClassId,
            insStream,
            mt1 !== undefined ? mt1 : null,
            mt2 !== undefined ? mt2 : null,
            mt3 !== undefined ? mt3 : null,
            mt4 !== undefined ? mt4 : null,
            ct_marks !== undefined ? ct_marks : null,
            main_exam !== undefined ? main_exam : null,
            final_exam !== undefined ? final_exam : null,
            finalScore,
            grade,
            gpa,
            is_absent ? 1 : 0,
            remarks || ''
          );
          insertedOrUpdated.push(Number(ins.lastInsertRowid));
        }
      }
      db.exec('COMMIT;');
    } catch (txErr) {
      db.exec('ROLLBACK;');
      throw txErr;
    }

    res.json({
      success: true,
      message: `Successfully saved marks for ${insertedOrUpdated.length} entry/entries.`,
      count: insertedOrUpdated.length
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Compile and Get Results for Exam & Class (with Rank calculation)
apiRouter.get('/examinations/:id/results', (req, res) => {
  try {
    const examId = parseInt(req.params.id, 10);
    const classId = req.query.class_id ? parseInt(req.query.class_id, 10) : null;

    const exam = db.prepare('SELECT * FROM examinations WHERE id = ?').get(examId);
    if (!exam) return res.status(404).json({ success: false, error: 'Examination not found' });

    const cId = classId || exam.class_id;
    if (!cId) {
      return res.status(400).json({ success: false, error: 'class_id is required' });
    }

    let isClassTeacher = false;
    let allowedSubjectIds = null;

    // Enforce verified server-side identity & assignments, NEVER client-supplied roles/IDs
    if (req.auth?.role === 'teacher') {
      const tc = req.teacherContext;
      if (!tc || !tc.teacher || !tc.teacher.is_active) {
        return res.status(403).json({ success: false, error: 'Access denied: Teacher profile is inactive or not found.' });
      }
      isClassTeacher = tc.isClassTeacher(cId);
      const isAssignedToClass = tc.hasSubjectInClass(cId);
      if (!isClassTeacher && !isAssignedToClass) {
        return res.status(403).json({ success: false, error: 'Access denied: You are not assigned to this class.' });
      }
      if (!isClassTeacher) {
        // Regular teachers must remain strictly limited to their assigned subjects!
        allowedSubjectIds = tc.assignedSubjectIds;
      }
    } else if (req.auth?.role === 'super_admin' || req.auth?.role === 'staff') {
      isClassTeacher = true; // Admin/Staff have full access to view complete class result card
    } else {
      return res.status(403).json({ success: false, error: 'Access denied: Unauthorized.' });
    }

    const cls = db.prepare('SELECT * FROM classes WHERE id = ?').get(cId);

    // Get subjects in class (filtered for regular teachers to only their assigned subjects)
    const allSubjects = db.prepare('SELECT * FROM subjects WHERE class_id = ? AND is_active = 1 ORDER BY name ASC').all(cId);
    const subjects = allowedSubjectIds !== null
      ? allSubjects.filter(s => allowedSubjectIds.has(s.id))
      : allSubjects;

    const subjectCount = subjects.length;
    const grandTotalMarks = subjectCount * 100;

    // Get students in this class and stream
    const students = db.prepare("SELECT * FROM students WHERE class_id = ? AND stream = ? AND LOWER(status) = 'active' ORDER BY roll_number ASC").all(cId, exam.stream);

    // Compute highest mark in class for each allowed subject
    const highestMarksMap = {};
    for (const sub of subjects) {
      const highRow = db.prepare('SELECT MAX(final_score) as high FROM exam_marks WHERE examination_id = ? AND subject_id = ?').get(examId, sub.id);
      highestMarksMap[sub.id] = highRow && highRow.high !== null ? highRow.high : 0;
    }

    // Process each student
    const studentResults = students.map(st => {
      const stMarks = db.prepare('SELECT * FROM exam_marks WHERE examination_id = ? AND student_id = ?').all(examId, st.id);

      let totalMarksObtained = 0;
      let totalGpa = 0;
      let hasFail = false;
      let subjectsWithMarks = 0;

      const marksDetail = subjects.map(sub => {
        const m = stMarks.find(item => item.subject_id === sub.id);
        const finalScore = m ? m.final_score : 0;
        const gradeInfo = m ? { grade: m.grade, gpa: m.grade_point } : getGradeAndGpa(finalScore);

        if (m) subjectsWithMarks++;
        totalMarksObtained += finalScore;
        totalGpa += gradeInfo.gpa;
        if (gradeInfo.grade === 'F') hasFail = true;

        // Breakdown components
        let termMarks = 0;
        let mtMarks = 0;
        if (exam.stream === 'General') {
          termMarks = (exam.exam_type === 'final' ? (m?.final_exam || 0) : (m?.main_exam || 0)) * 0.70;
          const mtA = exam.exam_type === 'final' ? ((m?.mt3 || 0) + (m?.mt4 || 0)) / 2 : ((m?.mt1 || 0) + (m?.mt2 || 0)) / 2;
          mtMarks = mtA * 0.30;
        } else {
          termMarks = m?.final_exam || 0;
          mtMarks = m?.ct_marks || 0;
        }

        return {
          subject_id: sub.id,
          subject_name: sub.name,
          full_marks: sub.full_marks || 100,
          term_marks: Math.round(termMarks * 10) / 10,
          mt_marks: Math.round(mtMarks * 10) / 10,
          total_marks: finalScore,
          grade: gradeInfo.grade,
          grade_point: gradeInfo.gpa.toFixed(2),
          highest_marks: highestMarksMap[sub.id] || 0
        };
      });

      const averageMarks = subjectCount > 0 ? (totalMarksObtained / subjectCount) : 0;
      const percentage = grandTotalMarks > 0 ? ((totalMarksObtained / grandTotalMarks) * 100) : 0;
      const obtainedGpa = subjectCount > 0 ? (hasFail ? 0 : totalGpa / subjectCount) : 0;
      const overallGrade = getGradeAndGpa(averageMarks);

      // Fetch attendance & metadata (Class Teacher or Super Admin/Staff only)
      const meta = isClassTeacher
        ? db.prepare('SELECT * FROM student_exam_results WHERE examination_id = ? AND student_id = ?').get(examId, st.id)
        : null;

      return {
        student_id: st.id,
        name: st.name,
        roll: st.roll_number,
        father_name: st.father_name || '',
        mother_name: st.mother_name || '',
        stream: st.stream,
        class_name: cls ? cls.name : '',
        class_teacher: cls?.class_teacher || 'Md. Rafiqul Islam',
        subjects: marksDetail,
        total_marks_obtained: totalMarksObtained,
        grand_total_marks: grandTotalMarks,
        average_marks: Math.round(averageMarks * 10) / 10,
        percentage: Math.round(percentage * 10) / 10,
        obtained_gpa: hasFail ? 0.00 : Math.round(obtainedGpa * 100) / 100,
        overall_grade: hasFail ? 'F' : overallGrade.grade,
        remarks: hasFail ? 'Fail' : overallGrade.remarks,
        total_working_days: meta ? (meta.total_working_days ?? null) : null,
        presence: meta ? (meta.presence ?? meta.presence_days ?? null) : null,
        absent: meta ? (meta.absent ?? meta.absent_days ?? null) : null,
        percentage_of_attendance: meta ? (meta.percentage_of_attendance ?? (meta.total_working_days && (meta.presence != null || meta.presence_days != null) ? Math.round(((meta.presence ?? meta.presence_days) / meta.total_working_days) * 1000) / 10 : null)) : null,
        manners_discipline: meta?.manners_discipline ?? '',
        class_teacher_remarks: meta?.class_teacher_remarks ?? '',
        principal_remarks: meta?.principal_remarks ?? ''
      };
    });

    // Calculate Merit Position / Rank (Only when full class results are compiled by Class Teacher or Admin)
    if (isClassTeacher) {
      studentResults.sort((a, b) => {
        if (b.total_marks_obtained !== a.total_marks_obtained) {
          return b.total_marks_obtained - a.total_marks_obtained;
        }
        return b.obtained_gpa - a.obtained_gpa;
      });

      studentResults.forEach((st, index) => {
        st.position = index + 1;
      });
    }

    res.json({
      success: true,
      data: {
        exam,
        class_name: cls ? cls.name : '',
        stream: exam.stream,
        subject_count: subjectCount,
        grand_total_marks: grandTotalMarks,
        results: studentResults,
        is_class_teacher: isClassTeacher
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get class-wise attendance for examination
apiRouter.get('/examinations/:id/attendance', (req, res) => {
  try {
    const examId = parseInt(req.params.id, 10);
    const classId = req.query.class_id ? parseInt(req.query.class_id, 10) : null;

    if (!examId || !classId) {
      return res.status(400).json({ success: false, error: 'Examination ID and class_id are required' });
    }

    // Authorization: Only the designated Class Teacher for this class, or Super Admin/Staff
    if (req.auth?.role === 'teacher') {
      const tc = req.teacherContext;
      if (!tc || !tc.teacher || !tc.teacher.is_active || !tc.isClassTeacher(classId)) {
        return res.status(403).json({
          success: false,
          error: 'Access denied: Only the designated Class Teacher for this class or an administrator can view class attendance and remarks.'
        });
      }
    } else if (req.auth?.role !== 'super_admin' && req.auth?.role !== 'staff') {
      return res.status(403).json({ success: false, error: 'Access denied: Unauthorized.' });
    }

    const exam = db.prepare('SELECT * FROM examinations WHERE id = ?').get(examId);
    if (!exam) return res.status(404).json({ success: false, error: 'Examination not found' });

    const students = db.prepare('SELECT id, name, roll_number, stream FROM students WHERE class_id = ? ORDER BY roll_number ASC').all(classId);
    const existingResults = db.prepare('SELECT * FROM student_exam_results WHERE examination_id = ? AND class_id = ?').all(examId, classId);

    // Determine class-wide working days from existing entries if any
    let classWorkingDays = null;
    const withWorkingDays = existingResults.find(r => r.total_working_days != null && r.total_working_days > 0);
    if (withWorkingDays) {
      classWorkingDays = withWorkingDays.total_working_days;
    }

    const list = students.map(st => {
      const rec = existingResults.find(r => r.student_id === st.id);
      const pres = rec ? (rec.presence ?? rec.presence_days ?? null) : null;
      const wDays = (rec && rec.total_working_days != null) ? rec.total_working_days : (classWorkingDays ?? null);
      let abs = rec ? (rec.absent ?? rec.absent_days ?? null) : null;
      if (abs === null && wDays !== null && pres !== null) {
        abs = Math.max(0, wDays - pres);
      }
      let pct = rec ? (rec.percentage_of_attendance ?? null) : null;
      if (pct === null && wDays && pres !== null) {
        pct = Math.round((pres / wDays) * 1000) / 10;
      }

      return {
        student_id: st.id,
        name: st.name,
        roll_number: st.roll_number,
        stream: st.stream,
        presence: pres,
        absent: abs,
        percentage_of_attendance: pct,
        class_teacher_remarks: rec ? (rec.class_teacher_remarks ?? '') : '',
        principal_remarks: rec ? (rec.principal_remarks ?? '') : ''
      };
    });

    res.json({
      success: true,
      data: {
        exam_id: examId,
        class_id: classId,
        total_working_days: classWorkingDays ?? '',
        students: list
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Bulk save class-wise attendance for examination
apiRouter.post('/examinations/:id/attendance', (req, res) => {
  try {
    const examId = parseInt(req.params.id, 10);
    const { class_id, total_working_days, attendance_list } = req.body;

    if (!examId || !class_id) {
      return res.status(400).json({ success: false, error: 'Examination ID and class_id are required' });
    }

    const cId = parseInt(class_id, 10);
    const wDays = parseInt(total_working_days, 10);

    if (isNaN(wDays) || wDays < 0) {
      return res.status(400).json({ success: false, error: 'Total working days must be a non-negative number' });
    }

    if (!Array.isArray(attendance_list) || attendance_list.length === 0) {
      return res.status(400).json({ success: false, error: 'attendance_list must be a non-empty array' });
    }

    const isStaffOrAdmin = req.auth?.role === 'super_admin' || req.auth?.role === 'staff';
    const isTeacher = req.auth?.role === 'teacher';

    if (isTeacher) {
      const tc = req.teacherContext;
      if (!tc || !tc.teacher || !tc.teacher.is_active || !tc.isClassTeacher(cId)) {
        return res.status(403).json({
          success: false,
          error: 'Access denied: Only the designated Class Teacher for this class or an administrator can submit class attendance.'
        });
      }
    } else if (!isStaffOrAdmin) {
      return res.status(403).json({ success: false, error: 'Access denied: Unauthorized.' });
    }

    // STRICT BULK VALIDATION: Validate EVERY row and class before writing to prevent unauthorized partial updates
    for (const item of attendance_list) {
      const sId = parseInt(item.student_id, 10);
      if (!sId || isNaN(sId)) {
        return res.status(400).json({ success: false, error: 'Valid student_id is required for every row.' });
      }

      // Verify student belongs to this specific class
      const student = db.prepare('SELECT id, class_id, stream FROM students WHERE id = ?').get(sId);
      if (!student) {
        return res.status(400).json({ success: false, error: `Student ID ${sId} not found.` });
      }
      if (student.class_id !== cId) {
        return res.status(400).json({
          success: false,
          error: `Student ID ${sId} does not belong to class ID ${cId}. Cross-class bulk updates are prohibited.`
        });
      }

      const pres = parseInt(item.presence, 10);
      if (isNaN(pres) || pres < 0) {
        return res.status(400).json({ success: false, error: `Invalid present days for student ID ${sId}. Must be >= 0.` });
      }
      if (pres > wDays) {
        return res.status(400).json({ success: false, error: `Present days (${pres}) cannot exceed total working days (${wDays}) for student ID ${sId}.` });
      }
    }

    const exam = db.prepare('SELECT stream FROM examinations WHERE id = ?').get(examId);
    const defaultStream = exam ? exam.stream : 'General';

    // ATOMIC WRITE: Write inside transaction
    db.exec('BEGIN TRANSACTION;');
    try {
      for (const item of attendance_list) {
        const sId = parseInt(item.student_id, 10);
        const pres = parseInt(item.presence, 10);
        const abs = Math.max(0, wDays - pres);
        const attPct = wDays > 0 ? (Math.round((pres / wDays) * 1000) / 10) : 0;

        const existing = db.prepare('SELECT id, class_teacher_remarks, principal_remarks FROM student_exam_results WHERE examination_id = ? AND student_id = ?').get(examId, sId);

        // Class teacher remarks: editable by class teacher or admin/staff
        const teacherRemarks = (item.class_teacher_remarks !== undefined)
          ? String(item.class_teacher_remarks || '')
          : (existing ? (existing.class_teacher_remarks || '') : '');

        // Principal remarks: only editable by Super Admin or Staff! If caller is teacher, preserve existing principal remarks!
        let princRemarks = existing ? (existing.principal_remarks || '') : '';
        if (isStaffOrAdmin && item.principal_remarks !== undefined) {
          princRemarks = String(item.principal_remarks || '');
        }

        if (existing) {
          db.prepare(`
            UPDATE student_exam_results
            SET total_working_days = ?,
                presence = ?,
                presence_days = ?,
                absent = ?,
                absent_days = ?,
                percentage_of_attendance = ?,
                class_teacher_remarks = ?,
                principal_remarks = ?,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
          `).run(wDays, pres, pres, abs, abs, attPct, teacherRemarks, princRemarks, existing.id);
        } else {
          const student = db.prepare('SELECT class_id, stream FROM students WHERE id = ?').get(sId);
          const str = student ? student.stream : defaultStream;

          db.prepare(`
            INSERT INTO student_exam_results (
              examination_id, student_id, class_id, stream,
              total_working_days, presence, presence_days, absent, absent_days, percentage_of_attendance,
              manners_discipline, class_teacher_remarks, principal_remarks
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Good', ?, ?)
          `).run(examId, sId, cId, str, wDays, pres, pres, abs, abs, attPct, teacherRemarks, princRemarks);
        }
      }
      db.exec('COMMIT;');
    } catch (err) {
      db.exec('ROLLBACK;');
      throw err;
    }

    res.json({
      success: true,
      message: 'Class attendance recorded successfully!'
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Update student metadata (working days, presence, remarks)
apiRouter.post('/examinations/:id/student-meta', (req, res) => {
  try {
    const examId = parseInt(req.params.id, 10);
    const { student_id, total_working_days, presence, absent, manners_discipline, class_teacher_remarks, principal_remarks } = req.body;

    if (!student_id) return res.status(400).json({ success: false, error: 'student_id is required' });

    const sId = parseInt(student_id, 10);
    const student = db.prepare('SELECT class_id, stream FROM students WHERE id = ?').get(sId);
    if (!student) {
      return res.status(404).json({ success: false, error: 'Student not found.' });
    }

    const isStaffOrAdmin = req.auth?.role === 'super_admin' || req.auth?.role === 'staff';
    const isTeacher = req.auth?.role === 'teacher';

    if (isTeacher) {
      const tc = req.teacherContext;
      if (!tc || !tc.teacher || !tc.teacher.is_active || !tc.isClassTeacher(student.class_id)) {
        return res.status(403).json({
          success: false,
          error: 'Access denied: Only the designated Class Teacher for this student\'s class or an administrator can update remarks and attendance metadata.'
        });
      }
    } else if (!isStaffOrAdmin) {
      return res.status(403).json({ success: false, error: 'Access denied: Unauthorized.' });
    }

    const wDays = parseInt(total_working_days, 10) || 0;
    const pres = parseInt(presence, 10) || 0;
    const abs = (absent !== undefined && absent !== '' && !isNaN(parseInt(absent, 10))) ? parseInt(absent, 10) : Math.max(0, wDays - pres);
    const attPct = wDays > 0 ? (Math.round((pres / wDays) * 1000) / 10) : 0;

    const existing = db.prepare('SELECT id, class_teacher_remarks, principal_remarks, manners_discipline FROM student_exam_results WHERE examination_id = ? AND student_id = ?').get(examId, sId);

    const teacherRemarks = (class_teacher_remarks !== undefined) ? String(class_teacher_remarks || '') : (existing ? (existing.class_teacher_remarks || '') : '');

    // Principal remarks: only Super Admin or Staff can edit. Teachers cannot alter principal remarks.
    let princRemarks = existing ? (existing.principal_remarks || '') : '';
    if (isStaffOrAdmin && principal_remarks !== undefined) {
      princRemarks = String(principal_remarks || '');
    }

    const disc = (manners_discipline !== undefined && manners_discipline !== '') ? manners_discipline : (existing ? (existing.manners_discipline || 'Very Good') : 'Very Good');

    db.exec('BEGIN TRANSACTION;');
    try {
      if (existing) {
        db.prepare(`
          UPDATE student_exam_results
          SET total_working_days = ?, presence = ?, presence_days = ?, absent = ?, absent_days = ?, percentage_of_attendance = ?, manners_discipline = ?,
              class_teacher_remarks = ?, principal_remarks = ?, updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).run(wDays, pres, pres, abs, abs, attPct, disc, teacherRemarks, princRemarks, existing.id);
      } else {
        const exam = db.prepare('SELECT class_id, stream FROM examinations WHERE id = ?').get(examId);
        const cId = student.class_id || (exam ? exam.class_id : 1);
        const str = student.stream || (exam ? exam.stream : 'General');

        db.prepare(`
          INSERT INTO student_exam_results (examination_id, student_id, class_id, stream, total_working_days, presence, presence_days, absent, absent_days, percentage_of_attendance, manners_discipline, class_teacher_remarks, principal_remarks)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(examId, sId, cId, str, wDays, pres, pres, abs, abs, attPct, disc, teacherRemarks, princRemarks);
      }
      db.exec('COMMIT;');
    } catch (e) {
      db.exec('ROLLBACK;');
      throw e;
    }

    res.json({ success: true, message: 'Student examination metadata saved successfully' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Publication & Finalization Endpoint (Class Teacher or Super Admin/Staff only)
apiRouter.post('/examinations/:id/publish', (req, res) => {
  try {
    const examId = parseInt(req.params.id, 10);
    const exam = db.prepare('SELECT * FROM examinations WHERE id = ?').get(examId);
    if (!exam) return res.status(404).json({ success: false, error: 'Examination not found' });

    const isStaffOrAdmin = req.auth?.role === 'super_admin' || req.auth?.role === 'staff';
    const isTeacher = req.auth?.role === 'teacher';

    if (isTeacher) {
      const tc = req.teacherContext;
      const targetClassId = req.body.class_id ? parseInt(req.body.class_id, 10) : exam.class_id;
      if (!targetClassId || !tc || !tc.teacher || !tc.teacher.is_active || !tc.isClassTeacher(targetClassId)) {
        return res.status(403).json({
          success: false,
          error: 'Access denied: Only the designated Class Teacher for this class or an administrator may publish examination results.'
        });
      }
    } else if (!isStaffOrAdmin) {
      return res.status(403).json({ success: false, error: 'Access denied: Unauthorized.' });
    }

    const { is_published = 1, is_finalized = 1 } = req.body;
    db.prepare('UPDATE examinations SET is_published = ?, is_finalized = ? WHERE id = ?')
      .run(is_published ? 1 : 0, is_finalized ? 1 : 0, examId);

    res.json({
      success: true,
      message: `Examination results ${is_published ? 'published' : 'unpublished'} successfully.`
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ----------------------------------------------------
// STAFF MANAGEMENT & ADVANCE ENDPOINTS
// ----------------------------------------------------
apiRouter.get('/staff', (req, res) => {
  try {
    const month = req.query.month; // e.g. '2026-10' or '2026-09'
    const staffList = db.prepare('SELECT * FROM staff ORDER BY name ASC').all();

    let totalMonthPaid = 0;
    let totalAllTimePaid = 0;

    const results = staffList.map(st => {
      let paidForMonth = 0;
      if (month && /^\d{4}-\d{2}$/.test(month)) {
        const mRow = db.prepare('SELECT COALESCE(SUM(amount), 0) as total FROM staff_payments WHERE staff_id = ? AND payment_date LIKE ?').get(st.id, `${month}%`);
        paidForMonth = mRow ? mRow.total : 0;
      } else {
        const mRow = db.prepare('SELECT COALESCE(SUM(amount), 0) as total FROM staff_payments WHERE staff_id = ?').get(st.id);
        paidForMonth = mRow ? mRow.total : 0;
      }

      const allRow = db.prepare('SELECT COALESCE(SUM(amount), 0) as total FROM staff_payments WHERE staff_id = ?').get(st.id);
      const allTime = allRow ? allRow.total : 0;

      totalMonthPaid += paidForMonth;
      totalAllTimePaid += allTime;

      return {
        ...st,
        total_paid: paidForMonth,
        all_time_paid: allTime
      };
    });

    res.json({
      success: true,
      staff: results,
      month: month || null,
      total_month_paid: totalMonthPaid,
      total_all_time_paid: totalAllTimePaid
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

apiRouter.get('/staff/advance-statement', (req, res) => {
  try {
    const date = req.query.date || getDhakaDate();
    const payments = db.prepare(`
      SELECT sp.*, s.name as staff_name, s.phone as staff_phone, s.address, s.work_post, s.fixed_salary
      FROM staff_payments sp
      JOIN staff s ON sp.staff_id = s.id
      WHERE sp.payment_date = ?
      ORDER BY sp.id DESC
    `).all(date);

    let totalAmount = 0;
    const items = payments.map(p => {
      totalAmount += p.amount || 0;
      const isAdvance = p.amount > (p.fixed_salary || 0) || (p.note && /advance/i.test(p.note));
      return {
        id: p.id,
        date: p.payment_date,
        payment_date: p.payment_date,
        staff_name: p.staff_name,
        staff_phone: p.staff_phone,
        work_post: p.work_post || 'Office Staff',
        address: p.address || '',
        fixed_salary: p.fixed_salary || 0,
        amount: p.amount,
        payment_type: isAdvance ? 'Advance' : 'Salary Payment',
        description: p.note || 'Staff Salary / Advance',
        note: p.note || 'Staff Salary / Advance'
      };
    });

    res.json({
      success: true,
      date,
      totalAmount,
      count: items.length,
      payments: items
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

apiRouter.get('/staff/:id', (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const staff = db.prepare('SELECT * FROM staff WHERE id = ?').get(id);
    if (!staff) {
      return res.status(404).json({ success: false, error: 'Staff member not found' });
    }
    const paidRow = db.prepare('SELECT COALESCE(SUM(amount), 0) as total FROM staff_payments WHERE staff_id = ?').get(id);
    const payments = db.prepare('SELECT * FROM staff_payments WHERE staff_id = ? ORDER BY payment_date DESC, id DESC').all(id);

    res.json({
      success: true,
      data: {
        ...staff,
        total_paid: paidRow ? (paidRow.total || 0) : 0,
        payments
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

apiRouter.post('/staff', (req, res) => {
  try {
    const { name, phone, phone_secondary, primary_contact, address, work_post, fixed_salary, emergency_contact, optional_details } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({ success: false, error: 'Staff name is required' });
    }
    const salary = parseFloat(fixed_salary) || 0;
    const stmt = db.prepare(`
      INSERT INTO staff (name, phone, phone_secondary, primary_contact, address, work_post, fixed_salary, emergency_contact, optional_details)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const result = stmt.run(
      name.trim(),
      phone ? phone.trim() : '',
      phone_secondary ? phone_secondary.trim() : null,
      primary_contact === 'secondary' ? 'secondary' : 'primary',
      address ? address.trim() : '',
      work_post ? work_post.trim() : '',
      salary,
      emergency_contact ? emergency_contact.trim() : null,
      optional_details ? optional_details.trim() : null
    );
    const newStaff = db.prepare('SELECT * FROM staff WHERE id = ?').get(result.lastInsertRowid);
    res.json({ success: true, message: `Staff "${newStaff.name}" added successfully`, data: newStaff });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

apiRouter.put('/staff/:id', (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const staff = db.prepare('SELECT * FROM staff WHERE id = ?').get(id);
    if (!staff) {
      return res.status(404).json({ success: false, error: 'Staff member not found' });
    }
    const name = req.body.name !== undefined ? req.body.name.trim() : staff.name;
    const phone = req.body.phone !== undefined ? req.body.phone.trim() : staff.phone;
    const phone_secondary = req.body.phone_secondary !== undefined ? (req.body.phone_secondary ? req.body.phone_secondary.trim() : null) : staff.phone_secondary;
    const primary_contact = req.body.primary_contact !== undefined ? (req.body.primary_contact === 'secondary' ? 'secondary' : 'primary') : (staff.primary_contact || 'primary');
    const address = req.body.address !== undefined ? req.body.address.trim() : (staff.address || '');
    const work_post = req.body.work_post !== undefined ? req.body.work_post.trim() : (staff.work_post || '');
    const fixed_salary = req.body.fixed_salary !== undefined ? (parseFloat(req.body.fixed_salary) || 0) : staff.fixed_salary;
    const emergency_contact = req.body.emergency_contact !== undefined ? (req.body.emergency_contact ? req.body.emergency_contact.trim() : null) : staff.emergency_contact;
    const optional_details = req.body.optional_details !== undefined ? (req.body.optional_details ? req.body.optional_details.trim() : null) : staff.optional_details;

    db.prepare(`
      UPDATE staff
      SET name = ?, phone = ?, phone_secondary = ?, primary_contact = ?, address = ?, work_post = ?, fixed_salary = ?, emergency_contact = ?, optional_details = ?
      WHERE id = ?
    `).run(name, phone, phone_secondary, primary_contact, address, work_post, fixed_salary, emergency_contact, optional_details, id);

    const updated = db.prepare('SELECT * FROM staff WHERE id = ?').get(id);
    res.json({ success: true, message: `Staff "${updated.name}" updated successfully`, data: updated });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

apiRouter.delete('/staff/:id', requireDeletePermission, (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const staff = db.prepare('SELECT * FROM staff WHERE id = ?').get(id);
    if (!staff) {
      return res.status(404).json({ success: false, error: 'Staff not found' });
    }
    db.prepare('DELETE FROM staff_payments WHERE staff_id = ?').run(id);
    db.prepare('DELETE FROM staff WHERE id = ?').run(id);
    res.json({ success: true, message: `Staff "${staff.name}" deleted successfully` });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

apiRouter.post('/staff/:id/pay', (req, res) => {
  try {
    const staffId = parseInt(req.params.id, 10);
    const staff = db.prepare('SELECT * FROM staff WHERE id = ?').get(staffId);
    if (!staff) {
      return res.status(404).json({ success: false, error: 'Staff not found' });
    }

    const { amount, payment_date, note } = req.body;
    const payAmount = parseFloat(amount);
    if (isNaN(payAmount) || payAmount <= 0) {
      return res.status(400).json({ success: false, error: 'Valid payment amount is required' });
    }

    const paymentDate = (payment_date && /^\d{4}-\d{2}-\d{2}$/.test(payment_date)) ? payment_date : getDhakaDate();
    const isAdvance = payAmount > (staff.fixed_salary || 0);
    const defaultNote = isAdvance ? `Advance payment to staff ${staff.name}` : `Salary / Advance paid to staff ${staff.name}`;
    const payNote = note && note.trim() ? note.trim() : defaultNote;

    // 1. Insert into staff_payments (Stores dedicated staff payment/advance history)
    const payResult = db.prepare(`
      INSERT INTO staff_payments (staff_id, payment_date, amount, note)
      VALUES (?, ?, ?, ?)
    `).run(staffId, paymentDate, payAmount, payNote);

    // 2. Ensure "Staff Salary" expense category exists in expense_categories
    let staffCat = db.prepare("SELECT id FROM expense_categories WHERE name = 'Staff Salary'").get();
    if (!staffCat) {
      const catRes = db.prepare("INSERT INTO expense_categories (name, is_default) VALUES ('Staff Salary', 1)").run();
      staffCat = { id: Number(catRes.lastInsertRowid) };
    }

    // 3. Generate sequential voucher number matching application expenses
    const maxVoucher = db.prepare('SELECT COUNT(*) as count FROM expenses').get();
    const voucherNo = `V-${String(100 + (maxVoucher ? maxVoucher.count : 0) + 1)}`;

    // 4. Create matching expense entry linked directly to the Expense system
    db.prepare(`
      INSERT INTO expenses (category_id, amount, description, expense_date, expense_time, voucher_no)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      staffCat.id,
      payAmount,
      payNote,
      paymentDate,
      getDhakaTime(),
      voucherNo
    );

    res.json({
      success: true,
      message: `Successfully recorded ৳${payAmount.toLocaleString()} payment/advance for staff ${staff.name}. Added to Expense system.`,
      data: {
        paymentId: Number(payResult.lastInsertRowid),
        paidAmount: payAmount,
        paymentDate,
        voucherNo
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ----------------------------------------------------
// OTHERS INCOME ENDPOINTS
// ----------------------------------------------------
apiRouter.get('/others-income', (req, res) => {
  try {
    const startDate = req.query.startDate || null;
    const endDate = req.query.endDate || null;
    let query = 'SELECT * FROM other_collections WHERE 1=1';
    const params = [];

    if (startDate) {
      query += ' AND collection_date >= ?';
      params.push(startDate);
    }
    if (endDate) {
      query += ' AND collection_date <= ?';
      params.push(endDate);
    }

    query += ' ORDER BY collection_date DESC, id DESC';
    const items = db.prepare(query).all(...params);

    let totalAmount = 0;
    items.forEach(i => totalAmount += (i.amount || 0));

    res.json({
      success: true,
      totalAmount,
      count: items.length,
      collections: items
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

apiRouter.post('/others-income', (req, res) => {
  try {
    const { description, amount, collection_date, note } = req.body;
    if (!description || !description.trim()) {
      return res.status(400).json({ success: false, error: 'Description is required for Others income' });
    }
    const amt = parseFloat(amount);
    if (isNaN(amt) || amt <= 0) {
      return res.status(400).json({ success: false, error: 'Valid positive amount is required' });
    }

    const collectionDate = (collection_date && /^\d{4}-\d{2}-\d{2}$/.test(collection_date)) ? collection_date : getDhakaDate();
    const collectionTime = getDhakaTime();

    const maxCol = db.prepare('SELECT COUNT(*) as count FROM other_collections').get();
    const receiptNo = `OTH-${String(1000 + (maxCol ? maxCol.count : 0) + 1)}`;

    const stmt = db.prepare(`
      INSERT INTO other_collections (description, amount, collection_date, collection_time, receipt_no, note)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    const result = stmt.run(description.trim(), amt, collectionDate, collectionTime, receiptNo, note ? note.trim() : description.trim());

    res.json({
      success: true,
      message: `Successfully recorded Others income: ${description.trim()} (৳${amt.toLocaleString()})`,
      data: {
        id: Number(result.lastInsertRowid),
        receipt_no: receiptNo,
        description: description.trim(),
        amount: amt,
        collection_date: collectionDate,
        collection_time: collectionTime
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

apiRouter.delete('/others-income/:id', requireDeletePermission, (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const item = db.prepare('SELECT * FROM other_collections WHERE id = ?').get(id);
    if (!item) {
      return res.status(404).json({ success: false, error: 'Record not found' });
    }
    db.prepare('DELETE FROM other_collections WHERE id = ?').run(id);
    res.json({ success: true, message: 'Others income record deleted successfully' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

apiRouter.post('/seed', requireSuperAdmin, (req, res) => {
  try {
    seedDefaultDataIfEmpty(true);
    res.json({ success: true, message: 'Database reset and re-seeded with realistic records successfully' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

apiRouter.post('/reset-operational', requireSuperAdmin, (req, res) => {
  try {
    db.exec(`
      DELETE FROM payments;
      DELETE FROM expenses;
      DELETE FROM students;
    `);
    res.json({
      success: true,
      message: 'All students, payments, and expenses were cleared. Classes and academic year settings were kept.'
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});