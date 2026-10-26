// Centralized Frontend API Client & Helper Utilities
// Uses standard JavaScript fetch() for communication with the Node.js SQLite backend

function debounce(func, wait) {
  let timeout;
  return function (...args) {
    clearTimeout(timeout);
    timeout = setTimeout(() => func.apply(this, args), wait);
  };
}
window.debounce = debounce;

// Derive the API base path from the <base> tag injected by the server when BASE_PATH is set.
// When running locally (no BASE_PATH in .env), no <base> tag is injected → default to '/api'.
// When deployed under a sub-path (e.g. /abms), the server injects <base href="/abms/">
// and we build '/abms/api' automatically — so this works in BOTH environments.
const API_BASE = (() => {
  const baseEl = document.querySelector('base[href]');
  if (baseEl) {
    // e.g. href="/abms/" → strip trailing slash → "/abms" + "/api"
    const basePath = (new URL(baseEl.href)).pathname.replace(/\/+$/, '');
    if (basePath && basePath !== '/') {
      return basePath.endsWith('/api') ? basePath : (basePath.endsWith('/abms') ? basePath + '/api' : basePath + '/api');
    }
  }
  return '/abms/api';
})();

async function authHeaders(extra = {}) {
  if (window.authReady) await window.authReady;
  const token = window.auth?.getAccessToken?.();
  if (!token) {
    throw new Error('Authentication required. Please sign in again.');
  }
  return {
    ...extra,
    Authorization: `Bearer ${token}`
  };
}

// Returns local ISO date YYYY-MM-DD (matches local browser time without UTC skew)
function getLocalIsoDate(d = new Date()) {
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}
window.getLocalIsoDate = getLocalIsoDate;

// fetch() that always sends the login token (use this instead of raw fetch for /api calls)
async function authFetch(url, options = {}) {
  return fetch(url, {
    ...options,
    headers: await authHeaders({
      'X-Client-Date': getLocalIsoDate(),
      ...(options.headers || {})
    })
  });
}
window.authFetch = authFetch;

// Safely parses an API response. Never calls res.json() blindly, so an HTML/non-JSON
// body (login page, SPA fallback, proxy error page) can't produce "Unexpected token '<'".
// On success returns the parsed JSON (same as before). On failure throws an Error with
// .status, .url, .contentType and .isHtml attached.
async function parseApiResponse(res, fallbackMessage) {
  const contentType = (res.headers.get('content-type') || '').toLowerCase();
  const raw = await res.text();

  let data = null;
  let isJson = false;
  if (raw) {
    try {
      data = JSON.parse(raw);
      isJson = true;
    } catch (e) { /* not JSON, handled below */ }
  }

  const fail = (message) => {
    const error = new Error(message);
    error.status = res.status;
    error.url = res.url;
    error.contentType = contentType;
    error.isHtml = !isJson && (contentType.includes('text/html') || /^\s*</.test(raw));
    return error;
  };

  if (!isJson) {
    const preview = raw.slice(0, 200).replace(/\s+/g, ' ');
    console.error(`Non-JSON API response [HTTP ${res.status}] ${res.url} (${contentType || 'no content-type'}):`, preview);

    if (res.status === 401) throw fail('Authentication required. Please sign in again.');
    if (res.status === 403) throw fail('You do not have permission to perform this action.');
    if (res.status === 404) throw fail(`API endpoint not found (HTTP 404): ${res.url}`);
    if (res.status >= 500) throw fail(`Server error (HTTP ${res.status}). Please try again.`);
    if (res.ok) {
      throw fail(`Server returned a web page instead of JSON (HTTP ${res.status}) for ${res.url}. The API route may be misconfigured or your session may have expired.`);
    }
    throw fail(`Unexpected server response (HTTP ${res.status}).`);
  }

  if (!res.ok || !data || !data.success) {
    throw fail((data && data.error) || fallbackMessage);
  }
  return data;
}

const api = {
  async get(endpoint, params = {}) {
    const url = new URL(window.location.origin + API_BASE + endpoint);
    Object.keys(params).forEach(key => {
      if (params[key] !== undefined && params[key] !== null && params[key] !== '') {
        url.searchParams.append(key, params[key]);
      }
    });

    try {
      const res = await fetch(url.toString(), {
        headers: await authHeaders({
          'X-Client-Date': getLocalIsoDate()
        })
      });
      const data = await parseApiResponse(res, 'Server request failed');
      return data;
    } catch (err) {
      console.error(`API GET ${endpoint} Error:`, err);
      throw err;
    }
  },

  async post(endpoint, body = {}) {
    try {
      const res = await fetch(API_BASE + endpoint, {
        method: 'POST',
        headers: await authHeaders({
          'Content-Type': 'application/json',
          'X-Client-Date': getLocalIsoDate()
        }),
        body: JSON.stringify(body)
      });
      const data = await parseApiResponse(res, 'Operation failed');
      return data;
    } catch (err) {
      console.error(`API POST ${endpoint} Error:`, err);
      throw err;
    }
  },

  async put(endpoint, body = {}) {
    try {
      const res = await fetch(API_BASE + endpoint, {
        method: 'PUT',
        headers: await authHeaders({
          'Content-Type': 'application/json',
          'X-Client-Date': getLocalIsoDate()
        }),
        body: JSON.stringify(body)
      });
      const data = await parseApiResponse(res, 'Update failed');
      return data;
    } catch (err) {
      console.error(`API PUT ${endpoint} Error:`, err);
      throw err;
    }
  },

  async patch(endpoint, body = {}) {
    try {
      const res = await fetch(API_BASE + endpoint, {
        method: 'PATCH',
        headers: await authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify(body)
      });
      const data = await parseApiResponse(res, 'Action failed');
      return data;
    } catch (err) {
      console.error(`API PATCH ${endpoint} Error:`, err);
      throw err;
    }
  },

  async delete(endpoint) {
    try {
      if (window.auth?.state?.role === 'staff') {
        const error = new Error('Staff users are not allowed to delete records.');
        error.status = 403;
        throw error;
      }
      const res = await fetch(API_BASE + endpoint, {
        method: 'DELETE',
        headers: await authHeaders({ 'Content-Type': 'application/json' })
      });
      const data = await parseApiResponse(res, 'Delete failed');
      return data;
    } catch (err) {
      console.error(`API DELETE ${endpoint} Error:`, err);
      throw err;
    }
  }
};
window.api = api;
window.showToast = showToast;
function showToast(message, type = 'success') {
  let container = document.getElementById('toast-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toast-container';
    document.body.appendChild(container);
  }

  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.innerHTML = `
    <span class="material-symbols-outlined" style="font-size: 1.2rem; color: ${type === 'success' ? '#22c55e' : '#ef4444'}">
      ${type === 'success' ? 'check_circle' : 'error'}
    </span>
    <span>${message}</span>
  `;

  container.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateX(100%)';
    toast.style.transition = 'all 0.3s ease';
    setTimeout(() => toast.remove(), 300);
  }, 4000);
}

// Safe HTML escaping
function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Format Currency
function formatCurrency(num) {
  const val = Number(num) || 0;
  return '৳ ' + val.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// Format Short Currency (e.g. ৳ 8.5k or ৳ 1,000)
function formatShortCurrency(num) {
  const val = Number(num) || 0;
  return '৳ ' + val.toLocaleString('en-US');
}

// Format Date to Day/Month/Year (DD/MM/YYYY)
function formatDate(dateStr) {
  if (!dateStr) return '';
  const str = String(dateStr).trim();
  if (str.includes('-')) {
    const parts = str.split('T')[0].split('-');
    if (parts.length === 3) {
      if (parts[0].length === 4) {
        // YYYY-MM-DD -> DD/MM/YYYY
        return `${parts[2].padStart(2, '0')}/${parts[1].padStart(2, '0')}/${parts[0]}`;
      } else if (parts[2].length === 4) {
        // MM-DD-YYYY -> DD/MM/YYYY
        return `${parts[1].padStart(2, '0')}/${parts[0].padStart(2, '0')}/${parts[2]}`;
      }
    }
  }
  if (str.includes('/')) {
    const parts = str.split('/');
    if (parts.length === 3) {
      if (parts[2].length === 4 && parseInt(parts[0], 10) <= 12 && parseInt(parts[1], 10) > 12) {
        return `${parts[1].padStart(2, '0')}/${parts[0].padStart(2, '0')}/${parts[2]}`;
      } else if (parts[2].length === 4) {
        return `${parts[0].padStart(2, '0')}/${parts[1].padStart(2, '0')}/${parts[2]}`;
      }
    }
  }
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return dateStr;
  const day = String(d.getDate()).padStart(2, '0');
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const year = d.getFullYear();
  return `${day}/${month}/${year}`;
}

// Modal helper
function openModal(id) {
  const modal = document.getElementById(id);
  if (modal) {
    modal.classList.add('open');
    document.body.style.overflow = 'hidden';
  }
}

function closeModal(id) {
  const modal = document.getElementById(id);
  if (modal) {
    modal.classList.remove('open');
    document.body.style.overflow = '';
  }
}
window.openModal = openModal;
window.closeModal = closeModal;

// Get dynamic continuous current month name
function getCurrentMonthName() {
  const months = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'
  ];
  return months[new Date().getMonth()];
}

// Format current present day dynamically (e.g. 21 September 2026)
function formatCurrentDate() {
  const now = new Date();
  const options = { day: 'numeric', month: 'long', year: 'numeric' };
  return now.toLocaleDateString('en-GB', options);
}

// Dynamic Academic Year Central Manager
let cachedAcademicYears = [];
let activeAcademicYear = null;
let selectedAcademicYear = null;
let academicYearPromise = null;

function ensureAcademicYearContext() {
  if (!academicYearPromise) {
    academicYearPromise = loadAcademicYearContext().catch(err => {
      console.warn('ensureAcademicYearContext error:', err);
      academicYearPromise = null;
    });
  }
  return academicYearPromise;
}

// Initiate context immediately on script load
ensureAcademicYearContext();

async function loadAcademicYearContext() {
  try {
    const [activeRes, allRes] = await Promise.all([
      api.get('/academic-years/active'),
      api.get('/academic-years')
    ]);

    activeAcademicYear = activeRes.data || null;
    cachedAcademicYears = allRes.data || (activeAcademicYear ? [activeAcademicYear] : []);

    // Check if user previously selected a year in this session
    const stored = sessionStorage.getItem('selected_academic_year');
    if (stored) {
      try {
        const parsed = JSON.parse(stored);
        const match = cachedAcademicYears.find(y => y.id === parsed.id || y.year === parsed.year);
        if (match) {
          selectedAcademicYear = match;
        } else {
          sessionStorage.removeItem('selected_academic_year');
        }
      } catch (e) { }
    }

    if (!selectedAcademicYear) {
      selectedAcademicYear = activeAcademicYear || cachedAcademicYears[0] || null;
    }

    applyAcademicYearToUI();
    return { activeAcademicYear, selectedAcademicYear, cachedAcademicYears };
  } catch (err) {
    console.warn('Could not load academic year context:', err.message);
    const fallbackYear = new Date().getFullYear();
    activeAcademicYear = { id: null, year: fallbackYear, is_active: 1 };
    selectedAcademicYear = activeAcademicYear;
    cachedAcademicYears = [activeAcademicYear];
    applyAcademicYearToUI();
    return { activeAcademicYear, selectedAcademicYear, cachedAcademicYears };
  }
}

function getSelectedAcademicYear() {
  if (selectedAcademicYear && selectedAcademicYear.id) return selectedAcademicYear;
  if (activeAcademicYear && activeAcademicYear.id) return activeAcademicYear;
  if (cachedAcademicYears && cachedAcademicYears.length > 0 && cachedAcademicYears[0].id) return cachedAcademicYears[0];
  try {
    const stored = sessionStorage.getItem('selected_academic_year');
    if (stored) {
      const parsed = JSON.parse(stored);
      if (parsed && parsed.id) return parsed;
    }
  } catch (e) { }
  return { id: null, year: new Date().getFullYear(), is_active: 1 };
}

function getActiveAcademicYearData() {
  return activeAcademicYear || { id: null, year: new Date().getFullYear(), is_active: 1 };
}

function setSelectedAcademicYear(yearObj, shouldReload = true) {
  selectedAcademicYear = yearObj;
  sessionStorage.setItem('selected_academic_year', JSON.stringify(yearObj));
  applyAcademicYearToUI();
  window.dispatchEvent(new CustomEvent('academicYearChanged', { detail: yearObj }));
  if (shouldReload) {
    window.location.reload();
  }
}

function applyAcademicYearToUI() {
  const currentYear = getSelectedAcademicYear();
  const yearNum = currentYear.year;

  // Render topbar selector if not already created
  let topbarActions = document.querySelector('.topbar-actions');
  if (topbarActions && !document.getElementById('topbar-ay-select')) {
    const selectorContainer = document.createElement('div');
    selectorContainer.className = 'topbar-ay-selector';
    selectorContainer.innerHTML = `
      <select id="topbar-ay-select" class="badge-tag-select" title="Switch Academic Year">
        ${cachedAcademicYears.map(y => `
          <option value="${y.id}" ${y.id === currentYear.id ? 'selected' : ''}>
            AY ${y.year} ${y.is_active ? '● Active' : '(Archive)'}
          </option>
        `).join('')}
      </select>
    `;
    const oldBadge = topbarActions.querySelector('.badge-tag');
    if (oldBadge) {
      oldBadge.replaceWith(selectorContainer);
    } else {
      topbarActions.insertBefore(selectorContainer, topbarActions.firstChild);
    }

    const selectEl = document.getElementById('topbar-ay-select');
    if (selectEl) {
      selectEl.addEventListener('change', (e) => {
        const chosenId = parseInt(e.target.value, 10);
        const chosen = cachedAcademicYears.find(y => y.id === chosenId);
        if (chosen) {
          setSelectedAcademicYear(chosen, true);
        }
      });
    }
  } else if (document.getElementById('topbar-ay-select')) {
    const selectEl = document.getElementById('topbar-ay-select');
    selectEl.innerHTML = cachedAcademicYears.map(y => `
      <option value="${y.id}" ${y.id === currentYear.id ? 'selected' : ''}>
        AY ${y.year} ${y.is_active ? '● Active' : '(Archive)'}
      </option>
    `).join('');
  }

  // Update any other AY badges, titles, form labels
  document.querySelectorAll('.badge-tag').forEach(badge => {
    if (badge.textContent.includes('2026')) {
      badge.textContent = badge.textContent.replace('2026', String(yearNum));
    }
  });

  // Update input fields with 'Academic Year ...'
  document.querySelectorAll('input').forEach(inp => {
    if (inp.value && inp.value.includes('Academic Year')) {
      inp.value = `Academic Year ${yearNum}`;
    }
  });

  // Update student registration AY input if present
  const addStudentAy = document.getElementById('modal-add-student-ay');
  if (addStudentAy) {
    addStudentAy.value = `Academic Year ${yearNum}`;
  }
}

