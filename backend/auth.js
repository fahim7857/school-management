import { db } from './database.js';

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_PUBLISHABLE_KEY || '';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

const ROLE_VALUES = new Set(['super_admin', 'staff', 'teacher']);

export function getPublicSupabaseConfig() {
  return {
    url: SUPABASE_URL,
    anonKey: SUPABASE_ANON_KEY
  };
}

export function getTeacherContext(userId) {
  if (!userId) return null;
  const teacher = db.prepare("SELECT * FROM teachers WHERE user_id = ? AND is_active = 1 AND LOWER(status) = 'active'").get(userId);
  if (!teacher) return null;

  const assignments = db.prepare(`
    SELECT ta.subject_id, ta.class_id, s.name as subject_name, c.name as class_name, c.stream
    FROM teacher_assignments ta
    JOIN subjects s ON ta.subject_id = s.id
    JOIN classes c ON ta.class_id = c.id
    WHERE ta.teacher_id = ? AND ta.is_active = 1
  `).all(teacher.id);

  const classTeacherClasses = db.prepare(`
    SELECT id, name, stream, class_number
    FROM classes
    WHERE class_teacher_id = ? AND is_active = 1
  `).all(teacher.id);

  const assignedSubjectIds = new Set(assignments.map(a => a.subject_id));
  const assignedClassIds = new Set(assignments.map(a => a.class_id));
  const classTeacherClassIds = new Set(classTeacherClasses.map(c => c.id));
  const allClassIds = new Set([...assignedClassIds, ...classTeacherClassIds]);

  if (allClassIds.size === 0) {
    return null;
  }

  return {
    teacher,
    profile: teacher,
    assignments,
    assignedSubjectIds,
    assignedClassIds,
    classTeacherClasses,
    classTeacherClassIds,
    allClassIds,
    isClassTeacher(classId) {
      return classTeacherClassIds.has(Number(classId));
    },
    hasSubject(subjectId) {
      return assignedSubjectIds.has(Number(subjectId));
    },
    hasSubjectInClass(classId) {
      return assignedClassIds.has(Number(classId));
    },
    canEditSubjectMarks(classId, subjectId) {
      if (classTeacherClassIds.has(Number(classId))) return true;
      return assignedSubjectIds.has(Number(subjectId));
    },
    canViewClass(classId) {
      return allClassIds.has(Number(classId));
    }
  };
}

function isConfigured(requireServiceRole = false) {
  return Boolean(
    SUPABASE_URL &&
    SUPABASE_ANON_KEY &&
    (!requireServiceRole || SUPABASE_SERVICE_ROLE_KEY)
  );
}

function configurationError(requireServiceRole = false) {
  const missing = [];
  if (!SUPABASE_URL) missing.push('SUPABASE_URL');
  if (!SUPABASE_ANON_KEY) missing.push('SUPABASE_ANON_KEY');
  if (requireServiceRole && !SUPABASE_SERVICE_ROLE_KEY) missing.push('SUPABASE_SERVICE_ROLE_KEY');
  return new Error(`Supabase is not configured. Missing ${missing.join(', ')}.`);
}

function headers({ accessToken, serviceRole = false, json = false } = {}) {
  const key = serviceRole ? SUPABASE_SERVICE_ROLE_KEY : SUPABASE_ANON_KEY;
  const result = {
    apikey: key,
    Accept: 'application/json'
  };
  if (serviceRole) {
    result.Authorization = `Bearer ${key}`;
  } else if (accessToken) {
    result.Authorization = `Bearer ${accessToken}`;
  }
  if (json) result['Content-Type'] = 'application/json';
  return result;
}

async function parseResponse(response) {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { message: text };
  }
}

