/**
 * Attendance Dashboard
 * History view, monthly summary, admin entry, bulk import
 */

let attendanceData = [];
let attendanceSummary = null;

/**
 * Load and display attendance dashboard
 */
async function loadAttendanceDashboard(studentId) {
  try {
    // Load attendance data
    const response = await portalFetch('get_attendance_summary', { student_id: studentId });
    if (response.result !== 'success') {
      console.error('Failed to load attendance:', response.message);
      return;
    }

    attendanceData = response.data || [];
    attendanceSummary = response.summary || {};

    // Render sections
    renderAttendanceSummary();
    renderAttendanceHistory();
  } catch (err) {
    console.error('Load attendance error:', err);
  }
}

/**
 * Render monthly summary cards
 */
function renderAttendanceSummary() {
  const container = document.getElementById('attendance-summary-container');
  if (!container || !attendanceSummary) return;

  const { total_days, present, absent, late, percentage } = attendanceSummary;

  const getColor = (pct) => {
    if (pct >= 90) return '#059669'; // Green
    if (pct >= 75) return '#f59e0b'; // Amber
    return '#ef4444'; // Red
  };

  container.innerHTML = `
    <div class="row g-3 mb-4">
      <!-- Attendance % Card -->
      <div class="col-md-6 col-lg-3">
        <div class="attendance-stat-card">
          <div class="attendance-stat-circle" style="background: ${getColor(percentage)};">
            <div class="attendance-stat-value">${percentage}%</div>
          </div>
          <div class="attendance-stat-label">Attendance</div>
          <div class="attendance-stat-detail">${percentage >= 75 ? '✓ Good' : '⚠ Needs Improvement'}</div>
        </div>
      </div>

      <!-- Present Card -->
      <div class="col-md-6 col-lg-3">
        <div class="attendance-stat-card">
          <div class="attendance-stat-icon" style="background: rgba(16, 185, 129, 0.1); color: #059669;">
            <i class="bi bi-check-circle-fill"></i>
          </div>
          <div class="attendance-stat-value">${present}</div>
          <div class="attendance-stat-label">Present</div>
        </div>
      </div>

      <!-- Late Card -->
      <div class="col-md-6 col-lg-3">
        <div class="attendance-stat-card">
          <div class="attendance-stat-icon" style="background: rgba(245, 158, 11, 0.1); color: #f59e0b;">
            <i class="bi bi-clock-fill"></i>
          </div>
          <div class="attendance-stat-value">${late}</div>
          <div class="attendance-stat-label">Late</div>
        </div>
      </div>

      <!-- Absent Card -->
      <div class="col-md-6 col-lg-3">
        <div class="attendance-stat-card">
          <div class="attendance-stat-icon" style="background: rgba(239, 68, 68, 0.1); color: #ef4444;">
            <i class="bi bi-x-circle-fill"></i>
          </div>
          <div class="attendance-stat-value">${absent}</div>
          <div class="attendance-stat-label">Absent</div>
        </div>
      </div>

      <!-- Total Days Card -->
      <div class="col-md-6 col-lg-3">
        <div class="attendance-stat-card">
          <div class="attendance-stat-icon" style="background: rgba(99, 102, 241, 0.1); color: #6366f1;">
            <i class="bi bi-calendar-event-fill"></i>
          </div>
          <div class="attendance-stat-value">${total_days}</div>
          <div class="attendance-stat-label">Total Days</div>
        </div>
      </div>
    </div>
  `;
}

/**
 * Render attendance history table
 */