// Initialize dynamic dates on all pages
function initDynamicDates() {
  const formattedToday = formatCurrentDate();
  document.querySelectorAll('.topbar-date').forEach(el => {
    el.textContent = formattedToday;
  });

  // Automatically default date inputs to today's local date
  const todayIso = getLocalIsoDate();
  document.querySelectorAll('input[type="date"]').forEach(inp => {
    if (!inp.value || inp.value === '2026-09-18' || inp.value === '2026-09-21') {
      inp.value = todayIso;
    }
  });
}

// Initialize sidebar controls (search bar and live net balance display)
async function initSidebarControls() {
  // Sidebar Search Box listener
  const sidebarSearch = document.getElementById('sidebar-search-input');
  if (sidebarSearch) {
    sidebarSearch.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const val = sidebarSearch.value.trim();
        if (val) {
          window.location.href = `students.html?search=${encodeURIComponent(val)}`;
        }
      }
    });
  }

  // Load and update sidebar net balance display
  try {
    const res = await api.get('/dashboard', { period: 'month' });
    if (res && res.stats) {
      const net = res.stats.monthly ? res.stats.monthly.net : (res.stats.today ? res.stats.today.net : 0);
      const balanceEls = document.querySelectorAll('#sidebar-net-balance-val');
      balanceEls.forEach(el => {
        el.textContent = formatCurrency(net);
      });
    }
  } catch (err) {
    console.debug('Sidebar balance sync deferred:', err.message);
  }
}

// Print Money Receipt Modal (Fee Collection)
function openPrintReceiptModal(paymentData) {
  let modal = document.getElementById('modal-print-receipt');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'modal-print-receipt';
    modal.className = 'modal-overlay';
    modal.innerHTML = `
      <div class="modal-dialog" style="max-width: 540px;">
        <div class="modal-header">
          <h3 class="modal-title">Fee Money Receipt</h3>
          <button class="modal-close" onclick="closeModal('modal-print-receipt')">&times;</button>
        </div>
        <div class="modal-body" id="receipt-printable-content">
          <!-- Populated dynamically -->
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" onclick="closeModal('modal-print-receipt')">Close</button>
          <button class="btn btn-primary" onclick="printVoucherContent('receipt-printable-content', 'Fee Money Receipt')">
            <span class="material-symbols-outlined" style="font-size: 1.1rem;">print</span>
            Print Voucher
          </button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);
  }

  const content = document.getElementById('receipt-printable-content');
  const formattedDate = formatDate(paymentData.payment_date || paymentData.date || getLocalIsoDate());
  const yearStr = paymentData.year || new Date().getFullYear();
  const rawAmt = paymentData.amount !== undefined ? paymentData.amount : (paymentData.fee || 0);
  const numAmt = parseFloat(rawAmt) || 0;
  const formattedAmount = formatCurrency(numAmt);
  const noteText = paymentData.note || paymentData.remarks || 'Monthly tuition fee';

  content.innerHTML = `
    <div style="border: 2px dashed #cbd5e1; padding: 1.5rem; border-radius: 8px; background: #fff;">
      <div style="text-align: center; border-bottom: 2px solid #004ac6; padding-bottom: 0.75rem; margin-bottom: 1rem;">
        <h2 style="color: #004ac6; font-size: 1.25rem; font-weight: 700; margin: 0;">COACHING CENTER MANAGEMENT</h2>
        <p style="font-size: 0.75rem; color: #64748b; margin-top: 2px;">ALEYA BEGUM MODERN SCHOOL</p>
        <span style="display: inline-block; background: #2563eb; color: #fff; font-size: 0.7rem; font-weight: 700; padding: 2px 10px; border-radius: 9999px; margin-top: 6px;">
          MONEY RECEIPT (OFFICIAL)
        </span>
      </div>

      <div style="display: flex; justify-content: space-between; font-size: 0.8rem; margin-bottom: 0.75rem; color: #334155;">
        <div><strong>Receipt No:</strong> ${paymentData.receipt_no || paymentData.receiptNo}</div>
        <div><strong>Date:</strong> ${formattedDate} (${paymentData.payment_time || paymentData.time || '10:00 AM'})</div>
      </div>

      <table style="width: 100%; font-size: 0.82rem; margin-bottom: 1rem; border-collapse: collapse;">
        <tr style="border-bottom: 1px solid #f1f5f9;">
          <td style="padding: 6px 0; color: #64748b;">Student Name:</td>
          <td style="padding: 6px 0; font-weight: 600; text-align: right;">${paymentData.student_name || paymentData.studentName}</td>
        </tr>
        <tr style="border-bottom: 1px solid #f1f5f9;">
          <td style="padding: 6px 0; color: #64748b;">Roll Number:</td>
          <td style="padding: 6px 0; font-weight: 600; text-align: right;">#${paymentData.roll_number || paymentData.roll}</td>
        </tr>
        <tr style="border-bottom: 1px solid #f1f5f9;">
          <td style="padding: 6px 0; color: #64748b;">Class / Cohort:</td>
          <td style="padding: 6px 0; font-weight: 600; text-align: right;">${paymentData.class_name || 'Class 5'}</td>
        </tr>
        <tr style="border-bottom: 1px solid #f1f5f9;">
          <td style="padding: 6px 0; color: #64748b;">Billing Month:</td>
          <td style="padding: 6px 0; font-weight: 600; text-align: right; color: #004ac6;">${paymentData.month} ${yearStr}</td>
        </tr>
        <tr style="border-bottom: 1px solid #f1f5f9;">
          <td style="padding: 6px 0; color: #64748b;">Fee Amount:</td>
          <td style="padding: 6px 0; font-weight: 700; text-align: right; color: #16a34a;">${formattedAmount}</td>
        </tr>
        <tr style="border-bottom: 1px solid #f1f5f9;">
          <td style="padding: 6px 0; color: #64748b;">Payment Method:</td>
          <td style="padding: 6px 0; font-weight: 600; text-align: right;">${paymentData.payment_method || 'Cash'}</td>
        </tr>
        <tr style="border-bottom: 1px solid #f1f5f9;">
          <td style="padding: 6px 0; color: #64748b;">Remarks / Note:</td>
          <td style="padding: 6px 0; font-weight: 600; text-align: right; color: #1e293b;">${noteText}</td>
        </tr>
      </table>

      <div style="background: #f8faff; border: 1px solid #e2e8f0; border-radius: 6px; padding: 0.75rem 1rem; display: flex; justify-content: space-between; align-items: center; margin-bottom: 1.5rem;">
        <span style="font-weight: 700; font-size: 0.85rem; color: #1e293b;">Total Received:</span>
        <span style="font-weight: 800; font-size: 1.2rem; color: #16a34a;">${formattedAmount}</span>
      </div>

      <div style="display: flex; justify-content: space-between; margin-top: 2rem; font-size: 0.75rem; color: #64748b; padding-top: 1rem; border-top: 1px dashed #e2e8f0;">
        <div style="text-align: center; width: 140px;">
          <div style="border-bottom: 1px solid #94a3b8; height: 30px;"></div>
          <div style="margin-top: 4px;">Student / Guardian</div>
        </div>
        <div style="text-align: center; width: 140px;">
          <div style="border-bottom: 1px solid #94a3b8; height: 30px;"></div>
          <div style="margin-top: 4px; font-weight: 600; color: #004ac6;">Authorized Signature</div>
        </div>
      </div>
    </div>
  `;

  openModal('modal-print-receipt');
}

// Print Expense Receipt Modal (Debit Voucher)
function openPrintExpenseReceiptModal(expenseData) {
  let modal = document.getElementById('modal-print-expense-receipt');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'modal-print-expense-receipt';
    modal.className = 'modal-overlay';
    modal.innerHTML = `
      <div class="modal-dialog" style="max-width: 540px;">
        <div class="modal-header">
          <h3 class="modal-title">Expense Payment Receipt</h3>
          <button class="modal-close" onclick="closeModal('modal-print-expense-receipt')">&times;</button>
        </div>
        <div class="modal-body" id="expense-receipt-printable-content">
          <!-- Populated dynamically -->
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" onclick="closeModal('modal-print-expense-receipt')">Close</button>
          <button class="btn btn-primary" onclick="printVoucherContent('expense-receipt-printable-content', 'Expense Payment Receipt')">
            <span class="material-symbols-outlined" style="font-size: 1.1rem;">print</span>
            Print Voucher
          </button>
          <button class="btn btn-secondary" style="color: #dc2626;" onclick="deleteExpenseFromReceiptModal()">
            <span class="material-symbols-outlined" style="font-size: 1.1rem;">delete</span>
            Delete Voucher
          </button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);
  }

  // Track which expense this modal is currently showing, so Delete Voucher knows what to delete
  modal.dataset.expenseId = (expenseData && expenseData.id != null) ? String(expenseData.id) : '';

  const content = document.getElementById('expense-receipt-printable-content');
  const formattedDate = formatDate(expenseData.expense_date || expenseData.date || getLocalIsoDate());
  const voucherNo = expenseData.voucher_no || expenseData.voucherNo || ('EXP-' + String(expenseData.id || '0000').padStart(4, '0'));
  const categoryName = expenseData.category_name || expenseData.categoryName || 'General Expense';
  const description = expenseData.description || 'Institutional expenditure';
  const amount = expenseData.amount || 0;
  const time = expenseData.expense_time || expenseData.time || '10:00 AM';

  content.innerHTML = `
    <div style="border: 2px dashed #cbd5e1; padding: 1.5rem; border-radius: 8px; background: #fff;">
      <div style="text-align: center; border-bottom: 2px solid #dc2626; padding-bottom: 0.75rem; margin-bottom: 1rem;">
        <h2 style="color: #004ac6; font-size: 1.25rem; font-weight: 700; margin: 0;">COACHING CENTER MANAGEMENT</h2>
        <p style="font-size: 0.75rem; color: #64748b; margin-top: 2px;">ALEYA BEGUM MODERN SCHOOL</p>
        <span style="display: inline-block; background: #dc2626; color: #fff; font-size: 0.7rem; font-weight: 700; padding: 2px 10px; border-radius: 9999px; margin-top: 6px;">
          DEBIT VOUCHER / EXPENSE RECEIPT (OFFICIAL)
        </span>
      </div>

      <div style="display: flex; justify-content: space-between; font-size: 0.8rem; margin-bottom: 0.75rem; color: #334155;">
        <div><strong>Voucher No:</strong> ${voucherNo}</div>
        <div><strong>Date:</strong> ${formattedDate} (${time})</div>
      </div>

      <table style="width: 100%; font-size: 0.82rem; margin-bottom: 1rem; border-collapse: collapse;">
        <tr style="border-bottom: 1px solid #f1f5f9;">
          <td style="padding: 6px 0; color: #64748b;">Expense Category:</td>
          <td style="padding: 6px 0; font-weight: 700; text-align: right; color: #004ac6;">${categoryName}</td>
        </tr>
        <tr style="border-bottom: 1px solid #f1f5f9;">
          <td style="padding: 6px 0; color: #64748b;">Particulars / Description:</td>
          <td style="padding: 6px 0; font-weight: 500; text-align: right; max-width: 250px;">${description}</td>
        </tr>
        <tr style="border-bottom: 1px solid #f1f5f9;">
          <td style="padding: 6px 0; color: #64748b;">Disbursement Method:</td>
          <td style="padding: 6px 0; font-weight: 600; text-align: right;">Cash / Institutional Account</td>
        </tr>
        <tr style="border-bottom: 1px solid #f1f5f9;">
          <td style="padding: 6px 0; color: #64748b;">Settlement Status:</td>
          <td style="padding: 6px 0; font-weight: 700; text-align: right; color: #16a34a;">Approved & Settled</td>
        </tr>
      </table>

      <div style="background: #fef2f2; border: 1px solid #fee2e2; border-radius: 6px; padding: 0.75rem 1rem; display: flex; justify-content: space-between; align-items: center; margin-bottom: 1.5rem;">
        <span style="font-weight: 700; font-size: 0.85rem; color: #1e293b;">Total Disbursed:</span>
        <span style="font-weight: 800; font-size: 1.2rem; color: #dc2626;">${formatCurrency(amount)}</span>
      </div>

      <div style="display: flex; justify-content: space-between; margin-top: 2rem; font-size: 0.75rem; color: #64748b; padding-top: 1rem; border-top: 1px dashed #e2e8f0;">
        <div style="text-align: center; width: 140px;">
          <div style="border-bottom: 1px solid #94a3b8; height: 30px;"></div>
          <div style="margin-top: 4px;">Paid To / Receiver</div>
        </div>
        <div style="text-align: center; width: 140px;">
          <div style="border-bottom: 1px solid #94a3b8; height: 30px;"></div>
          <div style="margin-top: 4px; font-weight: 600; color: #004ac6;">Authorized Signatory</div>
        </div>
      </div>
    </div>
  `;

  openModal('modal-print-expense-receipt');
}

