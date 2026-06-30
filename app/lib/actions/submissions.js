/**
 * Submission Action Handlers
 * Modular handlers for all submission-related API actions
 */

import * as schema from '../portal-schema.js';

const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_KEY;

async function sb(path, method = 'GET', body = null) {
  const res = await fetch(`${SB_URL}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: SB_KEY,
      Authorization: `Bearer ${SB_KEY}`,
      'Content-Type': 'application/json',
      Prefer: method === 'POST' ? 'return=representation' : 'return=minimal',
      'Accept-Profile': 'student',
      'Content-Profile': 'student',
    },
    ...(body !== null ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  if (!res.ok) return { error: text };
  return text ? JSON.parse(text) : [];
}

/**
 * Submit form data for a student tab
 * Handles validation, locking, and queuing
 */
export async function handleSubmit(studentId, tabName, formData, tabs = []) {
  try {
    // Find tab config
    const tab = tabs.find(t => t.tab_name === tabName);
    if (!tab) {
      return { result: 'error', message: 'Tab not found' };
    }

    // Parse fields and validate
    const fields = schema.parseTabFields(tab.fields_json);
    const validation = schema.validateSubmissionData(fields, formData);
    if (!validation.valid) {
      return { result: 'error', message: 'Validation failed', errors: validation.errors };
    }

    // Check if tab is locked for this student
    const existing = await sb(
      `portal_submissions?student_id=eq.${encodeURIComponent(studentId)}&tab_name=eq.${encodeURIComponent(tabName)}`
    );

    if (existing && !existing.error && existing[0]?.editable === 'NO') {
      return { result: 'error', message: 'This form is locked and cannot be edited' };
    }

    // Determine editable state
    const defaultEditable = tab.default_editable === 'YES' || tab.default_editable === true;
    const editable = existing && !existing.error && existing[0]
      ? existing[0].editable
      : (defaultEditable ? 'YES' : 'NO');

    // Clean data (remove non-field keys)
    const cleanData = {};
    for (const field of fields) {
      if (field.type !== 'group_label' && formData.hasOwnProperty(field.name)) {
        cleanData[field.name] = formData[field.name];
      }
    }

    // Upsert submission
    if (existing && !existing.error && existing.length > 0) {
      // Update existing
      await sb(
        `portal_submissions?student_id=eq.${encodeURIComponent(studentId)}&tab_name=eq.${encodeURIComponent(tabName)}`,
        'PATCH',
        {
          data: cleanData,
          editable,
          updated_at: new Date().toISOString(),
        }
      );
    } else {
      // Create new
      await sb('portal_submissions', 'POST', {
        student_id: studentId,
        tab_name: tabName,
        data: cleanData,
        editable,
        submitted_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
    }

    return { result: 'success', message: 'Form submitted successfully' };
  } catch (err) {
    console.error('handleSubmit error:', err);
    return { result: 'error', message: 'Submission failed: ' + err.message };
  }
}

/**
 * Get submission for a student+tab combination
 */
export async function handleGetStudentTabData(studentId, tabName) {
  try {
    const rows = await sb(
      `portal_submissions?student_id=eq.${encodeURIComponent(studentId)}&tab_name=eq.${encodeURIComponent(tabName)}`
    );

    if (rows && !rows.error && rows.length > 0) {
      const row = rows[0];
      return {
        ...row.data,
        editable: row.editable,
        student_id: studentId,
        submitted_at: row.submitted_at,
        updated_at: row.updated_at,
      };
    }

    return null; // No submission yet
  } catch (err) {
    console.error('handleGetStudentTabData error:', err);
    return null;
  }
}

/**
 * Get all submissions for a specific tab (admin view)
 * Returns headers + data grid for spreadsheet-like export
 */
export async function handleGetTabData(tabName) {
  try {
    const rows = await sb(
      `portal_submissions?tab_name=eq.${encodeURIComponent(tabName)}&order=submitted_at.asc`
    );

    if (rows.error || !rows.length) {
      return { headers: ['student_id'], rows: [] };
    }

    // Collect all unique keys from all submissions
    const allKeys = new Set(['student_id']);
    rows.forEach(r => {
      Object.keys(r.data || {}).forEach(k => allKeys.add(k));
    });

    const headers = Array.from(allKeys);
    const dataRows = rows.map(r =>
      headers.map(h => (h === 'student_id' ? r.student_id : r.data?.[h] ?? ''))
    );

    return { headers, rows: dataRows };
  } catch (err) {
    console.error('handleGetTabData error:', err);
    return { headers: ['student_id'], rows: [] };
  }
}

/**
 * Get submission history for a student across all tabs
 */
export async function handleGetSubmissionHistory(studentId, limit = 50, offset = 0) {
  try {
    const rows = await sb(
      `portal_submissions?student_id=eq.${encodeURIComponent(studentId)}&order=updated_at.desc&limit=${limit}&offset=${offset}`
    );

    if (rows.error) return [];

    return rows.map(r => ({
      tab_name: r.tab_name,
      data: r.data,
      editable: r.editable,
      submitted_at: r.submitted_at,
      updated_at: r.updated_at,
    }));
  } catch (err) {
    console.error('handleGetSubmissionHistory error:', err);
    return [];
  }
}

/**
 * Lock or unlock a submission for a student
 */
export async function handleToggleSubmissionLock(studentId, tabName, shouldLock) {
  try {
    await sb(
      `portal_submissions?student_id=eq.${encodeURIComponent(studentId)}&tab_name=eq.${encodeURIComponent(tabName)}`,
      'PATCH',
      {
        editable: shouldLock ? 'NO' : 'YES',
      }
    );

    return {
      result: 'success',
      message: shouldLock ? 'Form locked' : 'Form unlocked',
    };
  } catch (err) {
    console.error('handleToggleSubmissionLock error:', err);
    return { result: 'error', message: err.message };
  }
}

/**
 * Delete a submission
 */
export async function handleDeleteSubmission(studentId, tabName) {
  try {
    await sb(
      `portal_submissions?student_id=eq.${encodeURIComponent(studentId)}&tab_name=eq.${encodeURIComponent(tabName)}`,
      'DELETE'
    );

    return { result: 'success', message: 'Submission deleted' };
  } catch (err) {
    console.error('handleDeleteSubmission error:', err);
    return { result: 'error', message: err.message };
  }
}

/**
 * Export tab submissions as CSV
 */
export async function handleExportTabData(tabName, format = 'csv') {
  try {
    const { headers, rows } = await handleGetTabData(tabName);

    if (format === 'json') {
      return {
        result: 'success',
        data: {
          tab_name: tabName,
          exported_at: new Date().toISOString(),
          records: rows.map(row =>
            Object.fromEntries(headers.map((h, i) => [h, row[i]]))
          ),
        },
      };
    }

    // CSV format
    const csvContent = [
      headers.join(','),
      ...rows.map(row =>
        row.map(cell => {
          const str = String(cell);
          return str.includes(',') || str.includes('"')
            ? `"${str.replace(/"/g, '""')}"`
            : str;
        }).join(',')
      ),
    ].join('\n');

    return {
      result: 'success',
      data: csvContent,
      filename: `${tabName}_submissions_${new Date().toISOString().split('T')[0]}.csv`,
    };
  } catch (err) {
    console.error('handleExportTabData error:', err);
    return { result: 'error', message: err.message };
  }
}

export default {
  handleSubmit,
  handleGetStudentTabData,
  handleGetTabData,
  handleGetSubmissionHistory,
  handleToggleSubmissionLock,
  handleDeleteSubmission,
  handleExportTabData,
};