function renderAttendanceHistory() {
  const container = document.getElementById('attendance-history-container');
  if (!container) return;

  if (attendanceData.length === 0) {
    container.innerHTML = '<p class="text-center text-muted py-4">No attendance records yet.</p>';
    return;
  }

  const fmtTime = t => t ? new Date(`2000-01-01 ${t}`).toLocaleTimeString('en-BD', { hour: '2-digit', minute: '2-digit' }) : '—';

  const rows = attendanceData.map(record => {
    const date = new Date(record.date);
    const dateStr = date.toLocaleDateString('en-BD', { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' });
    const statusBadge = {
      present: '<span class="badge bg-success">Present</span>',
      absent: '<span class="badge bg-danger">Absent</span>',
      late: '<span class="badge bg-warning">Late</span>',
      leave: '<span class="badge bg-info">Leave</span>',
    }[record.status] || '<span class="badge bg-secondary">Unknown</span>';

    const passLines = (record.pass_events || []).map(p =>
      `<div class="small text-muted"><i class="bi bi-arrow-left-right"></i> out ${fmtTime(p.out)} &rarr; in ${p.in ? fmtTime(p.in) : '<span class="text-warning">not back yet</span>'}</div>`
    ).join('');

    return `
      <tr>
        <td><strong>${dateStr}</strong></td>
        <td>${fmtTime(record.entry_time)}</td>
        <td>${fmtTime(record.exit_time)}</td>
        <td>${statusBadge}</td>
        <td>${passLines || '<span class="text-muted small">—</span>'}</td>
      </tr>
    `;
  }).join('');

  container.innerHTML = `
    <div class="table-responsive">
      <table class="table table-hover">
        <thead class="table-light">
          <tr>
            <th>Date</th>
            <th>Entry Time</th>
            <th>Exit Time</th>
            <th>Status</th>
            <th>Mid-day Pass</th>
          </tr>
        </thead>
        <tbody>
          ${rows}
        </tbody>
      </table>
    </div>
  `;
}

/**
 * Show admin manual entry form
 */
function showManualAttendanceForm() {
  const modal = document.createElement('div');
  modal.className = 'modal fade';
  modal.id = 'manual-attendance-modal';
  modal.setAttribute('tabindex', '-1');
  modal.innerHTML = `
    <div class="modal-dialog">
      <div class="modal-content">
        <div class="modal-header bg-primary text-white">
          <h5 class="modal-title">Record Attendance</h5>
          <button type="button" class="btn-close btn-close-white" data-bs-dismiss="modal"></button>
        </div>
        <div class="modal-body">
          <form id="manual-attendance-form">
            <div class="mb-3">
              <label class="form-label fw-600">Student ID *</label>
              <input type="text" class="form-control" id="ma-student-id" placeholder="e.g., 2031122001" required />
            </div>

            <div class="row">
              <div class="col-md-6 mb-3">
                <label class="form-label fw-600">Date *</label>
                <input type="date" class="form-control" id="ma-date" required />
              </div>
              <div class="col-md-6 mb-3">
                <label class="form-label fw-600">Status</label>
                <select class="form-select" id="ma-status">
                  <option value="present">Present</option>
                  <option value="late">Late</option>
                  <option value="absent">Absent</option>
                  <option value="leave">Leave</option>
                </select>
              </div>
            </div>

            <p class="small text-muted mb-3">Entry/exit times aren't set here — those come from the NFC gate hardware automatically. This is a correction on top of that (or a plain manual mark, if the hardware has no record for the day).</p>

            <div class="mb-3">
              <label class="form-label fw-600">Reason</label>
              <textarea class="form-control" id="ma-reason" rows="2" placeholder="Optional — why this correction"></textarea>
            </div>
          </form>
        </div>
        <div class="modal-footer">
          <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">Cancel</button>
          <button type="button" class="btn btn-primary" id="save-manual-attendance-btn">Save Record</button>
        </div>
      </div>
    </div>
  `;

  document.body.appendChild(modal);
  const bsModal = new bootstrap.Modal(modal);

  // Set today's date as default
  const today = new Date().toISOString().split('T')[0];
  document.getElementById('ma-date').value = today;

  // Save handler
  document.getElementById('save-manual-attendance-btn').onclick = async () => {
    const studentId = document.getElementById('ma-student-id').value.trim();
    const date = document.getElementById('ma-date').value;
    const status = document.getElementById('ma-status').value;
    const reason = document.getElementById('ma-reason').value;

    if (!studentId || !date) {
      alert('Student ID and date are required.');
      return;
    }

    try {
      const response = await portalFetch('manual_attendance_entry', {
        student_id: studentId,
        date,
        status,
        reason,
      });

      if (response.result === 'success') {
        alert('Attendance recorded successfully!');
        bsModal.hide();
      } else {
        alert('Error: ' + response.message);
      }
    } catch (err) {
      alert('Failed to save: ' + err.message);
    }
  };

  bsModal.show();
  modal.addEventListener('hidden.bs.modal', () => modal.remove());
}

/**
 * Show bulk import form
 */
function showBulkAttendanceImport() {
  const modal = document.createElement('div');
  modal.className = 'modal fade';
  modal.id = 'bulk-attendance-modal';
  modal.setAttribute('tabindex', '-1');
  modal.innerHTML = `
    <div class="modal-dialog modal-lg">
      <div class="modal-content">
        <div class="modal-header bg-primary text-white">
          <h5 class="modal-title">Bulk Import Attendance</h5>
          <button type="button" class="btn-close btn-close-white" data-bs-dismiss="modal"></button>
        </div>
        <div class="modal-body">
          <div class="alert alert-info mb-3">
            <strong>CSV Format:</strong> student_id, date, status, reason<br/>
            <strong>Example:</strong> 2031122001, 2026-06-30, leave, Sick leave — doctor's note on file<br/>
            <small>This corrects/overrides the hardware-recorded day (or marks one manually if the hardware has no record) — it doesn't set entry/exit times, those only ever come from the NFC gate.</small>
          </div>
          <textarea id="bulk-import-csv" class="form-control" rows="6" placeholder="Paste CSV data here..."></textarea>
        </div>
        <div class="modal-footer">
          <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">Cancel</button>
          <button type="button" class="btn btn-primary" id="import-bulk-attendance-btn">Import</button>
        </div>
      </div>
    </div>
  `;

  document.body.appendChild(modal);
  const bsModal = new bootstrap.Modal(modal);

  document.getElementById('import-bulk-attendance-btn').onclick = async () => {
    const csvData = document.getElementById('bulk-import-csv').value.trim();
    if (!csvData) {
      alert('Please paste CSV data.');
      return;
    }

    try {
      // Parse CSV
      const lines = csvData.split('\n').filter(l => l.trim());
      const records = lines.map(line => {
        const [student_id, date, status, ...rest] = line.split(',').map(s => s.trim());
        return { student_id, date, status, reason: rest.join(',') };
      });

      const response = await portalFetch('bulk_attendance_import', { records });
      if (response.result === 'success') {
        alert(`Success!\nInserted: ${response.details.inserted}\nUpdated: ${response.details.updated}\nSkipped: ${response.details.skipped}`);
        bsModal.hide();
      } else {
        alert('Error: ' + response.message);
      }
    } catch (err) {
      alert('Import failed: ' + err.message);
    }
  };

  bsModal.show();
  modal.addEventListener('hidden.bs.modal', () => modal.remove());
}

/**
 * Export attendance as CSV
 */
function exportAttendanceData(studentId) {
  if (attendanceData.length === 0) {
    alert('No attendance data to export.');
    return;
  }

  const headers = ['Date', 'Entry Time', 'Exit Time', 'Status', 'Pass Events'];
  const rows = attendanceData.map(r => [
    r.date,
    r.entry_time || '—',
    r.exit_time || '—',
    r.status,
    (r.pass_events || []).map(p => `out ${p.out || '—'} / in ${p.in || 'not back yet'}`).join('; '),
  ]);

  const csv = [
    headers,
    ...rows.map(row => row.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(',')),
  ].join('\n');

  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `attendance-${studentId}-${new Date().toISOString().split('T')[0]}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

// Export for global use
window.AttendanceDashboard = {
  loadAttendanceDashboard,
  showManualAttendanceForm,
  showBulkAttendanceImport,
  exportAttendanceData,
};