// Deletes the expense currently shown in the post-submission receipt modal.
// Reuses the same confirm/endpoint/toast pattern as the Expenses page's own delete button,
// then closes the modal and refreshes the expenses table if it's on screen.
async function deleteExpenseFromReceiptModal() {
  const modal = document.getElementById('modal-print-expense-receipt');
  const id = modal ? modal.dataset.expenseId : '';
  if (!id) {
    showToast('Could not determine which expense to delete.', 'error');
    return;
  }
  if (!confirm('Are you sure you want to delete this expense voucher? This action is permanent.')) return;
  try {
    await api.delete(`/expenses/${id}`);
    showToast('Expense voucher deleted', 'success');
    closeModal('modal-print-expense-receipt');
    if (typeof window.loadExpenses === 'function') {
      await window.loadExpenses();
    }
  } catch (err) {
    showToast(err.message, 'error');
  }
}
window.deleteExpenseFromReceiptModal = deleteExpenseFromReceiptModal;

// -------------------------------------------------------------
// Daily Voucher Modal & Printing
// -------------------------------------------------------------
async function openDailyVoucherModal(defaultType) {
  // Payments use their own completely separate modal & logic (see PAYMENT VOUCHERS section below)
  const voucherContext = resolveVoucherContext(defaultType);
  if (voucherContext === 'payments') {
    return openPaymentDailyVoucherModal();
  }
  defaultType = voucherContext;

  let modal = document.getElementById('modal-daily-voucher');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'modal-daily-voucher';
    modal.className = 'modal-overlay';
    modal.innerHTML = `
      <div class="modal-dialog" style="max-width: 760px; width: 95%;">
        <div class="modal-header">
          <h3 class="modal-title" style="display: flex; align-items: center; gap: 0.5rem;">
            <span class="material-symbols-outlined" style="color: #004ac6;">calendar_today</span>
            Daily Voucher — Print by Any Date
          </h3>
          <button class="modal-close" onclick="closeModal('modal-daily-voucher')">&times;</button>
        </div>
        
        <!-- Controls Bar (Hidden during window.print()) -->
        <div class="voucher-controls-bar" style="background: #f8fafc; padding: 0.85rem 1.25rem; border-bottom: 1px solid #e2e8f0; display: flex; align-items: center; justify-content: space-between; gap: 0.75rem; flex-wrap: wrap;">
          <div style="display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap;">
            <label style="font-size: 0.85rem; font-weight: 600; color: #475569; display: flex; align-items: center; gap: 0.25rem;">
              Select Date:
              <input type="date" id="daily-voucher-date" class="form-control" style="padding: 0.35rem 0.6rem; font-size: 0.85rem; border: 1px solid #cbd5e1; border-radius: 6px;" onchange="fetchAndRenderDailyVoucher()">
            </label>
            <label style="font-size: 0.85rem; font-weight: 600; color: #475569; display: flex; align-items: center; gap: 0.25rem;">
              Category Type:
              <select id="daily-voucher-type" class="form-control" style="padding: 0.35rem 0.6rem; font-size: 0.85rem; border: 1px solid #cbd5e1; border-radius: 6px;" onchange="fetchAndRenderDailyVoucher()">
                <option value="expenses">Expenses Outflow</option>
              </select>
            </label>
          </div>
          <div>
            <button class="btn btn-secondary btn-sm" onclick="fetchAndRenderDailyVoucher()" style="display: inline-flex; align-items: center; gap: 0.25rem;">
              <span class="material-symbols-outlined" style="font-size: 1rem;">refresh</span> Reload
            </button>
          </div>
        </div>

        <div class="modal-body" id="daily-voucher-printable-content" style="max-height: 70vh; overflow-y: auto; padding: 1.25rem;">
          <div style="text-align: center; padding: 2rem; color: #64748b;">Loading voucher data...</div>
        </div>

        <div class="modal-footer" style="display: flex; justify-content: space-between; align-items: center;">
          <button class="btn btn-secondary" onclick="closeModal('modal-daily-voucher')">Close</button>
          <button class="btn btn-primary" onclick="printVoucherContent('daily-voucher-printable-content', 'Daily Voucher')">
            <span class="material-symbols-outlined" style="font-size: 1.1rem;">print</span>
            Print Voucher
          </button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);
  }

  // Set default date to today or current date if not set
  const dateInput = document.getElementById('daily-voucher-date');
  if (dateInput && !dateInput.value) {
    dateInput.value = getLocalIsoDate();
  }
  const typeSelect = document.getElementById('daily-voucher-type');
  if (typeSelect && defaultType) {
    typeSelect.value = defaultType;
  }

  openModal('modal-daily-voucher');
  fetchAndRenderDailyVoucher();
}

async function fetchAndRenderDailyVoucher() {
  const container = document.getElementById('daily-voucher-printable-content');
  if (!container) return;

  const dateInput = document.getElementById('daily-voucher-date');
  const typeSelect = document.getElementById('daily-voucher-type');
  const dateVal = dateInput ? dateInput.value : getLocalIsoDate();
  const typeVal = typeSelect ? typeSelect.value : 'expenses';

  if (!dateVal) {
    container.innerHTML = `<div style="text-align: center; color: #dc2626; padding: 2rem;">Please select a valid date.</div>`;
    return;
  }

  container.innerHTML = `
    <div style="text-align: center; padding: 2rem; color: #64748b;">
      <span class="material-symbols-outlined" style="font-size: 2rem; animation: spin 1s linear infinite; display: inline-block;">autorenew</span>
      <div style="margin-top: 0.5rem;">Fetching daily records for ${formatDate(dateVal)}...</div>
    </div>
  `;

  try {
    // FIX: use authFetch so the login token is sent (was raw fetch -> 401 Unauthorized)
    const res = await authFetch(`/abms/api/vouchers/daily?date=${encodeURIComponent(dateVal)}&type=${encodeURIComponent(typeVal)}`);
    if (!res.ok) {
      let msg = res.statusText;
      try { msg = (await res.json()).error || msg; } catch (e) { }
      throw new Error(`Failed to load voucher: ${msg}`);
    }
    const data = await res.json();
    renderDailyVoucherHtml(container, data);
  } catch (err) {
    console.error('Error fetching daily voucher:', err);
    container.innerHTML = `
      <div style="text-align: center; padding: 2rem; color: #dc2626;">
        <p><strong>Failed to load daily voucher data.</strong></p>
        <p style="font-size: 0.85rem; color: #64748b; margin-top: 0.5rem;">${escapeHtml(err.message)}</p>
        <button class="btn btn-secondary btn-sm" onclick="fetchAndRenderDailyVoucher()" style="margin-top: 1rem;">Retry</button>
      </div>
    `;
  }
}

function renderDailyVoucherHtml(container, data) {
  const payload = (data && data.data) ? data.data : (data || {});
  const formattedDate = payload.formattedDate || formatDate(payload.date);
  const type = payload.type || 'expenses';

  let voucherTitle = 'DAILY FINANCIAL VOUCHER';
  if (type === 'expenses') voucherTitle = 'DAILY EXPENSE VOUCHER';
  else if (type === 'payments') voucherTitle = 'DAILY COLLECTION VOUCHER';

  let bodyContentHtml = '';

  if (type === 'expenses' || type === 'all') {
    const expCategories = (payload.expenses && payload.expenses.categories) || payload.expenseCategories || [];
    const expTotal = (payload.expenses && payload.expenses.total !== undefined) ? payload.expenses.total : (payload.totalExpenses || 0);

    let rowsHtml = '';
    if (expCategories.length === 0) {
      rowsHtml = `
        <tr>
          <td colspan="4" style="text-align: center; padding: 1.5rem; color: #94a3b8; font-style: italic;">
            No expenses recorded on this date.
          </td>
        </tr>
      `;
    } else {
      expCategories.forEach((cat, catIdx) => {
        const catName = cat.category_name || cat.categoryName || 'General';
        const catTotal = cat.total_amount !== undefined ? cat.total_amount : (cat.totalAmount || 0);
        const items = cat.items || [];
        const isMulti = items.length > 1;

        if (isMulti) {
          // Category header row
          rowsHtml += `
            <tr style="background: #f8fafc; font-weight: 700; border-top: 1px solid #cbd5e1; border-bottom: 1px solid #e2e8f0;">
              <td style="padding: 8px 10px; color: #1e293b;">${catIdx + 1}</td>
              <td colspan="2" style="padding: 8px 10px; color: #004ac6;">
                <strong>${escapeHtml(catName)}</strong>
                <span style="font-size: 0.75rem; color: #64748b; font-weight: 500; margin-left: 6px;">(${items.length} entries)</span>
              </td>
              <td style="padding: 8px 10px; text-align: right; color: #dc2626; font-weight: 700;">
                Subtotal: ${formatCurrency(catTotal)}
              </td>
            </tr>
          `;
          // Itemized rows
          items.forEach((item, itemIdx) => {
            const voucherNo = item.voucher_no || item.voucherNo;
            rowsHtml += `
              <tr style="border-bottom: 1px solid #f1f5f9; font-size: 0.8rem;">
                <td style="padding: 5px 10px 5px 25px; color: #64748b;">${catIdx + 1}.${itemIdx + 1}</td>
                <td style="padding: 5px 10px; color: #334155;">
                  ${escapeHtml(item.description || 'General expenditure')}
                  ${voucherNo ? `<span style="font-size: 0.7rem; color: #94a3b8; margin-left: 6px;">[${escapeHtml(voucherNo)}]</span>` : ''}
                </td>
                <td style="padding: 5px 10px; color: #64748b;">${escapeHtml(item.time || '')}</td>
                <td style="padding: 5px 10px; text-align: right; color: #334155; font-weight: 500;">
                  ${formatCurrency(item.amount)}
                </td>
              </tr>
            `;
          });
        } else {
          // Single item under category
          const item = items[0] || {};
          const voucherNo = item.voucher_no || item.voucherNo;
          rowsHtml += `
            <tr style="border-bottom: 1px solid #e2e8f0;">
              <td style="padding: 8px 10px; color: #64748b;">${catIdx + 1}</td>
              <td style="padding: 8px 10px; color: #1e293b; font-weight: 600;">
                ${escapeHtml(catName)}
                ${item.description ? `<div style="font-size: 0.75rem; color: #64748b; font-weight: 400;">${escapeHtml(item.description)}</div>` : ''}
              </td>
              <td style="padding: 8px 10px; color: #64748b; font-size: 0.8rem;">
                ${escapeHtml(item.time || '')}
                ${voucherNo ? `<div style="font-size: 0.7rem; color: #94a3b8;">${escapeHtml(voucherNo)}</div>` : ''}
              </td>
              <td style="padding: 8px 10px; text-align: right; font-weight: 700; color: #dc2626;">
                ${formatCurrency(catTotal)}
              </td>
            </tr>
          `;
        }
      });
    }

    bodyContentHtml += `
      <div style="margin-bottom: 1.5rem;">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.5rem;">
          <h4 style="margin: 0; font-size: 0.95rem; font-weight: 700; color: #1e293b; display: flex; align-items: center; gap: 0.35rem;">
            <span class="material-symbols-outlined" style="color: #dc2626; font-size: 1.1rem;">trending_down</span>
            Expense Categories Outflow
          </h4>
          <span style="font-size: 0.8rem; font-weight: 600; color: #dc2626; background: #fee2e2; padding: 2px 8px; border-radius: 9999px;">
            Total: ${formatCurrency(expTotal)}
          </span>
        </div>

        <table style="width: 100%; border-collapse: collapse; font-size: 0.83rem; border: 1px solid #cbd5e1;">
          <thead>
            <tr style="background: #f1f5f9; border-bottom: 2px solid #cbd5e1; text-align: left;">
              <th style="padding: 8px 10px; width: 40px; color: #475569;">#</th>
              <th style="padding: 8px 10px; color: #475569;">Category & Particulars</th>
              <th style="padding: 8px 10px; width: 110px; color: #475569;">Time / Ref</th>
              <th style="padding: 8px 10px; text-align: right; width: 130px; color: #475569;">Amount</th>
            </tr>
          </thead>
          <tbody>
            ${rowsHtml}
          </tbody>
          <tfoot>
            <tr style="background: #f8fafc; border-top: 2px solid #cbd5e1; font-weight: 700;">
              <td colspan="3" style="padding: 10px; text-align: right; color: #1e293b; font-size: 0.9rem;">
                Total Expenses for ${formattedDate}:
              </td>
              <td style="padding: 10px; text-align: right; color: #dc2626; font-size: 1rem;">
                ${formatCurrency(expTotal)}
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
    `;
  }

  if (type === 'payments' || type === 'all') {
    const payCategories = (payload.payments && payload.payments.categories) || payload.paymentCategories || [];
    const payTotal = (payload.payments && payload.payments.total !== undefined) ? payload.payments.total : (payload.totalPayments || 0);

    let payRowsHtml = '';
    if (payCategories.length === 0) {
      payRowsHtml = `
        <tr>
          <td colspan="4" style="text-align: center; padding: 1.5rem; color: #94a3b8; font-style: italic;">
            No fee payments collected on this date.
          </td>
        </tr>
      `;
    } else {
      payCategories.forEach((cat, catIdx) => {
        const catName = cat.category_name || cat.categoryName || 'Fee Collection';
        const catTotal = cat.total_amount !== undefined ? cat.total_amount : (cat.totalAmount || 0);
        const items = cat.items || [];
        const isMulti = items.length > 1;

        if (isMulti) {
          payRowsHtml += `
            <tr style="background: #f8fafc; font-weight: 700; border-top: 1px solid #cbd5e1; border-bottom: 1px solid #e2e8f0;">
              <td style="padding: 8px 10px; color: #1e293b;">${catIdx + 1}</td>
              <td colspan="2" style="padding: 8px 10px; color: #004ac6;">
                <strong>${escapeHtml(catName)}</strong>
                <span style="font-size: 0.75rem; color: #64748b; font-weight: 500; margin-left: 6px;">(${items.length} collections)</span>
              </td>
              <td style="padding: 8px 10px; text-align: right; color: #16a34a; font-weight: 700;">
                Subtotal: ${formatCurrency(catTotal)}
              </td>
            </tr>
          `;
          items.forEach((item, itemIdx) => {
            const studentName = item.student_name || item.studentName || 'Student';
            const rollNo = item.roll_no || item.roll;
            const className = item.class_name || item.className;
            const receiptNo = item.receipt_no || item.receiptNo;
            const method = item.payment_method || item.method || 'Cash';
            const monthStr = item.fee_month || item.month || '';

            payRowsHtml += `
              <tr style="border-bottom: 1px solid #f1f5f9; font-size: 0.8rem;">
                <td style="padding: 5px 10px 5px 25px; color: #64748b;">${catIdx + 1}.${itemIdx + 1}</td>
                <td style="padding: 5px 10px; color: #334155;">
                  <strong>${escapeHtml(studentName)}</strong>
                  ${rollNo ? `<span style="color: #64748b; font-size: 0.75rem; margin-left: 4px;">(#${escapeHtml(rollNo)})</span>` : ''}
                  ${className ? `<span style="color: #64748b; font-size: 0.75rem; margin-left: 4px;">— ${escapeHtml(className)}</span>` : ''}
                  ${receiptNo ? `<div style="font-size: 0.7rem; color: #94a3b8;">Receipt: ${escapeHtml(receiptNo)} (${escapeHtml(method)})</div>` : ''}
                </td>
                <td style="padding: 5px 10px; color: #64748b;">${escapeHtml(monthStr)}</td>
                <td style="padding: 5px 10px; text-align: right; color: #16a34a; font-weight: 600;">
                  ${formatCurrency(item.amount)}
                </td>
              </tr>
            `;
          });
        } else {
          const item = items[0] || {};
          const studentName = item.student_name || item.studentName;
          const rollNo = item.roll_no || item.roll;
          const receiptNo = item.receipt_no || item.receiptNo;

          payRowsHtml += `
            <tr style="border-bottom: 1px solid #e2e8f0;">
              <td style="padding: 8px 10px; color: #64748b;">${catIdx + 1}</td>
              <td style="padding: 8px 10px; color: #1e293b; font-weight: 600;">
                ${escapeHtml(catName)}
                ${studentName ? `<div style="font-size: 0.75rem; color: #64748b; font-weight: 400;">Student: ${escapeHtml(studentName)} (#${escapeHtml(rollNo || '')})</div>` : ''}
              </td>
              <td style="padding: 8px 10px; color: #64748b; font-size: 0.8rem;">
                ${escapeHtml(receiptNo || '')}
              </td>
              <td style="padding: 8px 10px; text-align: right; font-weight: 700; color: #16a34a;">
                ${formatCurrency(catTotal)}
              </td>
            </tr>
          `;
        }
      });
    }

    bodyContentHtml += `
      <div style="margin-bottom: 1.5rem;">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.5rem;">
          <h4 style="margin: 0; font-size: 0.95rem; font-weight: 700; color: #1e293b; display: flex; align-items: center; gap: 0.35rem;">
            <span class="material-symbols-outlined" style="color: #16a34a; font-size: 1.1rem;">payments</span>
            Fee Collections (Income)
          </h4>
          <span style="font-size: 0.8rem; font-weight: 600; color: #16a34a; background: #dcfce7; padding: 2px 8px; border-radius: 9999px;">
            Total: ${formatCurrency(payTotal)}
          </span>
        </div>

        <table style="width: 100%; border-collapse: collapse; font-size: 0.83rem; border: 1px solid #cbd5e1;">
          <thead>
            <tr style="background: #f1f5f9; border-bottom: 2px solid #cbd5e1; text-align: left;">
              <th style="padding: 8px 10px; width: 40px; color: #475569;">#</th>
              <th style="padding: 8px 10px; color: #475569;">Fee Category & Student</th>
              <th style="padding: 8px 10px; width: 110px; color: #475569;">Billing Month</th>
              <th style="padding: 8px 10px; text-align: right; width: 130px; color: #475569;">Amount</th>
            </tr>
          </thead>
          <tbody>
            ${payRowsHtml}
          </tbody>
          <tfoot>
            <tr style="background: #f8fafc; border-top: 2px solid #cbd5e1; font-weight: 700;">
              <td colspan="3" style="padding: 10px; text-align: right; color: #1e293b; font-size: 0.9rem;">
                Total Fee Collections for ${formattedDate}:
              </td>
              <td style="padding: 10px; text-align: right; color: #16a34a; font-size: 1rem;">
                ${formatCurrency(payTotal)}
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
    `;
  }

  // Grand Total Summary Block
  let grandTotalNumber = 0;
  let grandTotalLabel = 'GRAND TOTAL';
  let grandTotalColor = '#1e293b';

  const expTotalVal = (payload.expenses && payload.expenses.total !== undefined) ? payload.expenses.total : (payload.totalExpenses || 0);
  const payTotalVal = (payload.payments && payload.payments.total !== undefined) ? payload.payments.total : (payload.totalPayments || 0);

  if (type === 'expenses') {
    grandTotalNumber = expTotalVal;
    grandTotalLabel = 'GRAND TOTAL EXPENSES';
    grandTotalColor = '#dc2626';
  } else if (type === 'payments') {
    grandTotalNumber = payTotalVal;
    grandTotalLabel = 'GRAND TOTAL COLLECTIONS';
    grandTotalColor = '#16a34a';
  } else {
    grandTotalNumber = payload.netBalance !== undefined ? payload.netBalance : (payTotalVal - expTotalVal);
    grandTotalLabel = 'DAILY NET BALANCE (COLLECTIONS - EXPENSES)';
    grandTotalColor = grandTotalNumber >= 0 ? '#16a34a' : '#dc2626';
  }

  container.innerHTML = `
    <div style="border: 2px solid #cbd5e1; padding: 1.5rem; border-radius: 8px; background: #ffffff; color: #1e293b; font-family: inherit;">
      <!-- Voucher Top Header -->
      <div style="text-align: center; border-bottom: 2px solid #004ac6; padding-bottom: 0.85rem; margin-bottom: 1.25rem;">
        <h2 style="color: #004ac6; font-size: 1.35rem; font-weight: 800; margin: 0; letter-spacing: 0.5px;">COACHING CENTER MANAGEMENT</h2>
        <p style="font-size: 0.8rem; color: #64748b; margin: 3px 0 0 0;">Admission & Academic Care • Institutional Accounts Ledger</p>
        <div style="margin-top: 6px;">
          <span style="display: inline-block; background: #004ac6; color: #ffffff; font-size: 0.75rem; font-weight: 700; padding: 3px 12px; border-radius: 9999px; letter-spacing: 0.5px;">
            ${voucherTitle}
          </span>
        </div>
      </div>

      <!-- Voucher Metadata Row -->
      <div style="display: flex; justify-content: space-between; align-items: center; background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 6px; padding: 0.6rem 1rem; margin-bottom: 1.25rem; font-size: 0.83rem;">
        <div>
          <span style="color: #64748b;">Selected Date:</span>
          <strong style="color: #0f172a; margin-left: 4px; font-size: 0.9rem;">${formattedDate}</strong>
        </div>
        <div>
          <span style="color: #64748b;">Scope:</span>
          <strong style="color: #004ac6; margin-left: 4px; text-transform: uppercase;">${escapeHtml(type)}</strong>
        </div>
        <div>
          <span style="color: #64748b;">Generated:</span>
          <span style="color: #334155; margin-left: 4px;">${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
        </div>
      </div>

      <!-- Categories & Items Table(s) -->
      ${bodyContentHtml}

      <!-- Dynamic Grand Total Section -->
      <div style="background: #f8fafc; border: 2px solid #cbd5e1; border-radius: 8px; padding: 0.85rem 1.25rem; display: flex; justify-content: space-between; align-items: center; margin-top: 1.5rem; margin-bottom: 2rem;">
        <span style="font-weight: 800; font-size: 0.95rem; color: #1e293b; letter-spacing: 0.5px;">${grandTotalLabel}:</span>
        <span style="font-weight: 800; font-size: 1.35rem; color: ${grandTotalColor};">
          ${formatCurrency(grandTotalNumber)}
        </span>
      </div>

      <!-- Official Signature Section -->
      <div style="display: flex; justify-content: space-between; margin-top: 3rem; font-size: 0.75rem; color: #64748b; padding-top: 1rem; border-top: 1px dashed #cbd5e1;">
        <div style="text-align: center; width: 140px;">
          <div style="border-bottom: 1px solid #94a3b8; height: 35px;"></div>
          <div style="margin-top: 5px; font-weight: 500;">Prepared By</div>
        </div>
        <div style="text-align: center; width: 140px;">
          <div style="border-bottom: 1px solid #94a3b8; height: 35px;"></div>
          <div style="margin-top: 5px; font-weight: 500;">Accountant / Auditor</div>
        </div>
        <div style="text-align: center; width: 150px;">
          <div style="border-bottom: 1px solid #94a3b8; height: 35px;"></div>
          <div style="margin-top: 5px; font-weight: 600; color: #004ac6;">Authorized Signature</div>
        </div>
      </div>
    </div>
  `;
}

// -------------------------------------------------------------
// Monthly Voucher Modal & Printing
// -------------------------------------------------------------
async function openMonthlyVoucherModal(defaultType) {
  // Payments use their own completely separate modal & logic (see PAYMENT VOUCHERS section below)
  const voucherContext = resolveVoucherContext(defaultType);
  if (voucherContext === 'payments') {
    return openPaymentMonthlyVoucherModal();
  }
  defaultType = voucherContext;

  let modal = document.getElementById('modal-monthly-voucher');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'modal-monthly-voucher';
    modal.className = 'modal-overlay';
    modal.innerHTML = `
      <div class="modal-dialog" style="max-width: 860px; width: 96%;">
        <div class="modal-header">
          <h3 class="modal-title" style="display: flex; align-items: center; gap: 0.5rem;">
            <span class="material-symbols-outlined" style="color: #004ac6;">calendar_month</span>
            Monthly Voucher — Print Entire Month
          </h3>
          <button class="modal-close" onclick="closeModal('modal-monthly-voucher')">&times;</button>
        </div>

        <!-- Controls Bar (Hidden during window.print()) -->
        <div class="voucher-controls-bar" style="background: #f8fafc; padding: 0.85rem 1.25rem; border-bottom: 1px solid #e2e8f0; display: flex; align-items: center; justify-content: space-between; gap: 0.75rem; flex-wrap: wrap;">
          <div style="display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap;">
            <label style="font-size: 0.85rem; font-weight: 600; color: #475569; display: flex; align-items: center; gap: 0.25rem;">
              Year:
              <select id="monthly-voucher-year" class="form-control" style="padding: 0.35rem 0.6rem; font-size: 0.85rem; border: 1px solid #cbd5e1; border-radius: 6px;" onchange="fetchAndRenderMonthlyVoucher()">
                <!-- Populated dynamically -->
              </select>
            </label>
            <label style="font-size: 0.85rem; font-weight: 600; color: #475569; display: flex; align-items: center; gap: 0.25rem;">
              Month:
              <select id="monthly-voucher-month" class="form-control" style="padding: 0.35rem 0.6rem; font-size: 0.85rem; border: 1px solid #cbd5e1; border-radius: 6px;" onchange="fetchAndRenderMonthlyVoucher()">
                <option value="1">January (01)</option>
                <option value="2">February (02)</option>
                <option value="3">March (03)</option>
                <option value="4">April (04)</option>
                <option value="5">May (05)</option>
                <option value="6">June (06)</option>
                <option value="7">July (07)</option>
                <option value="8">August (08)</option>
                <option value="9">September (09)</option>
                <option value="10">October (10)</option>
                <option value="11">November (11)</option>
                <option value="12">December (12)</option>
              </select>
            </label>
            <label style="font-size: 0.85rem; font-weight: 600; color: #475569; display: flex; align-items: center; gap: 0.25rem;">
              Voucher Type:
              <select id="monthly-voucher-type" class="form-control" style="padding: 0.35rem 0.6rem; font-size: 0.85rem; border: 1px solid #cbd5e1; border-radius: 6px;" onchange="fetchAndRenderMonthlyVoucher()">
                <option value="expenses">Expenses Outflow</option>
              </select>
            </label>
          </div>
          <div>
            <button class="btn btn-secondary btn-sm" onclick="fetchAndRenderMonthlyVoucher()" style="display: inline-flex; align-items: center; gap: 0.25rem;">
              <span class="material-symbols-outlined" style="font-size: 1rem;">refresh</span> Reload
            </button>
          </div>
        </div>

        <div class="modal-body" id="monthly-voucher-printable-content" style="max-height: 70vh; overflow-y: auto; padding: 1.25rem;">
          <div style="text-align: center; padding: 2rem; color: #64748b;">Loading monthly voucher data...</div>
        </div>

        <div class="modal-footer" style="display: flex; justify-content: space-between; align-items: center;">
          <button class="btn btn-secondary" onclick="closeModal('modal-monthly-voucher')">Close</button>
          <button class="btn btn-primary" onclick="printVoucherContent('monthly-voucher-printable-content', 'Monthly Voucher')">
            <span class="material-symbols-outlined" style="font-size: 1.1rem;">print</span>
            Print Monthly Voucher
          </button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);
  }

  // Populate dynamic years from system
  await populateMonthlyVoucherYears();

  // Set default month to current month
  const monthSelect = document.getElementById('monthly-voucher-month');
  if (monthSelect && !monthSelect.value) {
    monthSelect.value = String(new Date().getMonth() + 1);
  }

  // Force voucher type dropdown to defaultType ('payments' on payment page, 'expenses' on expense page)
  const typeSelect = document.getElementById('monthly-voucher-type');
  if (typeSelect && defaultType) {
    typeSelect.value = defaultType;
  }

  openModal('modal-monthly-voucher');
  fetchAndRenderMonthlyVoucher();
}