async function requestSupabase(path, options = {}, { accessToken, serviceRole = false } = {}) {
  if (!isConfigured(serviceRole)) {
    throw configurationError(serviceRole);
  }

  const response = await fetch(`${SUPABASE_URL}${path}`, {
    ...options,
    headers: {
      ...headers({ accessToken, serviceRole, json: Boolean(options.body) }),
      ...(options.headers || {})
    }
  });
  const data = await parseResponse(response);

  if (!response.ok) {
    const error = new Error(data?.msg || data?.message || data?.error_description || 'Supabase request failed');
    error.status = response.status;
    error.details = data;
    throw error;
  }

  return data;
}

export async function getAuthenticatedUser(accessToken) {
  if (!accessToken) return null;
  try {
    return await requestSupabase('/auth/v1/user', { method: 'GET' }, { accessToken });
  } catch (error) {
    if (error.status === 401 || error.status === 403) return null;
    throw error;
  }
}

export async function getUserRole(userId, accessToken) {
  const rows = await requestSupabase(
    `/rest/v1/user_roles?select=role&user_id=eq.${encodeURIComponent(userId)}&limit=1`,
    { method: 'GET' },
    { accessToken }
  );
  const role = Array.isArray(rows) ? rows[0]?.role : null;
  return ROLE_VALUES.has(role) ? role : null;
}

export async function authenticateRequest(req, res, next) {
  const header = req.headers.authorization || '';
  const accessToken = header.startsWith('Bearer ') ? header.slice(7).trim() : '';

  if (!accessToken) {
    return res.status(401).json({
      success: false,
      error: 'Authentication required',
      message: 'Sign in to access this resource.'
    });
  }

  try {
    if (!isConfigured()) {
      throw configurationError();
    }

    const user = await getAuthenticatedUser(accessToken);
    if (!user?.id) {
      return res.status(401).json({
        success: false,
        error: 'Unauthorized',
        message: 'Your session is invalid or has expired.'
      });
    }

    const role = await getUserRole(user.id, accessToken);
    if (!role) {
      return res.status(403).json({
        success: false,
        error: 'Role not assigned',
        message: 'Your account is authenticated but has not been approved for application access.'
      });
    }

    let teacherContext = null;
    if (role === 'teacher') {
      teacherContext = getTeacherContext(user.id);
      if (!teacherContext) {
        return res.status(403).json({
          success: false,
          error: 'Teacher account inactive or unassigned',
          message: 'Your teacher profile is inactive, awaiting approval, or has no active assignments.'
        });
      }
    }

    req.auth = { accessToken, user, role, teacherContext };
    req.teacherContext = teacherContext;
    return next();
  } catch (error) {
    if (error.message.startsWith('Supabase is not configured.')) {
      return res.status(503).json({
        success: false,
        error: 'Authentication is not configured',
        message: 'The application administrator must configure Supabase before sign-in can be used.'
      });
    }

    console.error('Authentication request failed:', error);
    return res.status(401).json({
      success: false,
      error: 'Unauthorized',
      message: 'Your session could not be verified.'
    });
  }
}

export function requireRole(...allowedRoles) {
  return (req, res, next) => {
    if (!req.auth) {
      return res.status(401).json({
        success: false,
        error: 'Authentication required',
        message: 'Sign in to access this resource.'
      });
    }

    if (!allowedRoles.includes(req.auth.role)) {
      return res.status(403).json({
        success: false,
        error: 'Forbidden',
        message: 'You do not have permission to perform this action.'
      });
    }

    return next();
  };
}

export const requireSuperAdmin = requireRole('super_admin');
export const requireStaffOrAdmin = requireRole('super_admin', 'staff');

export function requireDeletePermission(req, res, next) {
  if (!req.auth) {
    return res.status(401).json({
      success: false,
      error: 'Authentication required',
      message: 'Sign in to access this resource.'
    });
  }

  if (req.auth.role !== 'super_admin') {
    return res.status(403).json({
      success: false,
      error: 'Forbidden',
      message: 'Staff users are not allowed to delete records.'
    });
  }

  return next();
}

export async function publicSupabaseRequest(path, options = {}) {
  return requestSupabase(path, options);
}

export async function adminSupabaseRequest(path, options = {}) {
  return requestSupabase(path, options, { serviceRole: true });
}