async function populateMonthlyVoucherYears(selectId = 'monthly-voucher-year') {
  const yearSelect = document.getElementById(selectId);
  if (!yearSelect) return;

  const currentYear = new Date().getFullYear();
  let years = new Set([currentYear]);

  try {
    // FIX: use authFetch so the login token is sent (was raw fetch -> 401 Unauthorized)
    const res = await authFetch('/abms/api/academic-years');
    if (res.ok) {
      const ayData = await res.json();
      const ayList = Array.isArray(ayData) ? ayData : (ayData && Array.isArray(ayData.data) ? ayData.data : []);
      ayList.forEach(item => {
        const yNum = parseInt(item.year || item.name || item);
        if (!isNaN(yNum) && yNum > 2000 && yNum < 2100) {
          years.add(yNum);
        }
      });
    }
  } catch (e) {
    console.warn('Could not fetch academic years for monthly voucher:', e);
  }

  // Also include 2 previous years and next year for convenience
  years.add(currentYear - 1);
  years.add(currentYear - 2);
  years.add(currentYear + 1);

  const sortedYears = Array.from(years).sort((a, b) => b - a);
  const prevVal = yearSelect.value;
  yearSelect.innerHTML = sortedYears.map(y => `<option value="${y}">${y}</option>`).join('');

  if (prevVal && sortedYears.includes(parseInt(prevVal))) {
    yearSelect.value = prevVal;
  } else {
    // Select active academic year if available
    yearSelect.value = currentYear;
  }
}

async function fetchAndRenderMonthlyVoucher() {
  const container = document.getElementById('monthly-voucher-printable-content');
  if (!container) return;

  const yearSelect = document.getElementById('monthly-voucher-year');
  const monthSelect = document.getElementById('monthly-voucher-month');
  const typeSelect = document.getElementById('monthly-voucher-type');

  const year = yearSelect ? parseInt(yearSelect.value) : new Date().getFullYear();
  const month = monthSelect ? parseInt(monthSelect.value) : (new Date().getMonth() + 1);
  const type = typeSelect ? typeSelect.value : 'expenses';

  container.innerHTML = `
    <div style="text-align: center; padding: 2rem; color: #64748b;">
      <span class="material-symbols-outlined" style="font-size: 2rem; animation: spin 1s linear infinite; display: inline-block;">autorenew</span>
      <div style="margin-top: 0.5rem;">Generating monthly voucher for ${month}/${year}...</div>
    </div>
  `;

  try {
    // FIX: use authFetch so the login token is sent (was raw fetch -> 401 Unauthorized)
    const res = await authFetch(`/abms/api/vouchers/monthly?year=${year}&month=${month}&type=${encodeURIComponent(type)}`);
    if (!res.ok) {
      let msg = res.statusText;
      try { msg = (await res.json()).error || msg; } catch (e) { }
      throw new Error(`Failed to load monthly voucher: ${msg}`);
    }
    const data = await res.json();
    renderMonthlyVoucherHtml(container, data);
  } catch (err) {
    console.error('Error fetching monthly voucher:', err);
    container.innerHTML = `
      <div style="text-align: center; padding: 2rem; color: #dc2626;">
        <p><strong>Failed to load monthly voucher data.</strong></p>
        <p style="font-size: 0.85rem; color: #64748b; margin-top: 0.5rem;">${escapeHtml(err.message)}</p>
        <button class="btn btn-secondary btn-sm" onclick="fetchAndRenderMonthlyVoucher()" style="margin-top: 1rem;">Retry</button>
      </div>
    `;
  }
}

function renderMonthlyVoucherHtml(container, data) {
  const payload = (data && data.data) ? data.data : (data || {});
  const year = payload.year;
  const month = payload.month;
  const monthName = payload.monthName || `Month ${month}`;
  const totalDays = payload.totalDays;
  const type = payload.type || 'expenses';
  const calendarDays = payload.days || payload.calendarDays || [];
  const totalExpenses = payload.totalExpense !== undefined ? payload.totalExpense : (payload.totalExpenses || 0);
  const totalPayments = payload.totalPayment !== undefined ? payload.totalPayment : (payload.totalPayments || 0);
  const netBalance = payload.netBalance !== undefined ? payload.netBalance : (totalPayments - totalExpenses);

  let voucherTitle = 'MONTHLY FINANCIAL STATEMENT VOUCHER';
  if (type === 'expenses') voucherTitle = 'MONTHLY EXPENSE LEDGER VOUCHER';
  else if (type === 'payments') voucherTitle = 'MONTHLY FEE COLLECTION VOUCHER';

  // Build rows for every calendar day
  let rowsHtml = '';
  calendarDays.forEach(day => {
    const dNum = String(day.day).padStart(2, '0');
    const dayOfWeek = day.dayOfWeek || '';
    const dateFormatted = `${dNum} ${monthName.substring(0, 3)} (${dayOfWeek})`;

    if (type === 'expenses') {
      const expAmt = day.expenseAmount || 0;
      const categoriesSummary = day.expenseCategories && day.expenseCategories.length > 0
        ? day.expenseCategories.join(', ')
        : (expAmt > 0 ? 'Logged expenses' : '—');
      const isZero = expAmt === 0;

      rowsHtml += `
        <tr style="border-bottom: 1px solid #e2e8f0; ${isZero ? 'opacity: 0.65;' : 'font-weight: 500;'}">
          <td style="padding: 6px 10px; font-weight: 600; color: #334155; white-space: nowrap;">${dateFormatted}</td>
          <td style="padding: 6px 10px; color: ${isZero ? '#94a3b8' : '#1e293b'}; font-size: 0.8rem;">
            ${escapeHtml(categoriesSummary)}
          </td>
          <td style="padding: 6px 10px; text-align: center; color: #64748b; font-size: 0.8rem;">
            ${day.expenseCount > 0 ? `${day.expenseCount} voucher(s)` : '—'}
          </td>
          <td style="padding: 6px 10px; text-align: right; color: ${isZero ? '#94a3b8' : '#dc2626'}; font-weight: ${isZero ? '400' : '700'};">
            ${isZero ? '—' : formatCurrency(expAmt)}
          </td>
        </tr>
      `;
    } else if (type === 'payments') {
      const payAmt = day.paymentAmount || 0;
      const isZero = payAmt === 0;

      rowsHtml += `
        <tr style="border-bottom: 1px solid #e2e8f0; ${isZero ? 'opacity: 0.65;' : 'font-weight: 500;'}">
          <td style="padding: 6px 10px; font-weight: 600; color: #334155; white-space: nowrap;">${dateFormatted}</td>
          <td style="padding: 6px 10px; color: ${isZero ? '#94a3b8' : '#1e293b'}; font-size: 0.8rem;">
            ${day.paymentCount > 0 ? `${day.paymentCount} fee receipt(s) collected` : '—'}
          </td>
          <td style="padding: 6px 10px; text-align: center; color: #64748b; font-size: 0.8rem;">
            ${day.paymentCount > 0 ? `${day.paymentCount}` : '—'}
          </td>
          <td style="padding: 6px 10px; text-align: right; color: ${isZero ? '#94a3b8' : '#16a34a'}; font-weight: ${isZero ? '400' : '700'};">
            ${isZero ? '—' : formatCurrency(payAmt)}
          </td>
        </tr>
      `;
    } else {
      // type === 'all'
      const payAmt = day.paymentAmount || 0;
      const expAmt = day.expenseAmount || 0;
      const net = day.netAmount || 0;
      const isZero = payAmt === 0 && expAmt === 0;

      rowsHtml += `
        <tr style="border-bottom: 1px solid #e2e8f0; ${isZero ? 'opacity: 0.65;' : 'font-weight: 500;'}">
          <td style="padding: 6px 10px; font-weight: 600; color: #334155; white-space: nowrap;">${dateFormatted}</td>
          <td style="padding: 6px 10px; text-align: right; color: ${payAmt > 0 ? '#16a34a' : '#94a3b8'}; font-weight: ${payAmt > 0 ? '600' : '400'};">
            ${payAmt > 0 ? formatCurrency(payAmt) : '—'}
          </td>
          <td style="padding: 6px 10px; text-align: right; color: ${expAmt > 0 ? '#dc2626' : '#94a3b8'}; font-weight: ${expAmt > 0 ? '600' : '400'};">
            ${expAmt > 0 ? formatCurrency(expAmt) : '—'}
          </td>
          <td style="padding: 6px 10px; text-align: right; color: ${net >= 0 ? '#16a34a' : '#dc2626'}; font-weight: 700;">
            ${isZero ? '—' : formatCurrency(net)}
          </td>
        </tr>
      `;
    }
  });

  // Table header & footer columns
  let tableHeaderCols = '';
  let tableFooterCols = '';
  let grandTotalRow = '';

  const daysWithExpenses = payload.daysWithExpenses || 0;
  const daysWithPayments = payload.daysWithPayments || 0;

  if (type === 'expenses') {
    tableHeaderCols = `
      <th style="padding: 8px 10px; width: 140px; color: #475569;">Calendar Date</th>
      <th style="padding: 8px 10px; color: #475569;">Expense Categories</th>
      <th style="padding: 8px 10px; width: 110px; text-align: center; color: #475569;">Vouchers</th>
      <th style="padding: 8px 10px; width: 140px; text-align: right; color: #475569;">Amount Outflow</th>
    `;
    tableFooterCols = `
      <tr style="background: #f8fafc; border-top: 2px solid #cbd5e1; font-weight: 700;">
        <td style="padding: 10px; color: #1e293b;">${totalDays} Days</td>
        <td style="padding: 10px; color: #64748b; font-size: 0.8rem;">Month of ${monthName} ${year} (${daysWithExpenses} active expense days)</td>
        <td style="padding: 10px; text-align: center; color: #1e293b;">${payload.totalExpenseCount !== undefined ? payload.totalExpenseCount : daysWithExpenses}</td>
        <td style="padding: 10px; text-align: right; color: #dc2626; font-size: 1.05rem;">
          ${formatCurrency(totalExpenses)}
        </td>
      </tr>
    `;
    grandTotalRow = `
      <div style="background: #f8fafc; border: 2px solid #cbd5e1; border-radius: 8px; padding: 0.85rem 1.25rem; display: flex; justify-content: space-between; align-items: center; margin-top: 1.5rem; margin-bottom: 2rem;">
        <span style="font-weight: 800; font-size: 0.95rem; color: #1e293b;">GRAND TOTAL EXPENSES (${monthName.toUpperCase()} ${year}):</span>
        <span style="font-weight: 800; font-size: 1.35rem; color: #dc2626;">
          ${formatCurrency(totalExpenses)}
        </span>
      </div>
    `;
  } else if (type === 'payments') {
    tableHeaderCols = `
      <th style="padding: 8px 10px; width: 140px; color: #475569;">Calendar Date</th>
      <th style="padding: 8px 10px; color: #475569;">Collection Summary</th>
      <th style="padding: 8px 10px; width: 110px; text-align: center; color: #475569;">Receipts</th>
      <th style="padding: 8px 10px; width: 140px; text-align: right; color: #475569;">Amount Inflow</th>
    `;
    tableFooterCols = `
      <tr style="background: #f8fafc; border-top: 2px solid #cbd5e1; font-weight: 700;">
        <td style="padding: 10px; color: #1e293b;">${totalDays} Days</td>
        <td style="padding: 10px; color: #64748b; font-size: 0.8rem;">Month of ${monthName} ${year} (${daysWithPayments} collection days)</td>
        <td style="padding: 10px; text-align: center; color: #1e293b;">${payload.totalPaymentCount !== undefined ? payload.totalPaymentCount : daysWithPayments}</td>
        <td style="padding: 10px; text-align: right; color: #16a34a; font-size: 1.05rem;">
          ${formatCurrency(totalPayments)}
        </td>
      </tr>
    `;
    grandTotalRow = `
      <div style="background: #f8fafc; border: 2px solid #cbd5e1; border-radius: 8px; padding: 0.85rem 1.25rem; display: flex; justify-content: space-between; align-items: center; margin-top: 1.5rem; margin-bottom: 2rem;">
        <span style="font-weight: 800; font-size: 0.95rem; color: #1e293b;">GRAND TOTAL COLLECTIONS (${monthName.toUpperCase()} ${year}):</span>
        <span style="font-weight: 800; font-size: 1.35rem; color: #16a34a;">
          ${formatCurrency(totalPayments)}
        </span>
      </div>
    `;
  } else {
    // all
    tableHeaderCols = `
      <th style="padding: 8px 10px; width: 140px; color: #475569;">Calendar Date</th>
      <th style="padding: 8px 10px; text-align: right; color: #475569;">Fee Collections (৳)</th>
      <th style="padding: 8px 10px; text-align: right; color: #475569;">Expenses Outflow (৳)</th>
      <th style="padding: 8px 10px; width: 140px; text-align: right; color: #475569;">Daily Net (৳)</th>
    `;
    tableFooterCols = `
      <tr style="background: #f8fafc; border-top: 2px solid #cbd5e1; font-weight: 700;">
        <td style="padding: 10px; color: #1e293b;">${totalDays} Days Total</td>
        <td style="padding: 10px; text-align: right; color: #16a34a; font-size: 1rem;">
          ${formatCurrency(totalPayments)}
        </td>
        <td style="padding: 10px; text-align: right; color: #dc2626; font-size: 1rem;">
          ${formatCurrency(totalExpenses)}
        </td>
        <td style="padding: 10px; text-align: right; color: ${netBalance >= 0 ? '#16a34a' : '#dc2626'}; font-size: 1.05rem;">
          ${formatCurrency(netBalance)}
        </td>
      </tr>
    `;
    grandTotalRow = `
      <div style="background: #f8fafc; border: 2px solid #cbd5e1; border-radius: 8px; padding: 0.85rem 1.25rem; display: flex; justify-content: space-between; align-items: center; margin-top: 1.5rem; margin-bottom: 2rem;">
        <span style="font-weight: 800; font-size: 0.95rem; color: #1e293b;">NET MONTHLY BALANCE (${monthName.toUpperCase()} ${year}):</span>
        <span style="font-weight: 800; font-size: 1.35rem; color: ${netBalance >= 0 ? '#16a34a' : '#dc2626'};">
          ${formatCurrency(netBalance)}
        </span>
      </div>
    `;
  }

  container.innerHTML = `
    <div style="border: 2px solid #cbd5e1; padding: 1.5rem; border-radius: 8px; background: #ffffff; color: #1e293b; font-family: inherit;">
      <!-- Monthly Top Header -->
      <div style="text-align: center; border-bottom: 2px solid #004ac6; padding-bottom: 0.85rem; margin-bottom: 1.25rem;">
        <h2 style="color: #004ac6; font-size: 1.35rem; font-weight: 800; margin: 0; letter-spacing: 0.5px;">COACHING CENTER MANAGEMENT</h2>
        <p style="font-size: 0.8rem; color: #64748b; margin: 3px 0 0 0;">Admission & Academic Care • Institutional Accounts Ledger</p>
        <div style="margin-top: 6px;">
          <span style="display: inline-block; background: #004ac6; color: #ffffff; font-size: 0.75rem; font-weight: 700; padding: 3px 12px; border-radius: 9999px; letter-spacing: 0.5px;">
            ${voucherTitle}
          </span>
        </div>
      </div>

      <!-- Monthly Metadata Row -->
      <div style="display: flex; justify-content: space-between; align-items: center; background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 6px; padding: 0.6rem 1rem; margin-bottom: 1.25rem; font-size: 0.83rem; flex-wrap: wrap; gap: 0.5rem;">
        <div>
          <span style="color: #64748b;">Month / Year:</span>
          <strong style="color: #0f172a; margin-left: 4px; font-size: 0.95rem;">${monthName} ${year}</strong>
        </div>
        <div>
          <span style="color: #64748b;">Calendar Days:</span>
          <strong style="color: #004ac6; margin-left: 4px;">${totalDays} Days</strong>
        </div>
        <div>
          <span style="color: #64748b;">Generated:</span>
          <span style="color: #334155; margin-left: 4px;">${new Date().toLocaleDateString()} ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
        </div>
      </div>

      <!-- Complete Month Calendar Ledger Table -->
      <table style="width: 100%; border-collapse: collapse; font-size: 0.82rem; border: 1px solid #cbd5e1; margin-bottom: 1rem;">
        <thead>
          <tr style="background: #f1f5f9; border-bottom: 2px solid #cbd5e1; text-align: left;">
            ${tableHeaderCols}
          </tr>
        </thead>
        <tbody>
          ${rowsHtml}
        </tbody>
        <tfoot>
          ${tableFooterCols}
        </tfoot>
      </table>

      <!-- Dynamic Grand Total Section -->
      ${grandTotalRow}

      <!-- Official Signatures Block -->
      <div style="display: flex; justify-content: space-between; margin-top: 3rem; font-size: 0.75rem; color: #64748b; padding-top: 1rem; border-top: 1px dashed #cbd5e1;">
        <div style="text-align: center; width: 140px;">
          <div style="border-bottom: 1px solid #94a3b8; height: 35px;"></div>
          <div style="margin-top: 5px; font-weight: 500;">Prepared By</div>
        </div>
        <div style="text-align: center; width: 140px;">
          <div style="border-bottom: 1px solid #94a3b8; height: 35px;"></div>
          <div style="margin-top: 5px; font-weight: 500;">Accountant / Auditor</div>
        </div>
        <div style="text-align: center; width: 150px;">
          <div style="border-bottom: 1px solid #94a3b8; height: 35px;"></div>
          <div style="margin-top: 5px; font-weight: 600; color: #004ac6;">Authorized Signature</div>
        </div>
      </div>
    </div>
  `;
}

// -------------------------------------------------------------
// Voucher context resolver
// Explicit 'payments' / 'expenses' / 'all' always wins. If the caller passes nothing,
// decide from the page the user is on (payment page => payments, otherwise expenses).
// -------------------------------------------------------------
function resolveVoucherContext(defaultType) {
  if (defaultType === 'payments' || defaultType === 'expenses' || defaultType === 'all') {
    return defaultType;
  }
  const path = (window.location.pathname || '').toLowerCase();
  if (/payment|fee|collection/.test(path)) return 'payments';
  return 'expenses';
}

// -------------------------------------------------------------
// Exact-view printing
// Prints ONLY the voucher, exactly as it looks inside the modal (same styles, colors, fonts),
// with no height limit, so a long voucher simply continues onto as many pages as it needs.
// -------------------------------------------------------------
function printVoucherContent(sourceId, docTitle = 'Voucher') {
  const source = document.getElementById(sourceId);
  if (!source || !source.innerHTML.trim()) {
    showToast('Nothing to print yet.', 'error');
    return;
  }

  // Remove any previous print frame
  const oldFrame = document.getElementById('voucher-print-frame');
  if (oldFrame) oldFrame.remove();

  const frame = document.createElement('iframe');
  frame.id = 'voucher-print-frame';
  frame.setAttribute('aria-hidden', 'true');
  frame.style.cssText = 'position:fixed; left:-10000px; top:0; width:820px; height:1000px; border:0; visibility:hidden;';
  document.body.appendChild(frame);

  // Reuse the page's own stylesheets so the printout looks identical to the on-screen voucher
  const headStyles = Array.from(document.querySelectorAll('link[rel="stylesheet"], style'))
    .filter(node => !(node.tagName === 'LINK' && node.media === 'print'))
    .map(node => node.tagName === 'LINK'
      ? `<link rel="stylesheet" href="${node.href}">`
      : node.outerHTML)
    .join('\n');

  const printHtml = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>${escapeHtml(docTitle)}</title>
  <base href="${document.baseURI}">
  ${headStyles}
  <style>
    @page { size: A4; margin: 12mm; }
    html, body {
      display: block !important;
      visibility: visible !important;
      margin: 0 !important;
      padding: 0 !important;
      height: auto !important;
      min-height: 0 !important;
      overflow: visible !important;
      background: #ffffff !important;
    }
    body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    #voucher-print-root, #voucher-print-root * { visibility: visible !important; }
    #voucher-print-root {
      display: block !important;
      position: static !important;
      width: 100% !important;
      max-height: none !important;
      overflow: visible !important;
      padding: 0 !important;
      margin: 0 !important;
    }
    #voucher-print-root table { page-break-inside: auto; }
    #voucher-print-root thead { display: table-header-group; }
    #voucher-print-root tfoot { display: table-row-group; }
    #voucher-print-root tr { page-break-inside: avoid; break-inside: avoid; }
  </style>
</head>
<body>
  <div id="voucher-print-root">${source.innerHTML}</div>
</body>
</html>`;

  const frameWin = frame.contentWindow;
  const frameDoc = frameWin.document;
  frameDoc.open();
  frameDoc.write(printHtml);
  frameDoc.close();

  // Wait for stylesheets & fonts (max ~2.5s) so the printout matches the screen
  const linkPromises = Array.from(frameDoc.querySelectorAll('link[rel="stylesheet"]')).map(link =>
    new Promise(resolve => {
      if (link.sheet) return resolve();
      link.addEventListener('load', resolve);
      link.addEventListener('error', resolve);
    })
  );
  const timeout = ms => new Promise(resolve => setTimeout(resolve, ms));

  Promise.race([Promise.all(linkPromises), timeout(2500)])
    .then(() => (frameDoc.fonts && frameDoc.fonts.ready)
      ? Promise.race([frameDoc.fonts.ready, timeout(1500)])
      : null)
    .catch(() => { })
    .then(() => {
      frameWin.focus();
      frameWin.print();
    });
}

// =============================================================
// PAYMENT (FEE COLLECTION) VOUCHERS
// Completely separate modals, IDs, fetchers and renderers from the Expense vouchers,
// so opening a voucher from the Payment page always shows payments only.
// =============================================================

// ---------- Daily Payment Voucher ----------
async function openPaymentDailyVoucherModal() {
  let modal = document.getElementById('modal-payment-daily-voucher');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'modal-payment-daily-voucher';
    modal.className = 'modal-overlay';
    modal.innerHTML = `
      <div class="modal-dialog" style="max-width: 760px; width: 95%;">
        <div class="modal-header">
          <h3 class="modal-title" style="display: flex; align-items: center; gap: 0.5rem;">
            <span class="material-symbols-outlined" style="color: #16a34a;">payments</span>
            Daily Payment Voucher — Print by Any Date
          </h3>
          <button class="modal-close" onclick="closeModal('modal-payment-daily-voucher')">&times;</button>
        </div>

        <!-- Controls Bar -->
        <div class="voucher-controls-bar" style="background: #f8fafc; padding: 0.85rem 1.25rem; border-bottom: 1px solid #e2e8f0; display: flex; align-items: center; justify-content: space-between; gap: 0.75rem; flex-wrap: wrap;">
          <div style="display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap;">
            <label style="font-size: 0.85rem; font-weight: 600; color: #475569; display: flex; align-items: center; gap: 0.25rem;">
              Select Date:
              <input type="date" id="payment-daily-voucher-date" class="form-control" style="padding: 0.35rem 0.6rem; font-size: 0.85rem; border: 1px solid #cbd5e1; border-radius: 6px;" onchange="fetchAndRenderPaymentDailyVoucher()">
            </label>
            <span style="font-size: 0.8rem; font-weight: 700; color: #16a34a; background: #dcfce7; padding: 3px 10px; border-radius: 9999px;">Fee Collections</span>
          </div>
          <div>
            <button class="btn btn-secondary btn-sm" onclick="fetchAndRenderPaymentDailyVoucher()" style="display: inline-flex; align-items: center; gap: 0.25rem;">
              <span class="material-symbols-outlined" style="font-size: 1rem;">refresh</span> Reload
            </button>
          </div>
        </div>

        <div class="modal-body" id="payment-daily-voucher-printable-content" style="max-height: 70vh; overflow-y: auto; padding: 1.25rem;">
          <div style="text-align: center; padding: 2rem; color: #64748b;">Loading payment voucher data...</div>
        </div>

        <div class="modal-footer" style="display: flex; justify-content: space-between; align-items: center;">
          <button class="btn btn-secondary" onclick="closeModal('modal-payment-daily-voucher')">Close</button>
          <button class="btn btn-primary" onclick="printVoucherContent('payment-daily-voucher-printable-content', 'Daily Payment Voucher')">
            <span class="material-symbols-outlined" style="font-size: 1.1rem;">print</span>
            Print Payment Voucher
          </button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);
  }

  const dateInput = document.getElementById('payment-daily-voucher-date');
  if (dateInput && !dateInput.value) {
    dateInput.value = getLocalIsoDate();
  }

  openModal('modal-payment-daily-voucher');
  fetchAndRenderPaymentDailyVoucher();
}

async function fetchAndRenderPaymentDailyVoucher() {
  const container = document.getElementById('payment-daily-voucher-printable-content');
  if (!container) return;

  const dateInput = document.getElementById('payment-daily-voucher-date');
  const dateVal = dateInput ? dateInput.value : getLocalIsoDate();

  if (!dateVal) {
    container.innerHTML = `<div style="text-align: center; color: #dc2626; padding: 2rem;">Please select a valid date.</div>`;
    return;
  }

  container.innerHTML = `
    <div style="text-align: center; padding: 2rem; color: #64748b;">
      <span class="material-symbols-outlined" style="font-size: 2rem; animation: spin 1s linear infinite; display: inline-block;">autorenew</span>
      <div style="margin-top: 0.5rem;">Fetching fee collections for ${formatDate(dateVal)}...</div>
    </div>
  `;

  try {
    // Type is ALWAYS 'payments' here - cannot be switched to expenses
    // FIX: use authFetch so the login token is sent (was raw fetch -> 401 Unauthorized)
    const res = await authFetch(`/abms/api/vouchers/daily?date=${encodeURIComponent(dateVal)}&type=payments`);
    if (!res.ok) {
      let msg = res.statusText;
      try { msg = (await res.json()).error || msg; } catch (e) { }
      throw new Error(`Failed to load payment voucher: ${msg}`);
    }
    const data = await res.json();
    renderPaymentDailyVoucherHtml(container, data);
  } catch (err) {
    console.error('Error fetching daily payment voucher:', err);
    container.innerHTML = `
      <div style="text-align: center; padding: 2rem; color: #dc2626;">
        <p><strong>Failed to load daily payment voucher data.</strong></p>
        <p style="font-size: 0.85rem; color: #64748b; margin-top: 0.5rem;">${escapeHtml(err.message)}</p>
        <button class="btn btn-secondary btn-sm" onclick="fetchAndRenderPaymentDailyVoucher()" style="margin-top: 1rem;">Retry</button>
      </div>
    `;
  }
}

function renderPaymentDailyVoucherHtml(container, data) {
  const payload = (data && data.data) ? data.data : (data || {});
  const formattedDate = payload.formattedDate || formatDate(payload.date);
  const payCategories = (payload.payments && payload.payments.categories) || payload.paymentCategories || [];
  const payTotal = (payload.payments && payload.payments.total !== undefined)
    ? payload.payments.total
    : (payload.totalPayments || 0);

  let receiptCount = 0;
  payCategories.forEach(cat => { receiptCount += (cat.items || []).length; });

  let payRowsHtml = '';
  if (payCategories.length === 0) {
    payRowsHtml = `
      <tr>
        <td colspan="4" style="text-align: center; padding: 1.5rem; color: #94a3b8; font-style: italic;">
          No fee payments collected on this date.
        </td>
      </tr>
    `;
  } else {
    payCategories.forEach((cat, catIdx) => {
      const catName = cat.category_name || cat.categoryName || 'Fee Collection';
      const catTotal = cat.total_amount !== undefined ? cat.total_amount : (cat.totalAmount || 0);
      const items = cat.items || [];
      const isMulti = items.length > 1;

      if (isMulti) {
        payRowsHtml += `
          <tr style="background: #f8fafc; font-weight: 700; border-top: 1px solid #cbd5e1; border-bottom: 1px solid #e2e8f0;">
            <td style="padding: 8px 10px; color: #1e293b;">${catIdx + 1}</td>
            <td colspan="2" style="padding: 8px 10px; color: #004ac6;">
              <strong>${escapeHtml(catName)}</strong>
              <span style="font-size: 0.75rem; color: #64748b; font-weight: 500; margin-left: 6px;">(${items.length} collections)</span>
            </td>
            <td style="padding: 8px 10px; text-align: right; color: #16a34a; font-weight: 700;">
              Subtotal: ${formatCurrency(catTotal)}
            </td>
          </tr>
        `;
        items.forEach((item, itemIdx) => {
          const studentName = item.student_name || item.studentName || 'Student';
          const rollNo = item.roll_no || item.roll;
          const className = item.class_name || item.className;
          const receiptNo = item.receipt_no || item.receiptNo;
          const method = item.payment_method || item.method || 'Cash';
          const monthStr = item.fee_month || item.month || '';

          payRowsHtml += `
            <tr style="border-bottom: 1px solid #f1f5f9; font-size: 0.8rem;">
              <td style="padding: 5px 10px 5px 25px; color: #64748b;">${catIdx + 1}.${itemIdx + 1}</td>
              <td style="padding: 5px 10px; color: #334155;">
                <strong>${escapeHtml(studentName)}</strong>
                ${rollNo ? `<span style="color: #64748b; font-size: 0.75rem; margin-left: 4px;">(#${escapeHtml(rollNo)})</span>` : ''}
                ${className ? `<span style="color: #64748b; font-size: 0.75rem; margin-left: 4px;">— ${escapeHtml(className)}</span>` : ''}
                ${receiptNo ? `<div style="font-size: 0.7rem; color: #94a3b8;">Receipt: ${escapeHtml(receiptNo)} (${escapeHtml(method)})</div>` : ''}
              </td>
              <td style="padding: 5px 10px; color: #64748b;">${escapeHtml(monthStr)}</td>
              <td style="padding: 5px 10px; text-align: right; color: #16a34a; font-weight: 600;">
                ${formatCurrency(item.amount)}
              </td>
            </tr>
          `;
        });
      } else {
        const item = items[0] || {};
        const studentName = item.student_name || item.studentName;
        const rollNo = item.roll_no || item.roll;
        const receiptNo = item.receipt_no || item.receiptNo;

        payRowsHtml += `
          <tr style="border-bottom: 1px solid #e2e8f0;">
            <td style="padding: 8px 10px; color: #64748b;">${catIdx + 1}</td>
            <td style="padding: 8px 10px; color: #1e293b; font-weight: 600;">
              ${escapeHtml(catName)}
              ${studentName ? `<div style="font-size: 0.75rem; color: #64748b; font-weight: 400;">Student: ${escapeHtml(studentName)} (#${escapeHtml(rollNo || '')})</div>` : ''}
            </td>
            <td style="padding: 8px 10px; color: #64748b; font-size: 0.8rem;">
              ${escapeHtml(receiptNo || '')}
            </td>
            <td style="padding: 8px 10px; text-align: right; font-weight: 700; color: #16a34a;">
              ${formatCurrency(catTotal)}
            </td>
          </tr>
        `;
      }
    });
  }

  container.innerHTML = `
    <div style="border: 2px solid #cbd5e1; padding: 1.5rem; border-radius: 8px; background: #ffffff; color: #1e293b; font-family: inherit;">
      <!-- Voucher Top Header -->
      <div style="text-align: center; border-bottom: 2px solid #004ac6; padding-bottom: 0.85rem; margin-bottom: 1.25rem;">
        <h2 style="color: #004ac6; font-size: 1.35rem; font-weight: 800; margin: 0; letter-spacing: 0.5px;">COACHING CENTER MANAGEMENT</h2>
        <p style="font-size: 0.8rem; color: #64748b; margin: 3px 0 0 0;">Admission & Academic Care • Institutional Accounts Ledger</p>
        <div style="margin-top: 6px;">
          <span style="display: inline-block; background: #16a34a; color: #ffffff; font-size: 0.75rem; font-weight: 700; padding: 3px 12px; border-radius: 9999px; letter-spacing: 0.5px;">
            DAILY PAYMENT VOUCHER
          </span>
        </div>
      </div>

      <!-- Voucher Metadata Row -->
      <div style="display: flex; justify-content: space-between; align-items: center; background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 6px; padding: 0.6rem 1rem; margin-bottom: 1.25rem; font-size: 0.83rem;">
        <div>
          <span style="color: #64748b;">Selected Date:</span>
          <strong style="color: #0f172a; margin-left: 4px; font-size: 0.9rem;">${formattedDate}</strong>
        </div>
        <div>
          <span style="color: #64748b;">Receipts:</span>
          <strong style="color: #16a34a; margin-left: 4px;">${receiptCount}</strong>
        </div>
        <div>
          <span style="color: #64748b;">Generated:</span>
          <span style="color: #334155; margin-left: 4px;">${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
        </div>
      </div>

      <!-- Fee Collections Table -->
      <div style="margin-bottom: 1.5rem;">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.5rem;">
          <h4 style="margin: 0; font-size: 0.95rem; font-weight: 700; color: #1e293b; display: flex; align-items: center; gap: 0.35rem;">
            <span class="material-symbols-outlined" style="color: #16a34a; font-size: 1.1rem;">payments</span>
            Fee Collections (Income)
          </h4>
          <span style="font-size: 0.8rem; font-weight: 600; color: #16a34a; background: #dcfce7; padding: 2px 8px; border-radius: 9999px;">
            Total: ${formatCurrency(payTotal)}
          </span>
        </div>

        <table style="width: 100%; border-collapse: collapse; font-size: 0.83rem; border: 1px solid #cbd5e1;">
          <thead>
            <tr style="background: #f1f5f9; border-bottom: 2px solid #cbd5e1; text-align: left;">
              <th style="padding: 8px 10px; width: 40px; color: #475569;">#</th>
              <th style="padding: 8px 10px; color: #475569;">Fee Category & Student</th>
              <th style="padding: 8px 10px; width: 110px; color: #475569;">Billing Month</th>
              <th style="padding: 8px 10px; text-align: right; width: 130px; color: #475569;">Amount</th>
            </tr>
          </thead>
          <tbody>
            ${payRowsHtml}
          </tbody>
          <tfoot>
            <tr style="background: #f8fafc; border-top: 2px solid #cbd5e1; font-weight: 700;">
              <td colspan="3" style="padding: 10px; text-align: right; color: #1e293b; font-size: 0.9rem;">
                Total Fee Collections for ${formattedDate}:
              </td>
              <td style="padding: 10px; text-align: right; color: #16a34a; font-size: 1rem;">
                ${formatCurrency(payTotal)}
              </td>
            </tr>
          </tfoot>
        </table>
      </div>

      <!-- Grand Total Section -->
      <div style="background: #f8fafc; border: 2px solid #cbd5e1; border-radius: 8px; padding: 0.85rem 1.25rem; display: flex; justify-content: space-between; align-items: center; margin-top: 1.5rem; margin-bottom: 2rem;">
        <span style="font-weight: 800; font-size: 0.95rem; color: #1e293b; letter-spacing: 0.5px;">GRAND TOTAL COLLECTIONS:</span>
        <span style="font-weight: 800; font-size: 1.35rem; color: #16a34a;">
          ${formatCurrency(payTotal)}
        </span>
      </div>

      <!-- Official Signature Section -->
      <div style="display: flex; justify-content: space-between; margin-top: 3rem; font-size: 0.75rem; color: #64748b; padding-top: 1rem; border-top: 1px dashed #cbd5e1;">
        <div style="text-align: center; width: 140px;">
          <div style="border-bottom: 1px solid #94a3b8; height: 35px;"></div>
          <div style="margin-top: 5px; font-weight: 500;">Prepared By</div>
        </div>
        <div style="text-align: center; width: 140px;">
          <div style="border-bottom: 1px solid #94a3b8; height: 35px;"></div>
          <div style="margin-top: 5px; font-weight: 500;">Accountant / Auditor</div>
        </div>
        <div style="text-align: center; width: 150px;">
          <div style="border-bottom: 1px solid #94a3b8; height: 35px;"></div>
          <div style="margin-top: 5px; font-weight: 600; color: #004ac6;">Authorized Signature</div>
        </div>
      </div>
    </div>
  `;
}

// ---------- Monthly Payment Voucher ----------
async function openPaymentMonthlyVoucherModal() {
  let modal = document.getElementById('modal-payment-monthly-voucher');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'modal-payment-monthly-voucher';
    modal.className = 'modal-overlay';
    modal.innerHTML = `
      <div class="modal-dialog" style="max-width: 860px; width: 96%;">
        <div class="modal-header">
          <h3 class="modal-title" style="display: flex; align-items: center; gap: 0.5rem;">
            <span class="material-symbols-outlined" style="color: #16a34a;">calendar_month</span>
            Monthly Payment Voucher — Print Entire Month
          </h3>
          <button class="modal-close" onclick="closeModal('modal-payment-monthly-voucher')">&times;</button>
        </div>

        <!-- Controls Bar -->
        <div class="voucher-controls-bar" style="background: #f8fafc; padding: 0.85rem 1.25rem; border-bottom: 1px solid #e2e8f0; display: flex; align-items: center; justify-content: space-between; gap: 0.75rem; flex-wrap: wrap;">
          <div style="display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap;">
            <label style="font-size: 0.85rem; font-weight: 600; color: #475569; display: flex; align-items: center; gap: 0.25rem;">
              Year:
              <select id="payment-monthly-voucher-year" class="form-control" style="padding: 0.35rem 0.6rem; font-size: 0.85rem; border: 1px solid #cbd5e1; border-radius: 6px;" onchange="fetchAndRenderPaymentMonthlyVoucher()">
                <!-- Populated dynamically -->
              </select>
            </label>
            <label style="font-size: 0.85rem; font-weight: 600; color: #475569; display: flex; align-items: center; gap: 0.25rem;">
              Month:
              <select id="payment-monthly-voucher-month" class="form-control" style="padding: 0.35rem 0.6rem; font-size: 0.85rem; border: 1px solid #cbd5e1; border-radius: 6px;" onchange="fetchAndRenderPaymentMonthlyVoucher()">
                <option value="1">January (01)</option>
                <option value="2">February (02)</option>
                <option value="3">March (03)</option>
                <option value="4">April (04)</option>
                <option value="5">May (05)</option>
                <option value="6">June (06)</option>
                <option value="7">July (07)</option>
                <option value="8">August (08)</option>
                <option value="9">September (09)</option>
                <option value="10">October (10)</option>
                <option value="11">November (11)</option>
                <option value="12">December (12)</option>
              </select>
            </label>
            <span style="font-size: 0.8rem; font-weight: 700; color: #16a34a; background: #dcfce7; padding: 3px 10px; border-radius: 9999px;">Fee Collections</span>
          </div>
          <div>
            <button class="btn btn-secondary btn-sm" onclick="fetchAndRenderPaymentMonthlyVoucher()" style="display: inline-flex; align-items: center; gap: 0.25rem;">
              <span class="material-symbols-outlined" style="font-size: 1rem;">refresh</span> Reload
            </button>
          </div>
        </div>

        <div class="modal-body" id="payment-monthly-voucher-printable-content" style="max-height: 70vh; overflow-y: auto; padding: 1.25rem;">
          <div style="text-align: center; padding: 2rem; color: #64748b;">Loading monthly payment voucher data...</div>
        </div>

        <div class="modal-footer" style="display: flex; justify-content: space-between; align-items: center;">
          <button class="btn btn-secondary" onclick="closeModal('modal-payment-monthly-voucher')">Close</button>
          <button class="btn btn-primary" onclick="printVoucherContent('payment-monthly-voucher-printable-content', 'Monthly Payment Voucher')">
            <span class="material-symbols-outlined" style="font-size: 1.1rem;">print</span>
            Print Monthly Payment Voucher
          </button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);
  }

  await populateMonthlyVoucherYears('payment-monthly-voucher-year');

  const monthSelect = document.getElementById('payment-monthly-voucher-month');
  if (monthSelect && !monthSelect.dataset.initialized) {
    monthSelect.value = String(new Date().getMonth() + 1);
    monthSelect.dataset.initialized = '1';
  }

  openModal('modal-payment-monthly-voucher');
  fetchAndRenderPaymentMonthlyVoucher();
}

async function fetchAndRenderPaymentMonthlyVoucher() {
  const container = document.getElementById('payment-monthly-voucher-printable-content');
  if (!container) return;

  const yearSelect = document.getElementById('payment-monthly-voucher-year');
  const monthSelect = document.getElementById('payment-monthly-voucher-month');

  const year = yearSelect ? parseInt(yearSelect.value) : new Date().getFullYear();
  const month = monthSelect ? parseInt(monthSelect.value) : (new Date().getMonth() + 1);

  container.innerHTML = `
    <div style="text-align: center; padding: 2rem; color: #64748b;">
      <span class="material-symbols-outlined" style="font-size: 2rem; animation: spin 1s linear infinite; display: inline-block;">autorenew</span>
      <div style="margin-top: 0.5rem;">Generating monthly payment voucher for ${month}/${year}...</div>
    </div>
  `;

  try {
    // Type is ALWAYS 'payments' here - cannot be switched to expenses
    // FIX: use authFetch so the login token is sent (was raw fetch -> 401 Unauthorized)
    const res = await authFetch(`/abms/api/vouchers/monthly?year=${year}&month=${month}&type=payments`);
    if (!res.ok) {
      let msg = res.statusText;
      try { msg = (await res.json()).error || msg; } catch (e) { }
      throw new Error(`Failed to load monthly payment voucher: ${msg}`);
    }
    const data = await res.json();
    renderPaymentMonthlyVoucherHtml(container, data);
  } catch (err) {
    console.error('Error fetching monthly payment voucher:', err);
    container.innerHTML = `
      <div style="text-align: center; padding: 2rem; color: #dc2626;">
        <p><strong>Failed to load monthly payment voucher data.</strong></p>
        <p style="font-size: 0.85rem; color: #64748b; margin-top: 0.5rem;">${escapeHtml(err.message)}</p>
        <button class="btn btn-secondary btn-sm" onclick="fetchAndRenderPaymentMonthlyVoucher()" style="margin-top: 1rem;">Retry</button>
      </div>
    `;
  }
}

function renderPaymentMonthlyVoucherHtml(container, data) {
  const payload = (data && data.data) ? data.data : (data || {});
  const year = payload.year;
  const month = payload.month;
  const monthName = payload.monthName || `Month ${month}`;
  const totalDays = payload.totalDays;
  const calendarDays = payload.days || payload.calendarDays || [];
  const totalPayments = payload.totalPayment !== undefined ? payload.totalPayment : (payload.totalPayments || 0);
  const daysWithPayments = payload.daysWithPayments || 0;

  let rowsHtml = '';
  calendarDays.forEach(day => {
    const dNum = String(day.day).padStart(2, '0');
    const dayOfWeek = day.dayOfWeek || '';
    const dateFormatted = `${dNum} ${monthName.substring(0, 3)} (${dayOfWeek})`;
    const payAmt = day.paymentAmount || 0;
    const isZero = payAmt === 0;

    rowsHtml += `
      <tr style="border-bottom: 1px solid #e2e8f0; ${isZero ? 'opacity: 0.65;' : 'font-weight: 500;'}">
        <td style="padding: 6px 10px; font-weight: 600; color: #334155; white-space: nowrap;">${dateFormatted}</td>
        <td style="padding: 6px 10px; color: ${isZero ? '#94a3b8' : '#1e293b'}; font-size: 0.8rem;">
          ${day.paymentCount > 0 ? `${day.paymentCount} fee receipt(s) collected` : '—'}
        </td>
        <td style="padding: 6px 10px; text-align: center; color: #64748b; font-size: 0.8rem;">
          ${day.paymentCount > 0 ? `${day.paymentCount}` : '—'}
        </td>
        <td style="padding: 6px 10px; text-align: right; color: ${isZero ? '#94a3b8' : '#16a34a'}; font-weight: ${isZero ? '400' : '700'};">
          ${isZero ? '—' : formatCurrency(payAmt)}
        </td>
      </tr>
    `;
  });

  container.innerHTML = `
    <div style="border: 2px solid #cbd5e1; padding: 1.5rem; border-radius: 8px; background: #ffffff; color: #1e293b; font-family: inherit;">
      <!-- Monthly Top Header -->
      <div style="text-align: center; border-bottom: 2px solid #004ac6; padding-bottom: 0.85rem; margin-bottom: 1.25rem;">
        <h2 style="color: #004ac6; font-size: 1.35rem; font-weight: 800; margin: 0; letter-spacing: 0.5px;">COACHING CENTER MANAGEMENT</h2>
        <p style="font-size: 0.8rem; color: #64748b; margin: 3px 0 0 0;">Admission & Academic Care • Institutional Accounts Ledger</p>
        <div style="margin-top: 6px;">
          <span style="display: inline-block; background: #16a34a; color: #ffffff; font-size: 0.75rem; font-weight: 700; padding: 3px 12px; border-radius: 9999px; letter-spacing: 0.5px;">
            MONTHLY PAYMENT VOUCHER
          </span>
        </div>
      </div>

      <!-- Monthly Metadata Row -->
      <div style="display: flex; justify-content: space-between; align-items: center; background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 6px; padding: 0.6rem 1rem; margin-bottom: 1.25rem; font-size: 0.83rem; flex-wrap: wrap; gap: 0.5rem;">
        <div>
          <span style="color: #64748b;">Month / Year:</span>
          <strong style="color: #0f172a; margin-left: 4px; font-size: 0.95rem;">${monthName} ${year}</strong>
        </div>
        <div>
          <span style="color: #64748b;">Calendar Days:</span>
          <strong style="color: #004ac6; margin-left: 4px;">${totalDays} Days</strong>
        </div>
        <div>
          <span style="color: #64748b;">Generated:</span>
          <span style="color: #334155; margin-left: 4px;">${new Date().toLocaleDateString()} ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
        </div>
      </div>

      <!-- Complete Month Collection Table -->
      <table style="width: 100%; border-collapse: collapse; font-size: 0.82rem; border: 1px solid #cbd5e1; margin-bottom: 1rem;">
        <thead>
          <tr style="background: #f1f5f9; border-bottom: 2px solid #cbd5e1; text-align: left;">
            <th style="padding: 8px 10px; width: 140px; color: #475569;">Calendar Date</th>
            <th style="padding: 8px 10px; color: #475569;">Collection Summary</th>
            <th style="padding: 8px 10px; width: 110px; text-align: center; color: #475569;">Receipts</th>
            <th style="padding: 8px 10px; width: 140px; text-align: right; color: #475569;">Amount Inflow</th>
          </tr>
        </thead>
        <tbody>
          ${rowsHtml}
        </tbody>
        <tfoot>
          <tr style="background: #f8fafc; border-top: 2px solid #cbd5e1; font-weight: 700;">
            <td style="padding: 10px; color: #1e293b;">${totalDays} Days</td>
            <td style="padding: 10px; color: #64748b; font-size: 0.8rem;">Month of ${monthName} ${year} (${daysWithPayments} collection days)</td>
            <td style="padding: 10px; text-align: center; color: #1e293b;">${payload.totalPaymentCount !== undefined ? payload.totalPaymentCount : daysWithPayments}</td>
            <td style="padding: 10px; text-align: right; color: #16a34a; font-size: 1.05rem;">
              ${formatCurrency(totalPayments)}
            </td>
          </tr>
        </tfoot>
      </table>

      <!-- Grand Total Section -->
      <div style="background: #f8fafc; border: 2px solid #cbd5e1; border-radius: 8px; padding: 0.85rem 1.25rem; display: flex; justify-content: space-between; align-items: center; margin-top: 1.5rem; margin-bottom: 2rem;">
        <span style="font-weight: 800; font-size: 0.95rem; color: #1e293b;">GRAND TOTAL COLLECTIONS (${monthName.toUpperCase()} ${year}):</span>
        <span style="font-weight: 800; font-size: 1.35rem; color: #16a34a;">
          ${formatCurrency(totalPayments)}
        </span>
      </div>

      <!-- Official Signatures Block -->
      <div style="display: flex; justify-content: space-between; margin-top: 3rem; font-size: 0.75rem; color: #64748b; padding-top: 1rem; border-top: 1px dashed #cbd5e1;">
        <div style="text-align: center; width: 140px;">
          <div style="border-bottom: 1px solid #94a3b8; height: 35px;"></div>
          <div style="margin-top: 5px; font-weight: 500;">Prepared By</div>
        </div>
        <div style="text-align: center; width: 140px;">
          <div style="border-bottom: 1px solid #94a3b8; height: 35px;"></div>
          <div style="margin-top: 5px; font-weight: 500;">Accountant / Auditor</div>
        </div>
        <div style="text-align: center; width: 150px;">
          <div style="border-bottom: 1px solid #94a3b8; height: 35px;"></div>
          <div style="margin-top: 5px; font-weight: 600; color: #004ac6;">Authorized Signature</div>
        </div>
      </div>
    </div>
  `;
}

// Make accessible to global window scope for inline onclick triggers
window.openDailyVoucherModal = openDailyVoucherModal;
window.fetchAndRenderDailyVoucher = fetchAndRenderDailyVoucher;
window.openMonthlyVoucherModal = openMonthlyVoucherModal;
window.fetchAndRenderMonthlyVoucher = fetchAndRenderMonthlyVoucher;
window.printVoucherContent = printVoucherContent;

// Dedicated payment-page voucher entry points
window.openPaymentDailyVoucherModal = openPaymentDailyVoucherModal;
window.fetchAndRenderPaymentDailyVoucher = fetchAndRenderPaymentDailyVoucher;
window.openPaymentMonthlyVoucherModal = openPaymentMonthlyVoucherModal;
window.fetchAndRenderPaymentMonthlyVoucher = fetchAndRenderPaymentMonthlyVoucher;

// Global topbar & sidebar search listener, responsive mobile menu, dynamic dates
document.addEventListener('DOMContentLoaded', async () => {
  initDynamicDates();
  await ensureAcademicYearContext();
  initSidebarControls();

  const searchInput = document.querySelector('.topbar-search input');
  if (searchInput) {
    searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const val = searchInput.value.trim();
        if (val) {
          window.location.href = `students.html?search=${encodeURIComponent(val)}`;
        }
      }
    });
  }

  // Setup mobile navigation drawer and backdrop
  setupMobileNavigation();
});

// PWA Service Worker Registration
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').then((reg) => {
      console.log('[PWA] Service Worker registered with scope:', reg.scope);
    }).catch((err) => {
      console.warn('[PWA] Service Worker registration failed:', err);
    });
  });
}

function setupMobileNavigation() {
  const container = document.querySelector('.app-container');
  const sidebar = document.querySelector('.app-sidebar');
  const topbar = document.querySelector('.app-topbar');

  if (!container || !sidebar || !topbar) return;

  // Ensure backdrop exists
  let backdrop = document.querySelector('.sidebar-backdrop');
  if (!backdrop) {
    backdrop = document.createElement('div');
    backdrop.className = 'sidebar-backdrop';
    container.appendChild(backdrop);
  }

  // Ensure mobile toggle button exists in topbar
  let mobileBtn = document.querySelector('.mobile-menu-btn');
  if (!mobileBtn) {
    mobileBtn = document.createElement('button');
    mobileBtn.className = 'mobile-menu-btn';
    mobileBtn.setAttribute('aria-label', 'Toggle Navigation Menu');
    mobileBtn.innerHTML = '<span class="material-symbols-outlined">menu</span>';

    // Insert at beginning of topbar
    if (topbar.firstChild) {
      topbar.insertBefore(mobileBtn, topbar.firstChild);
    } else {
      topbar.appendChild(mobileBtn);
    }
  }

  const toggleSidebar = (open) => {
    const shouldOpen = open !== undefined ? open : !sidebar.classList.contains('open');
    if (shouldOpen) {
      sidebar.classList.add('open');
      backdrop.classList.add('active');
      document.body.style.overflow = 'hidden';
    } else {
      sidebar.classList.remove('open');
      backdrop.classList.remove('active');
      document.body.style.overflow = '';
    }
  };

  mobileBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleSidebar();
  });

  backdrop.addEventListener('click', () => {
    toggleSidebar(false);
  });

  // Close when clicking nav links on mobile
  const navLinks = sidebar.querySelectorAll('.nav-link');
  navLinks.forEach(link => {
    link.addEventListener('click', () => {
      if (window.innerWidth <= 1024) {
        toggleSidebar(false);
      }
    });
  });

  // Close on Escape key
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && sidebar.classList.contains('open')) {
      toggleSidebar(false);
    }
  });

  // Auto-close on resize to desktop
  window.addEventListener('resize', () => {
    if (window.innerWidth > 1024 && sidebar.classList.contains('open')) {
      toggleSidebar(false);
    }
  });
}

// Sync Super Admin nav link and user profile / logout across all pages
if (typeof document !== 'undefined') {
  document.addEventListener('DOMContentLoaded', async () => {
    try {
      if (window.authReady) {
        const state = await window.authReady;
        if (state) {
          if (state.role === 'staff') {
            document.querySelectorAll('a[href="examinations.html"], a[href="result-cards.html"]').forEach(el => {
              el.style.display = 'none';
            });
          }

          if (state.role === 'super_admin') {
            let adminLink = document.getElementById('nav-admin-link');
            if (adminLink) {
              adminLink.style.display = 'flex';
            } else {
              const nav = document.querySelector('.sidebar-nav');
              if (nav && !document.getElementById('nav-admin-link')) {
                const link = document.createElement('a');
                link.href = 'admin.html';
                link.className = 'nav-link' + (window.location.pathname.includes('admin') ? ' active' : '');
                link.id = 'nav-admin-link';
                link.style.display = 'flex';
                link.style.color = '#2563eb';
                link.style.fontWeight = '700';
                link.innerHTML = `
                  <span class="material-symbols-outlined">admin_panel_settings</span>
                  Admin Panel
                `;
                nav.appendChild(link);
              }
            }
          }

          // Populate user info & add logout button if missing
          const profileEl = document.querySelector('.user-profile');
          if (profileEl) {
            const email = state.user?.email || '';
            const fullName = state.user?.user_metadata?.full_name || state.user?.user_metadata?.name || email.split('@')[0] || 'User';
            const roleLabel = state.role === 'super_admin' ? 'Super Admin' : 'Staff Member';
            const initials = fullName.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2) || 'US';

            const avatarEl = profileEl.querySelector('.user-avatar');
            if (avatarEl) avatarEl.textContent = initials;

            const nameEl = profileEl.querySelector('.user-name');
            if (nameEl) nameEl.textContent = fullName;

            const roleEl = profileEl.querySelector('.user-role');
            if (roleEl) roleEl.textContent = roleLabel;

            // Check if logout button already exists nearby or inside profile
            // Skip global auto-inject logout button on admin.html since admin.html has its own explicit logout button (#adminLogoutBtn)
            if (!window.location.pathname.includes('admin')) {
              let logoutBtn = document.getElementById('globalUserLogoutBtn');
              if (!logoutBtn && profileEl.parentElement) {
                logoutBtn = document.createElement('button');
                logoutBtn.id = 'globalUserLogoutBtn';
                logoutBtn.className = 'btn btn-secondary btn-sm';
                logoutBtn.style.marginLeft = '0.50rem';
                logoutBtn.style.padding = '0.35rem 0.65rem';
                logoutBtn.style.display = 'inline-flex';
                logoutBtn.style.alignItems = 'center';
                logoutBtn.style.gap = '0.25rem';
                logoutBtn.style.fontSize = '0.78rem';
                logoutBtn.title = 'Log out';
                logoutBtn.innerHTML = `
                  <span class="material-symbols-outlined" style="font-size: 1rem;">logout</span>
                  <span>Logout</span>
                `;
                logoutBtn.addEventListener('click', async () => {
                  if (window.confirm('Are you sure you want to log out?')) {
                    if (window.auth && typeof window.auth.signOut === 'function') {
                      await window.auth.signOut();
                    } else {
                      window.location.replace('login.html');
                    }
                  }
                });
                profileEl.parentElement.appendChild(logoutBtn);
              }
            }
          }
        }
      }
    } catch (e) { }
  });
}